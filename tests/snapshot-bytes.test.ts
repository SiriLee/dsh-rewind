/**
 * Byte-fidelity tests for the checkpoint store (src/snapshot.ts): before-bytes
 * are staged and stored as RAW COPIES (`copyFile` into `.pending/`, then a
 * `.before` sidecar next to the entry), never through a decoded string, so a
 * binary or non-UTF-8 file round-trips byte-exactly.
 *
 * The cases below are the failure modes that motivated the byte format:
 * GBK/UTF-16 text saved by an editor, build and codegen artifacts, PNG/JPEG
 * images, NUL bytes, CRLF, empty files and large files — plus the integrity
 * rules that must hold when a sidecar is missing or a dedup handle goes stale.
 */
import { mkdtemp, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultProbe, isLinkEntry, SnapshotStore } from '../src/snapshot.ts'

let root: string
let store: SnapshotStore
const session = 'session-bytes'

const unlink = async (path: string): Promise<void> => {
  await rm(path, { force: true })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-rewind-bytes-'))
  store = new SnapshotStore(root)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function touch(rel: string, bytes: Buffer): Promise<string> {
  const abs = join(root, 'ws', rel)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, bytes)
  return abs
}

/**
 * Capture one file exactly the way the host does: stage a raw copy into
 * `.pending/` through the probe, then commit it under its anchor.
 */
async function captureAndRecord(
  callId: string,
  anchorSeq: number,
  live: string,
): Promise<void> {
  const staged = await store.stageCapture(session, callId)
  const copied = await defaultProbe.copy(live, staged)
  if (copied.kind === 'failed') throw new Error(copied.message)
  await store.recordBackup(session, { callId, anchorSeq, path: live },
    copied.kind === 'absent' ? null : { file: staged, size: copied.size })
}

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const ROUND_TRIP_CASES: ReadonlyArray<readonly [string, Buffer]> = [
  ['random binary', randomBytes(4096)],
  ['PNG bytes', Buffer.concat([PNG_MAGIC, randomBytes(2048)])],
  ['GBK text', Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xd2, 0xbb])], // "中文一"
  ['UTF-16LE text', Buffer.concat([UTF8_BOM, Buffer.from('a\u0000b\u0000', 'latin1')])],
  ['embedded NUL', Buffer.from([0x61, 0x00, 0x62, 0xff, 0x00])],
  ['CRLF text', Buffer.from('line1\r\nline2\r\n')],
  ['empty file', Buffer.alloc(0)],
  ['2 MiB binary', randomBytes(1024 * 1024)],
]

describe('byte-exact capture and restore', () => {
  for (const [name, bytes] of ROUND_TRIP_CASES) {
    it(`round-trips ${name} exactly`, async () => {
      const live = await touch(`${name.replaceAll(' ', '-')}.bin`, bytes)
      await captureAndRecord('c1', 5, live)
      await writeFile(live, Buffer.from('clobbered by the edit that follows'))
      // Filler so the entry is not the only file in the anchor group.
      const outcome = await store.restoreAfter(session, 5, unlink)
      expect(outcome.restored).toEqual([live])
      expect(await readFile(live)).toEqual(bytes)
    })
  }

  it('stores an EXISTING empty file as a blob, distinct from "was created"', async () => {
    const live = await touch('empty.txt', Buffer.alloc(0))
    await captureAndRecord('c1', 5, live)
    const [entry] = await store.entriesAfter(session, 5)
    if (entry === undefined || isLinkEntry(entry)) throw new Error('expected a real entry')
    expect(entry.size).toBe(0)
    expect(entry.before?.kind).toBe('blob')
    expect(await readFile((entry.before as { path: string }).path)).toEqual(Buffer.alloc(0))

    // Rewinding recreates the empty file: a creation entry would DELETE it.
    await rm(live, { force: true })
    const outcome = await store.restoreAfter(session, 5, unlink)
    expect(outcome.restored).toEqual([live])
    expect(await readFile(live)).toEqual(Buffer.alloc(0))
  })

  it('records a creation when the file did not exist at capture time', async () => {
    const live = join(root, 'ws', 'brand-new.txt')
    await mkdir(join(root, 'ws'), { recursive: true })
    await captureAndRecord('c1', 6, live)
    await writeFile(live, 'created by the tool call')
    const outcome = await store.restoreAfter(session, 5, unlink)
    expect(outcome.deleted).toEqual([live])
    expect(await store.exists(live)).toBe(false)
  })

  it('keeps the bytes out of the entry JSON (metadata only)', async () => {
    const live = await touch('secret.bin', Buffer.from([0xd6, 0xd0, 0xce, 0xc4]))
    await captureAndRecord('c1', 5, live)
    const names = await readdir(store.anchorDir(session, 5))
    const entryName = names.find(name => name.endsWith('.json'))
    if (entryName === undefined) throw new Error('expected a committed entry')
    const raw = await readFile(join(store.anchorDir(session, 5), entryName), 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    // Metadata only: no inline content field of any shape.
    expect('before' in parsed).toBe(false)
    expect('text' in parsed).toBe(false)
    expect(raw).not.toContain('中')
    expect(parsed).toMatchObject({
      store: 2, callId: 'c1', file: live, blob: entryName.replace(/\.json$/, '.before'), size: 4,
    })
  })
})

describe('dedup on bytes', () => {
  it('links identical bytes and restores through the link', async () => {
    const live = await touch('same.bin', Buffer.from([0x00, 0x01, 0xff]))
    await captureAndRecord('c1', 5, live)
    await captureAndRecord('c2', 6, live) // identical bytes → link
    const entries = await store.entriesAfter(session, 5)
    expect(entries.filter(isLinkEntry)).toHaveLength(1)
    expect(entries.filter(entry => !isLinkEntry(entry))).toHaveLength(1)

    await writeFile(live, Buffer.from([9, 9, 9]))
    const outcome = await store.restoreAfter(session, 6, unlink)
    expect(outcome.restored).toEqual([live])
    expect(await readFile(live)).toEqual(Buffer.from([0x00, 0x01, 0xff]))
  })

  it('does NOT treat same-size different bytes as unchanged', async () => {
    const live = await touch('same-size.bin', Buffer.from('AAAA'))
    await captureAndRecord('c1', 5, live)
    await writeFile(live, Buffer.from('BBBB')) // same length, different bytes
    await captureAndRecord('c2', 6, live)
    const entries = await store.entriesAfter(session, 5)
    expect(entries.filter(isLinkEntry)).toHaveLength(0)
    expect(entries.filter(entry => !isLinkEntry(entry))).toHaveLength(2)
  })
})

describe('integrity rules', () => {
  it('ignores an entry whose blob name does not sit beside it', async () => {
    const live = await touch('a.txt', Buffer.from('x'))
    await mkdir(store.anchorDir(session, 5), { recursive: true })
    await writeFile(join(store.anchorDir(session, 5), 'c1.json'), JSON.stringify({
      store: 2, callId: 'c1', file: live, blob: 'somewhere-else.before', size: 1, time: 1,
    }), 'utf8')
    expect(await store.entriesAfter(session, 5)).toEqual([])
  })

  it('reports a missing sidecar as a per-file failure, never a delete', async () => {
    const live = await touch('gone.bin', Buffer.from([1, 2, 3]))
    await captureAndRecord('c1', 5, live)
    const names = await readdir(store.anchorDir(session, 5))
    const sidecar = names.find(name => name.endsWith('.before'))
    if (sidecar === undefined) throw new Error('expected a staged sidecar')
    await rm(join(store.anchorDir(session, 5), sidecar), { force: true })
    await writeFile(live, Buffer.from([4, 5, 6]))

    const outcome = await store.restoreAfter(session, 5, unlink)
    expect(outcome.deleted).toEqual([])
    expect(outcome.restored).toEqual([])
    expect(outcome.failed.map(failure => failure.path)).toEqual([live])
    expect(await readFile(live)).toEqual(Buffer.from([4, 5, 6]))
  })

  it('reports a sidecar whose size disagrees with its metadata', async () => {
    const live = await touch('short.bin', Buffer.from([1, 2, 3, 4]))
    await captureAndRecord('c1', 5, live)
    const names = await readdir(store.anchorDir(session, 5))
    const sidecar = names.find(name => name.endsWith('.before'))
    if (sidecar === undefined) throw new Error('expected a staged sidecar')
    await writeFile(join(store.anchorDir(session, 5), sidecar), Buffer.from([1, 2]))

    const outcome = await store.restoreAfter(session, 5, unlink)
    expect(outcome.failed.map(failure => failure.message)).toEqual([
      expect.stringContaining('size mismatch'),
    ])
    expect(await readFile(live)).toEqual(Buffer.from([1, 2, 3, 4]))
  })

  it('keeps entries for call ids that sanitize to the same file name', async () => {
    const one = await touch('one.bin', Buffer.from('one'))
    const two = await touch('two.bin', Buffer.from('two'))
    // `safeFileId` maps both of these onto `a_b`; the digest in the file name
    // keeps the two entries (and their sidecars) apart.
    await captureAndRecord('a:b', 5, one)
    await captureAndRecord('a_b', 5, two)
    const names = await readdir(store.anchorDir(session, 5))
    expect(names.filter(name => name.endsWith('.json'))).toHaveLength(2)
    expect(names.filter(name => name.endsWith('.before'))).toHaveLength(2)

    await writeFile(one, Buffer.from('x'))
    await writeFile(two, Buffer.from('y'))
    const outcome = await store.restoreAfter(session, 5, unlink)
    expect([...outcome.restored].sort()).toEqual([one, two].sort())
    expect(await readFile(one, 'utf8')).toBe('one')
    expect(await readFile(two, 'utf8')).toBe('two')
  })

  it('reads pre-digest entry file names next to new ones', async () => {
    const a = await touch('a-oldname.bin', Buffer.from('A'))
    const b = await touch('b-newname.bin', Buffer.from('B'))
    // An entry written before the digest was added: same schema, older name.
    await mkdir(store.anchorDir(session, 5), { recursive: true })
    await writeFile(join(store.anchorDir(session, 5), 'legacyname.json'), JSON.stringify({
      store: 2, callId: 'old', file: a, blob: 'legacyname.before', size: 1, time: 1,
    }), 'utf8')
    await writeFile(join(store.anchorDir(session, 5), 'legacyname.before'), Buffer.from('A'))
    await captureAndRecord('new', 5, b)

    const entries = await store.entriesAfter(session, 5)
    expect(entries.filter(isLinkEntry)).toHaveLength(0)
    expect(entries).toHaveLength(2)

    await writeFile(a, Buffer.from('x'))
    await writeFile(b, Buffer.from('y'))
    const outcome = await store.restoreAfter(session, 5, unlink)
    expect([...outcome.restored].sort()).toEqual([a, b].sort())
    expect(await readFile(a, 'utf8')).toBe('A')
    expect(await readFile(b, 'utf8')).toBe('B')
  })

  it('rejects a "created" entry whose metadata contradicts itself', async () => {
    // `blob: null` means "did not exist", which is only meaningful with a zero
    // size. Guessing "created" from a contradictory record would DELETE a file
    // the store cannot otherwise restore.
    const live = await touch('contradiction.txt', Buffer.from('live'))
    await mkdir(store.anchorDir(session, 5), { recursive: true })
    await writeFile(join(store.anchorDir(session, 5), 'bad.json'), JSON.stringify({
      store: 2, callId: 'bad', file: live, blob: null, size: 4, time: 1,
    }), 'utf8')

    expect(await store.entriesAfter(session, 5)).toEqual([])
    const outcome = await store.restoreAfter(session, 5, unlink)
    expect(outcome).toEqual({ restored: [], deleted: [], skipped: [], failed: [] })
    expect(await readFile(live, 'utf8')).toBe('live')
  })

  it('keeps composing v1 and v2 entries in one window', async () => {
    const live = await touch('mixed.bin', Buffer.from('v1-content'))
    // A released-v1 real entry (inline string)…
    await mkdir(store.anchorDir(session, 5), { recursive: true })
    await writeFile(join(store.anchorDir(session, 5), 'c1.json'), JSON.stringify({
      callId: 'c1', anchorSeq: 5, path: live, before: 'v1-content', time: 1,
    }), 'utf8')
    // …and a v2 link that points at it (the upgrade-in-the-middle chain).
    await mkdir(store.anchorDir(session, 6), { recursive: true })
    await writeFile(join(store.anchorDir(session, 6), 'c2.json'), JSON.stringify({
      store: 2, callId: 'c2', file: live, ref: '5/c1.json', time: 2,
    }), 'utf8')

    await writeFile(live, Buffer.from('changed'))
    const outcome = await store.restoreAfter(session, 6, unlink)
    expect(outcome.restored).toEqual([live])
    expect(await readFile(live, 'utf8')).toBe('v1-content')
  })
})

describe('residual risks (R1 / R2 / staged captures)', () => {
  it('writes a real backup — not a dangling link — after prune dropped its group', async () => {
    const live = await touch('pruned.bin', Buffer.from('v1'))
    await captureAndRecord('c1', 1, live)
    // Drop the only group holding this path, which also invalidates the
    // in-memory dedup handle that pointed into it.
    await store.prune(session, 0)
    await captureAndRecord('c2', 2, live)
    const entries = await store.entriesAfter(session, 1)
    expect(entries).toHaveLength(1)
    expect(entries.filter(isLinkEntry)).toHaveLength(0)

    await writeFile(live, Buffer.from('v2'))
    const outcome = await store.restoreAfter(session, 1, unlink)
    expect(outcome.restored).toEqual([live])
    expect(await readFile(live, 'utf8')).toBe('v1')
  })

  it('redoes a half-written restore target from the journal', async () => {
    const live = await touch('half.bin', Buffer.from('A0'))
    await captureAndRecord('c1', 5, live)
    await writeFile(live, Buffer.from('A1'))
    // Simulate a crash mid-write: the journal says "restore A0" but the disk
    // holds a truncated prefix — reconcile reports it pending, and the redo
    // rewrites the complete bytes.
    await expect(store.restoreAfter(session, 5, unlink, defaultProbe, {
      crash: (point) => {
        if (point === 'before-action') throw new Error('simulated host crash')
      },
    })).rejects.toThrow('simulated host crash')
    await writeFile(live, Buffer.from('A'))

    const reports = await store.reconcileRestores(session)
    expect(reports).toHaveLength(1)
    expect(reports[0]!.pending).toEqual([live])
    const outcome = await store.continueRestore(session, reports[0]!.opId, unlink)
    expect(outcome.restored).toEqual([live])
    expect(await readFile(live, 'utf8')).toBe('A0')
  })

  it('collects stale staged captures and keeps fresh ones', async () => {
    const stale = await store.stageCapture(session, 'stale')
    await writeFile(stale, Buffer.from('orphan'))
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000)
    await utimes(stale, old, old)
    const fresh = await store.stageCapture(session, 'fresh')
    await writeFile(fresh, Buffer.from('in-flight'))

    await store.prune(session, 1)
    const names = await readdir(join(store.sessionDir(session), '.pending'))
    expect(names).toHaveLength(1)
    expect(names[0]!.startsWith('fresh-') && names[0]!.endsWith('.before')).toBe(true)
  })
})

/** Recursive byte total of a directory tree (the ground truth for `bytes`). */
async function dirBytes(dir: string): Promise<number> {
  let total = 0
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) total += await dirBytes(full)
    else if (entry.isFile()) total += (await stat(full)).size
  }
  return total
}

describe('footprint reporting and reclamation', () => {
  it('reports a byte count that matches the session directory (sidecars included)', async () => {
    const live = await touch('stats.bin', Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]))
    await captureAndRecord('c1', 5, live)
    await writeFile(live, Buffer.from('x'))
    await store.restoreAfter(session, 5, unlink) // leaves a journal + a rescue copy

    const report = await store.clearSession(session, { dryRun: true })
    expect(report.dryRun).toBe(true)
    expect(report.anchorGroups).toBe(1)
    expect(report.entries).toBe(1)
    expect(report.journals).toBe(1)
    // Entry JSON + 8-byte sidecar + journal + rescue copy.
    expect(report.bytes).toBe(await dirBytes(store.sessionDir(session)))
    expect(report.bytes).toBeGreaterThan(8)
  })

  it('reclaims a terminal journal together with its rescue copy', async () => {
    const live = await touch('rescue.bin', Buffer.from('A0'))
    await captureAndRecord('c1', 5, live)
    await writeFile(live, Buffer.from('A1'))
    await store.restoreAfter(session, 5, unlink)

    const sessionDir = store.sessionDir(session)
    const rescueDir = join(sessionDir, 'rescue')
    await expect(readdir(rescueDir)).resolves.toHaveLength(1)

    await store.prune(session, 1)
    // The terminal journal is recycled and its rescue copy goes with it — the
    // bytes are dead weight once the op finished.
    await expect(readdir(rescueDir)).resolves.toHaveLength(0)
  })
})
