import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const ENCODE = join(ROOT, 'scripts/session-encode.mjs')
const DECODE = join(ROOT, 'scripts/session-decode.mjs')

const run = (args: string[]): string => execFileSync(process.execPath, args, { encoding: 'utf8' }).toString()

describe('session codec (decompress + compress)', () => {
  it('compress then decompress returns the identical plaintext', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'session-codec-'))
    try {
      const plain = '{"type":"session","version":1,"createdAt":1,"id":"s"}\n{"type":"user/message","seq":0,"time":1,"data":{"role":"user","content":[],"source":{"kind":"plugin","plugin":"dsh-rewind"},"id":"m1"},"surfaceOp":{"op":"replace","start":0,"end":0},"sourceEventSeqs":[0]}\n'
      const inFile = join(dir, 'in.jsonl')
      const zstd = join(dir, 'out.jsonl.zstd')
      await writeFile(inFile, plain)
      run([ENCODE, inFile, '-o', zstd])
      expect(run([DECODE, zstd])).toBe(plain)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
