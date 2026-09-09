import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const ENCODE = join(ROOT, 'scripts/session-encode.mjs')
const DECODE = join(ROOT, 'scripts/session-decode.mjs')

const run = (args: string[]): string =>
  execFileSync(process.execPath, args, { encoding: 'utf8' }).toString()

const HEADER = JSON.stringify({ type: 'session', version: 1, createdAt: 1, id: 's' })
const U1 = JSON.stringify({ type: 'user/message', seq: 0, time: 1, data: { role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' }, id: 'u1' } })
const MARKER = JSON.stringify({
  type: 'user/message', seq: 1, time: 2,
  data: { role: 'user', content: [], source: { kind: 'plugin', plugin: 'dsh-rewind' }, id: 'm1' },
  surfaceOp: { op: 'replace', start: 0, end: 0 },
  sourceEventSeqs: [0],
})

describe('session-encode CLI (single-file .jsonl.zstd codec)', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'session-encode-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('compresses plaintext to a 2-frame .jsonl.zstd that decodes back verbatim', async () => {
    const plain = `${HEADER}\n${U1}\n${MARKER}\n`
    const inFile = join(dir, 'in.jsonl')
    const zstd = join(dir, 'out.jsonl.zstd')
    await writeFile(inFile, plain)
    run([ENCODE, inFile, '-o', zstd])

    const decoded = run([DECODE, zstd])
    expect(decoded).toBe(plain)
  })

  it('--fix-empty-marker rewrites only the empty form-C marker content', async () => {
    const plain = `${HEADER}\n${U1}\n${MARKER}\n`
    const inFile = join(dir, 'in.jsonl')
    const zstd = join(dir, 'out.jsonl.zstd')
    const fixed = join(dir, 'fixed.jsonl.zstd')
    await writeFile(inFile, plain)
    run([ENCODE, inFile, '-o', zstd])
    run([ENCODE, '--fix-empty-marker', zstd, '-o', fixed])

    const decoded = run([DECODE, fixed])
    const lines = decoded.split('\n').filter(Boolean)
    const marker = lines.find((l) => l.includes('"plugin":"dsh-rewind"'))
    expect(marker).toBeDefined()
    const rec = JSON.parse(marker!)
    expect(rec.data.content).toEqual([{ type: 'text', text: '(empty message)' }])
    expect(rec.surfaceOp).toEqual({ op: 'replace', start: 0, end: 0 })
    expect(rec.sourceEventSeqs).toEqual([0])
    // The ordinary user message is untouched.
    const u1 = lines.find((l) => l.includes('"kind":"user"'))
    expect(JSON.parse(u1!).data.content).toEqual([{ type: 'text', text: 'hi' }])
  })

  it('--verify reports a stable round-trip and a 2-frame container', async () => {
    const plain = `${HEADER}\n${U1}\n${MARKER}\n`
    const inFile = join(dir, 'in.jsonl')
    const zstd = join(dir, 'out.jsonl.zstd')
    await writeFile(inFile, plain)
    run([ENCODE, inFile, '-o', zstd])
    const out = run([ENCODE, '--verify', zstd])
    expect(out).toMatch(/2 frame\(s\) \| round-trip stable/)
  })

  it('does not touch a marker already in the (empty message) form', async () => {
    const plain = `${HEADER}\n${U1}\n${MARKER.replace('"content":[]', '"content":[{"type":"text","text":"(empty message)"}]')}\n`
    const inFile = join(dir, 'in.jsonl')
    const zstd = join(dir, 'out.jsonl.zstd')
    const fixed = join(dir, 'fixed.jsonl.zstd')
    await writeFile(inFile, plain)
    run([ENCODE, inFile, '-o', zstd])
    run([ENCODE, '--fix-empty-marker', zstd, '-o', fixed])
    const decoded = run([DECODE, fixed])
    const marker = decoded.split('\n').find((l) => l.includes('"plugin":"dsh-rewind"'))
    expect(JSON.parse(marker!).data.content).toEqual([{ type: 'text', text: '(empty message)' }])
  })
})
