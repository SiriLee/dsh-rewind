/**
 * Per-file backup size cap (issue #39): a file larger than the cap is never
 * backed up, and a restore NEVER writes a pre-cap record over a file that is
 * currently over the cap.
 *
 * Only properties no other suite can prove are kept here. The capture half (an
 * over-cap edit records nothing and stages no bytes) is proven host-side in
 * `scripts/verify-host.mjs`; the cases below pin the SAFETY half, the cap
 * resolution, and the coverage-gap behaviour.
 */
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_MAX_FILE_BYTES, MAX_FILE_BYTES_ENV, SnapshotStore } from '../src/snapshot.ts'

/** A cap small enough to cross with a few bytes of test content. */
const CAP = 4096
let root: string
let store: SnapshotStore
const session = 'session-cap'
const unlink = async (path: string): Promise<void> => {
  await rm(path, { force: true })
}
/** Bytes that push a file's content over {@link CAP}. */
const overCap = (): string => 'x'.repeat(CAP + 1024)

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-rewind-cap-'))
  store = new SnapshotStore(root, { maxFileBytes: CAP })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function touch(rel: string, content: string): Promise<string> {
  const abs = join(root, 'ws', rel)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, content, 'utf8')
  return abs
}

describe('per-file size cap', () => {
  it('is over the cap only when a size is known and the cap is in force', () => {
    expect(store.isOverFileCap(CAP + 1)).toBe(true)
    expect(store.isOverFileCap(CAP)).toBe(false)
    // An unknown size is NEVER "too big": the guard fails toward storing more.
    expect(store.isOverFileCap(undefined)).toBe(false)
    expect(new SnapshotStore(root, { maxFileBytes: 0 }).isOverFileCap(1 << 30)).toBe(false)
  })

  it('resolves the cap from the option, the env override, then the default', () => {
    expect(new SnapshotStore(root).fileCapBytes).toBe(DEFAULT_MAX_FILE_BYTES)
    process.env[MAX_FILE_BYTES_ENV] = String(CAP)
    try {
      expect(new SnapshotStore(root).fileCapBytes).toBe(CAP)
      expect(new SnapshotStore(root, { maxFileBytes: 1 }).fileCapBytes).toBe(1)
      // A typo must not silently disable the guard.
      process.env[MAX_FILE_BYTES_ENV] = 'not-a-number'
      expect(new SnapshotStore(root).fileCapBytes).toBe(DEFAULT_MAX_FILE_BYTES)
    } finally {
      delete process.env[MAX_FILE_BYTES_ENV]
    }
  })

  it('refuses to write a pre-cap record over a file that has since grown past the cap', async () => {
    const file = await touch('grew.txt', 'small original')
    await store.recordEntry(session, { callId: 'c1', anchorSeq: 5, path: file, before: 'small original' })
    // An untracked edit (or an over-cap write-class edit) left it far larger.
    await writeFile(file, overCap(), 'utf8')

    const outcome = await store.restoreAfter(session, 5, unlink)

    // THE safety property: the large file is left EXACTLY as it is.
    expect(await readFile(file, 'utf8')).toBe(overCap())
    expect(outcome).toEqual({ restored: [], deleted: [], skipped: [file], failed: [] })
    // …and the preview must not promise that restore either.
    expect(await store.impactsAfter(session, 5)).toEqual([])
  })

  it('never turns a skipped capture into a deletion record', async () => {
    // A capture over the cap records NOTHING — most importantly not a
    // `before: null` "was created" record, which a rewind would turn into a
    // DELETE of a file that exists (the plugin's one destructive failure mode).
    const file = await touch('kept-big.txt', overCap())

    expect(await store.restoreAfter(session, 5, unlink)).toEqual({ restored: [], deleted: [], skipped: [], failed: [] })
    expect(await readFile(file, 'utf8')).toBe(overCap())
  })

  it('reports recorded paths that are currently over the cap as uncovered', async () => {
    const recorded = await touch('tracked-big.txt', 'two')
    await store.recordEntry(session, { callId: 'c1', anchorSeq: 5, path: recorded, before: 'two' })
    await writeFile(recorded, overCap(), 'utf8')

    expect(await store.uncoveredPaths(session)).toEqual([{ path: recorded, size: CAP + 1024 }])
    // Back under the cap: the notice retires itself.
    await writeFile(recorded, 'small again', 'utf8')
    expect(await store.uncoveredPaths(session)).toEqual([])
  })

  it('falls back to the latest recorded small state, and never deletes', async () => {
    // A coverage gap (small → over-cap → small) can only ever UNDER-restore:
    // the planner sees entries at/after the target, so it never writes back a
    // pre-target version, and a skipped capture emits no delete. Pinned because
    // loosening either half would let a gap destroy a file.
    const file = await touch('gap.bin', 'OLD-SMALL')
    await store.recordEntry(session, { callId: 'c1', anchorSeq: 5, path: file, before: 'OLD-SMALL' })
    await writeFile(file, overCap(), 'utf8')
    await writeFile(file, 'NEW-SMALL', 'utf8')
    await store.recordEntry(session, { callId: 'c2', anchorSeq: 6, path: file, before: 'NEW-SMALL' })

    const outcome = await store.restoreAfter(session, 5, unlink)
    expect(outcome.deleted).toEqual([])
    expect(outcome.skipped).toEqual([])
    expect(await readFile(file, 'utf8')).toBe('OLD-SMALL')

    // Rewinding to the post-gap boundary is exact.
    await writeFile(file, 'drifting', 'utf8')
    await store.restoreAfter(session, 6, unlink)
    expect(await readFile(file, 'utf8')).toBe('NEW-SMALL')
  })
})
