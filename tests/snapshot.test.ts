/**
 * Unit tests for the checkpoint store (src/snapshot.ts): disk-backed
 * before-backups grouped by anchor message seq, with real files under a
 * temporary directory — exactly the production restore path.
 */
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SnapshotStore } from '../src/snapshot.ts'

let root: string
let store: SnapshotStore
const session = 'session-test'

const unlink = async (path: string): Promise<void> => {
  await rm(path, { force: true })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-rewind-snap-'))
  store = new SnapshotStore(root)
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

describe('SnapshotStore', () => {
  it('restores a modified file to its pre-edit content', async () => {
    const file = await touch('a.txt', 'original')
    // Turn anchored at seq 5 edits a.txt; the before-capture is 'original'.
    await store.recordEntry(session, { callId: 'c1', anchorSeq: 5, path: file, before: 'original' })
    await writeFile(file, 'rewritten', 'utf8')

    const outcome = await store.restoreAfter(session, 5, unlink)
    expect(outcome.restored).toEqual([file])
    expect(outcome.deleted).toEqual([])
    expect(outcome.failed).toEqual([])
    expect(await readFile(file, 'utf8')).toBe('original')
  })

  it('deletes files created at or after the target', async () => {
    const keep = await touch('keep.txt', 'x')
    await store.recordEntry(session, { callId: 'c1', anchorSeq: 5, path: keep, before: 'x' })
    const created = await touch('new.txt', 'n')
    await store.recordEntry(session, { callId: 'c2', anchorSeq: 6, path: created, before: null })

    const outcome = await store.restoreAfter(session, 5, unlink)
    expect(outcome.deleted).toEqual([created])
    expect(await store.exists(created)).toBe(false)
    expect(await store.exists(keep)).toBe(true)
  })

  it('restores files deleted after the target (before-capture survives)', async () => {
    const file = await touch('gone.txt', 'content')
    await store.recordEntry(session, { callId: 'c1', anchorSeq: 5, path: file, before: 'content' })
    await rm(file, { force: true })

    const outcome = await store.restoreAfter(session, 5, unlink)
    expect(outcome.restored).toEqual([file])
    expect(await readFile(file, 'utf8')).toBe('content')
  })

  it('applies the EARLIEST entry per file across multiple edits', async () => {
    const file = await touch('multi.txt', 'v1')
    await store.recordEntry(session, { callId: 'c1', anchorSeq: 5, path: file, before: 'v1' })
    await store.recordEntry(session, { callId: 'c2', anchorSeq: 6, path: file, before: 'v2' })
    await store.recordEntry(session, { callId: 'c3', anchorSeq: 6, path: file, before: 'v3' })
    await writeFile(file, 'v4', 'utf8')

    const outcome = await store.restoreAfter(session, 5, unlink)
    expect(outcome.restored).toEqual([file])
    expect(await readFile(file, 'utf8')).toBe('v1')
  })

  it('respects the anchor boundary: only entries at/after the target apply', async () => {
    const f1 = await touch('f1.txt', 'a')
    const f2 = await touch('f2.txt', 'b')
    await store.recordEntry(session, { callId: 'c1', anchorSeq: 5, path: f1, before: 'a' })
    await store.recordEntry(session, { callId: 'c2', anchorSeq: 7, path: f2, before: 'b' })
    await writeFile(f1, 'a2', 'utf8')
    await writeFile(f2, 'b2', 'utf8')

    const outcome7 = await store.restoreAfter(session, 7, unlink)
    expect(outcome7.restored).toEqual([f2])
    expect(await readFile(f1, 'utf8')).toBe('a2') // untouched by a rewind to 7
    expect(await readFile(f2, 'utf8')).toBe('b')
  })

  it('previews impacts without mutating anything', async () => {
    const file = await touch('p.txt', 'a')
    await store.recordEntry(session, { callId: 'c1', anchorSeq: 5, path: file, before: 'a' })
    const created = await touch('q.txt', 'b')
    await store.recordEntry(session, { callId: 'c2', anchorSeq: 6, path: created, before: null })

    const impacts = await store.impactsAfter(session, 5)
    expect(impacts).toEqual([
      { path: file, action: 'restore' },
      { path: created, action: 'delete' },
    ])
    expect(await readFile(file, 'utf8')).toBe('a')
    expect(await readFile(created, 'utf8')).toBe('b')
  })

  it('prunes the oldest anchor groups beyond the keep bound', async () => {
    const file = await touch('k.txt', '0')
    for (let seq = 1; seq <= 5; seq++) {
      await store.recordEntry(session, { callId: `c${seq}`, anchorSeq: seq, path: file, before: '0' })
    }
    await store.prune(session, 2)
    expect(await store.entriesAfter(session, 1)).toHaveLength(2) // 1..3 pruned, 4..5 kept
    expect(await store.entriesAfter(session, 4)).toHaveLength(2) // 4..5 kept
  })

  it('survives a store re-instantiation (host restart)', async () => {
    const file = await touch('persist.txt', 'v1')
    await store.recordEntry(session, { callId: 'c1', anchorSeq: 5, path: file, before: 'v1' })
    await writeFile(file, 'v2', 'utf8')

    const reopened = new SnapshotStore(root)
    const outcome = await reopened.restoreAfter(session, 5, unlink)
    expect(outcome.restored).toEqual([file])
    expect(await readFile(file, 'utf8')).toBe('v1')
  })

  it('skips symbolic links without writing through them', async () => {
    const real = await touch('real.txt', 'original')
    const link = join(root, 'ws', 'link.txt')
    const { symlink } = await import('node:fs/promises')
    try {
      await symlink(real, link)
    } catch {
      return // filesystem without symlink support: nothing to assert
    }
    await store.recordEntry(session, { callId: 'c1', anchorSeq: 5, path: link, before: 'original' })
    await writeFile(real, 'rewritten', 'utf8')

    const outcome = await store.restoreAfter(session, 5, unlink)
    expect(outcome.skipped).toEqual([link])
    expect(await readFile(real, 'utf8')).toBe('rewritten')
  })

  it('skips hard links without writing through them', async () => {
    const real = await touch('real.txt', 'original')
    const hard = join(root, 'ws', 'hard.txt')
    const { link } = await import('node:fs/promises')
    try {
      await link(real, hard)
    } catch {
      return // filesystem without hard-link support: nothing to assert
    }
    // The hard link shares the inode with `real`, so a restore through it
    // would clobber both names — it must be skipped like a symlink.
    await store.recordEntry(session, { callId: 'c1', anchorSeq: 5, path: hard, before: 'original' })
    await writeFile(real, 'rewritten', 'utf8')

    const outcome = await store.restoreAfter(session, 5, unlink)
    expect(outcome.skipped).toEqual([hard])
    expect(await readFile(real, 'utf8')).toBe('rewritten')
  })

  it('creates a deleted parent directory when restoring', async () => {
    const file = await touch('sub/deep/a.txt', 'original')
    await store.recordEntry(session, { callId: 'c1', anchorSeq: 5, path: file, before: 'original' })
    // The file's whole parent tree is gone after the backup.
    await rm(join(root, 'ws', 'sub'), { recursive: true, force: true })

    const outcome = await store.restoreAfter(session, 5, unlink)
    expect(outcome.restored).toEqual([file])
    expect(await readFile(file, 'utf8')).toBe('original')
  })

  it('restores with no entries as an empty no-op', async () => {
    const outcome = await store.restoreAfter(session, 42, unlink)
    expect(outcome).toEqual({ restored: [], deleted: [], skipped: [], failed: [] })
    expect(await store.impactsAfter(session, 42)).toEqual([])
  })
})
