/**
 * Unit tests for the checkpoint store (src/snapshot.ts): disk-backed
 * before-backups grouped by anchor message seq, with real files under a
 * temporary directory — exactly the production restore path.
 */
import { mkdtemp, mkdir, rm, writeFile, readFile, utimes, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reconcileTracked, SnapshotStore, isLinkEntry, type DiskProbe } from '../src/snapshot.ts'

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
    // The file is edited after the backup so the preview sees a real diff
    // (identical content would reconcile to NO impact).
    await writeFile(file, 'changed', 'utf8')

    const impacts = await store.impactsAfter(session, 5)
    expect(impacts).toEqual([
      { path: file, action: 'restore' },
      { path: created, action: 'delete' },
    ])
    expect(await readFile(file, 'utf8')).toBe('changed') // preview never mutates
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

describe('restore planning reconciles with the current disk (Claude Code behavior)', () => {
  it('reports no ghost impact for a creation entry whose file is already gone', async () => {
    // Regression for the repeated-rewind bug: a rewind to message 2 deletes
    // the created file, but its entry stays in the store. A later rewind to
    // message 1 must NOT re-report the delete — the disk already matches the
    // target state, so the option disappears and the restore is a no-op.
    const created = await touch('gone.txt', 'n')
    await store.recordEntry(session, { callId: 'c1', anchorSeq: 6, path: created, before: null })
    await rm(created, { force: true }) // e.g. applied by an earlier rewind

    expect(await store.impactsAfter(session, 5)).toEqual([])
    const outcome = await store.restoreAfter(session, 5, unlink)
    expect(outcome).toEqual({ restored: [], deleted: [], skipped: [], failed: [] })
  })

  it('treats identical content as no impact (idempotent restore)', async () => {
    const file = await touch('same.txt', 'x')
    await store.recordEntry(session, { callId: 'c1', anchorSeq: 5, path: file, before: 'x' })
    // Disk already equals the recorded before state.
    expect(await store.impactsAfter(session, 5)).toEqual([])
    const outcome = await store.restoreAfter(session, 5, unlink)
    expect(outcome).toEqual({ restored: [], deleted: [], skipped: [], failed: [] })
    expect(await readFile(file, 'utf8')).toBe('x')
  })

  it('tolerates a delete whose file is already absent (no ENOENT failure)', async () => {
    const created = await touch('missing.txt', 'n')
    await store.recordEntry(session, { callId: 'c1', anchorSeq: 6, path: created, before: null })
    // The injected deleteFile itself fails with ENOENT (production unlink on
    // an absent file): the pass must swallow it, not report a failure.
    const outcome = await store.restoreAfter(session, 5, async () => {
      throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' })
    })
    expect(outcome).toEqual({ restored: [], deleted: [], skipped: [], failed: [] })
  })

  it('restores a missing file whose before content exists (recreates it)', async () => {
    const file = await touch('recreate.txt', 'content')
    await store.recordEntry(session, { callId: 'c1', anchorSeq: 5, path: file, before: 'content' })
    await writeFile(file, 'edited', 'utf8')
    await rm(file, { force: true })

    const outcome = await store.restoreAfter(session, 5, unlink)
    expect(outcome.restored).toEqual([file])
    expect(await readFile(file, 'utf8')).toBe('content')
  })

  it('plans exactly the real differences (injected probe)', async () => {
    const a = await touch('a.txt', '')
    const b = await touch('b.txt', '')
    const c = await touch('c.txt', '')
    await store.recordEntry(session, { callId: 'a', anchorSeq: 5, path: a, before: 'A0' })
    await store.recordEntry(session, { callId: 'b', anchorSeq: 5, path: b, before: 'B0' })
    await store.recordEntry(session, { callId: 'c', anchorSeq: 5, path: c, before: null })
    const probe: DiskProbe = {
      isLink: async () => false,
      readText: async (path: string) => {
        if (path === a) return 'A0' // identical → no impact
        if (path === b) return 'B1' // differs → restore
        if (path === c) return undefined // creation already absent → no impact
        return undefined
      },
    }
    expect(await store.impactsAfter(session, 5, probe)).toEqual([
      { path: b, action: 'restore' },
    ])
  })

  it('conservatively plans a restore when the disk probe fails', async () => {
    const file = await touch('unreadable.txt', 'original')
    await store.recordEntry(session, { callId: 'c1', anchorSeq: 5, path: file, before: 'original' })
    const failingProbe: DiskProbe = {
      isLink: async () => false,
      readText: async () => {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
      },
    }
    // An unreadable file is never silently dropped: the plan treats it as
    // differing, so the restore still attempts the write.
    expect(await store.impactsAfter(session, 5, failingProbe)).toEqual([
      { path: file, action: 'restore' },
    ])
    const outcome = await store.restoreAfter(session, 5, unlink, failingProbe)
    expect(outcome.restored).toEqual([file])
  })
})

describe('reconcileTracked (user-message boundary re-check)', () => {
  it('records an external edit at the next boundary and restores it on rewind', async () => {
    const file = await touch('tracked.txt', 'original')
    await store.recordEntry(session, { callId: 'tool', anchorSeq: 5, path: file, before: 'original' })
    await writeFile(file, 'externally edited', 'utf8') // external change
    const tracked = await store.trackedPaths(session)

    expect(await reconcileTracked(store, session, 7, tracked)).toBe(1)
    // The recheck entry anchors the external state at the boundary message.
    // Rewinding to it restores the external edit…
    await writeFile(file, 'something else', 'utf8')
    const outcome = await store.restoreAfter(session, 7, unlink)
    expect(outcome.restored).toEqual([file])
    expect(await readFile(file, 'utf8')).toBe('externally edited')
    // …while rewinding before it still restores the tool-captured before.
    await writeFile(file, 'again', 'utf8')
    const earlier = await store.restoreAfter(session, 5, unlink)
    expect(earlier.restored).toEqual([file])
    expect(await readFile(file, 'utf8')).toBe('original')
  })

  it('records a deletion and restores the file when rewinding before it', async () => {
    const file = await touch('tracked.txt', 'original')
    await store.recordEntry(session, { callId: 'tool', anchorSeq: 5, path: file, before: 'original' })
    await rm(file, { force: true }) // external delete
    const tracked = await store.trackedPaths(session)

    expect(await reconcileTracked(store, session, 7, tracked)).toBe(1)
    // At the boundary the deletion is already applied: rewinding to 7 is a
    // no-op; rewinding before it recreates the file from the earlier entry.
    expect(await store.impactsAfter(session, 7)).toEqual([])
    const outcome = await store.restoreAfter(session, 5, unlink)
    expect(outcome.restored).toEqual([file])
    expect(await readFile(file, 'utf8')).toBe('original')
  })

  it('records only on state change (first sighting always records)', async () => {
    const file = await touch('tracked.txt', 'original')
    await store.recordEntry(session, { callId: 'tool', anchorSeq: 5, path: file, before: 'original' })
    await writeFile(file, 'edited by turn', 'utf8')
    const tracked = await store.trackedPaths(session)

    // First sighting of the path: unconditionally record the current state.
    expect(await reconcileTracked(store, session, 7, tracked)).toBe(1)
    // Next boundary: state unchanged → nothing new recorded.
    expect(await reconcileTracked(store, session, 8, tracked)).toBe(0)
    // External change → recorded again.
    await writeFile(file, 'externally edited', 'utf8')
    expect(await reconcileTracked(store, session, 9, tracked)).toBe(1)
  })

  it('skips symlinked paths', async () => {
    const real = await touch('real.txt', 'x')
    const link = join(root, 'ws', 'link.txt')
    const { symlink } = await import('node:fs/promises')
    try {
      await symlink(real, link)
    } catch {
      return // filesystem without symlink support: nothing to assert
    }
    await store.recordEntry(session, { callId: 'tool', anchorSeq: 5, path: link, before: 'x' })
    const tracked = await store.trackedPaths(session)
    expect(await reconcileTracked(store, session, 7, tracked)).toBe(0)
  })
})

describe('content dedup (in-place link; old + new entry format)', () => {
  it('reads pre-dedup (legacy, no `ref`) entries correctly: restore/impacts/tracked', async () => {
    const file = await touch('a.txt', 'original')
    // Simulate an OLD-format entry written by a pre-dedup build (no `ref`).
    await mkdir(store.anchorDir(session, 5), { recursive: true })
    await writeFile(join(store.anchorDir(session, 5), 'legacy1.json'), JSON.stringify({ callId: 'legacy1', anchorSeq: 5, path: file, before: 'original', time: 1 }))
    await writeFile(file, 'changed', 'utf8')
    expect((await store.trackedPaths(session)).has(file)).toBe(true)
    expect(await store.impactsAfter(session, 5)).toEqual([{ path: file, action: 'restore' }])
    const outcome = await store.restoreAfter(session, 5, unlink)
    expect(outcome.restored).toEqual([file])
    expect(await readFile(file, 'utf8')).toBe('original')
  })

  it('dedups a new identical write against a legacy real entry (new reads old)', async () => {
    const file = await touch('a.txt', 'v')
    await mkdir(store.anchorDir(session, 5), { recursive: true })
    await writeFile(join(store.anchorDir(session, 5), 'legacy1.json'), JSON.stringify({ callId: 'legacy1', anchorSeq: 5, path: file, before: 'same', time: 1 }))
    await store.recordEntry(session, { callId: 'new1', anchorSeq: 6, path: file, before: 'same' })
    const entries = await store.entriesAfter(session, 5)
    const links = entries.filter(isLinkEntry)
    expect(links).toHaveLength(1)
    expect(links[0]!.ref).toBe('5/legacy1.json') // the new entry links to the legacy real
    expect(entries.filter(e => !isLinkEntry(e))).toHaveLength(1)
    // The link is not just structural: restoring through it pulls the LEGACY
    // (old-format) real content back, proving new-reads-old actually works.
    await writeFile(file, 'changed', 'utf8')
    const outcome = await store.restoreAfter(session, 6, unlink)
    expect(outcome.restored).toEqual([file])
    expect(await readFile(file, 'utf8')).toBe('same')
  })

  it('collapses the boundary-recheck + write-tool double record into one real + one link', async () => {
    const file = await touch('a.txt', 'v')
    // recheck (boundary) records the current state, then the turn's tool edit
    // captures the SAME before — the second becomes a link to the first.
    await store.recordEntry(session, { callId: 'recheck-5', anchorSeq: 5, path: file, before: 'same' })
    await store.recordEntry(session, { callId: 'tool', anchorSeq: 5, path: file, before: 'same' })
    const entries = await store.entriesAfter(session, 5)
    expect(entries).toHaveLength(2)
    expect(entries.filter(isLinkEntry)).toHaveLength(1)
    expect(entries.filter(e => !isLinkEntry(e))).toHaveLength(1)
  })

  it('realistic double-record via the boundary recheck + next tool capture is deduped', async () => {
    const file = await touch('a.txt', 'A')
    // Turn 1: a tool edits A→X; the recordEntry captures before=A.
    await store.recordEntry(session, { callId: 'tool1', anchorSeq: 5, path: file, before: 'A' })
    await writeFile(file, 'X', 'utf8')
    // Turn 2 boundary: reconcileTracked re-reads the tracked file; the state
    // changed to X, so it records a before=X entry at the boundary.
    const tracked = await store.trackedPaths(session)
    expect(await reconcileTracked(store, session, 7, tracked)).toBe(1)
    // Turn 2 tool: edits X→Y; the capture before is ALSO X — dedup turns this
    // into a link to the boundary's X entry instead of a second full copy.
    await store.recordEntry(session, { callId: 'tool2', anchorSeq: 7, path: file, before: 'X' })
    const entries = await store.entriesAfter(session, 5)
    expect(entries.filter(isLinkEntry)).toHaveLength(1)
    expect(entries.filter(e => !isLinkEntry(e))).toHaveLength(2) // A@5, X@7(recheck)
    // Rewinding to the second turn restores X (through the earliest X entry).
    await writeFile(file, 'Y', 'utf8')
    const outcome = await store.restoreAfter(session, 7, unlink)
    expect(outcome.restored).toEqual([file])
    expect(await readFile(file, 'utf8')).toBe('X')
  })

  it('keeps genuinely different content as separate real snapshots (no false dedup)', async () => {
    const file = await touch('a.txt', 'v')
    await store.recordEntry(session, { callId: 'c1', anchorSeq: 5, path: file, before: 'v1' })
    await store.recordEntry(session, { callId: 'c2', anchorSeq: 6, path: file, before: 'v2' })
    const entries = await store.entriesAfter(session, 5)
    expect(entries.filter(isLinkEntry)).toHaveLength(0)
    expect(entries).toHaveLength(2)
  })

  it('restores the correct content when the earliest entry at the target is a link', async () => {
    const file = await touch('a.txt', 'v')
    await store.recordEntry(session, { callId: 'c1', anchorSeq: 5, path: file, before: 'original' })
    await writeFile(file, 'edited', 'utf8')
    await store.recordEntry(session, { callId: 'c2', anchorSeq: 6, path: file, before: 'edited' })
    await writeFile(file, 'final', 'utf8')
    await store.recordEntry(session, { callId: 'c3', anchorSeq: 7, path: file, before: 'edited' }) // link to c2
    const outcome = await store.restoreAfter(session, 7, unlink)
    expect(outcome.restored).toEqual([file])
    expect(await readFile(file, 'utf8')).toBe('edited')
  })

  it('writes full copies when dedup is disabled', async () => {
    const file = await touch('a.txt', 'v')
    const s = new SnapshotStore(root, { dedup: false })
    await s.recordEntry(session, { callId: 'c1', anchorSeq: 5, path: file, before: 'same' })
    await s.recordEntry(session, { callId: 'c2', anchorSeq: 6, path: file, before: 'same' })
    const entries = await s.entriesAfter(session, 5)
    expect(entries.filter(isLinkEntry)).toHaveLength(0)
    expect(entries).toHaveLength(2)
  })

  it('persists and rereads link entries across a restart (new format read)', async () => {
    const file = await touch('a.txt', 'v')
    await store.recordEntry(session, { callId: 'c1', anchorSeq: 5, path: file, before: 'X' })
    await store.recordEntry(session, { callId: 'c2', anchorSeq: 6, path: file, before: 'X' }) // link
    const reopened = new SnapshotStore(root)
    await writeFile(file, 'changed', 'utf8')
    const outcome = await reopened.restoreAfter(session, 6, unlink)
    expect(outcome.restored).toEqual([file])
    expect(await readFile(file, 'utf8')).toBe('X')
  })

  it('seeds dedup state from disk after a restart so identical content still links', async () => {
    const file = await touch('a.txt', 'v')
    const s1 = new SnapshotStore(root)
    await s1.recordEntry(session, { callId: 'c1', anchorSeq: 5, path: file, before: 'X' })
    const s2 = new SnapshotStore(root)
    await s2.recordEntry(session, { callId: 'c2', anchorSeq: 6, path: file, before: 'X' })
    const entries = await s2.entriesAfter(session, 5)
    expect(entries.filter(isLinkEntry)).toHaveLength(1)
    expect(entries.filter(e => !isLinkEntry(e))).toHaveLength(1)
  })

  it('materializes links before dropping the referenced group during prune (no dangling)', async () => {
    const file = await touch('a.txt', 'v')
    await store.recordEntry(session, { callId: 'c1', anchorSeq: 1, path: file, before: 'A' })
    await store.recordEntry(session, { callId: 'c2', anchorSeq: 2, path: file, before: 'A' })
    await store.recordEntry(session, { callId: 'c3', anchorSeq: 3, path: file, before: 'A' })
    await store.prune(session, 1)
    const entries = await store.entriesAfter(session, 1)
    expect(entries).toHaveLength(1)
    const survivor = entries[0]!
    if (isLinkEntry(survivor)) throw new Error('expected a materialized real snapshot')
    expect(survivor.before).toBe('A')
    // Reopen on disk and confirm the surviving entry restores without a dangling link.
    const reopened = new SnapshotStore(root)
    await writeFile(file, 'changed', 'utf8')
    const outcome = await reopened.restoreAfter(session, 1, unlink)
    expect(outcome.restored).toEqual([file])
    expect(await readFile(file, 'utf8')).toBe('A')
  })

  it('reports a dangling (corrupt) link as a per-file failure, never silently skipping', async () => {
    const file = await touch('a.txt', 'v')
    await mkdir(store.anchorDir(session, 6), { recursive: true })
    await writeFile(join(store.anchorDir(session, 6), 'c2.json'), JSON.stringify({ callId: 'c2', anchorSeq: 6, path: file, ref: '99/missing.json', time: 1 }))
    const outcome = await store.restoreAfter(session, 6, unlink)
    expect(outcome.failed).toHaveLength(1)
    expect(outcome.failed[0]!.path).toBe(file)
    expect(outcome.restored).toEqual([])
    expect(outcome.deleted).toEqual([])
  })

  it('applies a good action AND reports a dangling link in the same restore', async () => {
    const good = await touch('good.txt', 'v')
    const broken = await touch('broken.txt', 'v')
    await store.recordEntry(session, { callId: 'g', anchorSeq: 5, path: good, before: 'before' })
    await writeFile(good, 'after', 'utf8')
    // A corrupt link for a second path at the same target.
    await writeFile(join(store.anchorDir(session, 5), 'broken.json'), JSON.stringify({ callId: 'broken', anchorSeq: 5, path: broken, ref: '99/missing.json', time: 2 }))
    const outcome = await store.restoreAfter(session, 5, unlink)
    expect(outcome.restored).toEqual([good])          // the good path is still restored
    expect(await readFile(good, 'utf8')).toBe('before')
    expect(outcome.failed).toHaveLength(1)            // the dangling link is reported, not silent
    expect(outcome.failed[0]!.path).toBe(broken)
  })

  it('dedups two created (before null) states for the same file into a link', async () => {
    const file = await touch('a.txt', 'v')
    await store.recordEntry(session, { callId: 'c1', anchorSeq: 5, path: file, before: null })
    await store.recordEntry(session, { callId: 'c2', anchorSeq: 6, path: file, before: null })
    const entries = await store.entriesAfter(session, 5)
    expect(entries.filter(isLinkEntry)).toHaveLength(1)   // c2 links to c1
    expect(entries.filter(e => !isLinkEntry(e))).toHaveLength(1)
  })

  it('collapses a long identical run into one real plus links', async () => {
    const file = await touch('a.txt', 'v')
    for (let seq = 1; seq <= 5; seq++) {
      await store.recordEntry(session, { callId: `c${seq}`, anchorSeq: seq, path: file, before: 'same' })
    }
    const entries = await store.entriesAfter(session, 1)
    expect(entries.filter(isLinkEntry)).toHaveLength(4)          // c2..c5 link to c1
    expect(entries.filter(e => !isLinkEntry(e))).toHaveLength(1) // c1 real
  })

  it('reports the correct impact when the earliest entry at the target is a link', async () => {
    const file = await touch('a.txt', 'v')
    await store.recordEntry(session, { callId: 'c1', anchorSeq: 5, path: file, before: 'X' })
    await store.recordEntry(session, { callId: 'c2', anchorSeq: 6, path: file, before: 'X' }) // link
    await writeFile(file, 'Y', 'utf8')
    expect(await store.impactsAfter(session, 6)).toEqual([{ path: file, action: 'restore' }])
  })

  it('treats a traversal (unsafe) ref as an invalid link, never reading outside the store', async () => {
    const file = await touch('a.txt', 'v')
    await mkdir(store.anchorDir(session, 6), { recursive: true })
    // A tampered/corrupt link whose ref tries to escape the session dir.
    await writeFile(join(store.anchorDir(session, 6), 'c2.json'), JSON.stringify({ callId: 'c2', anchorSeq: 6, path: file, ref: '../outside.json', time: 1 }))
    // A decoy one level up: it is never read if the ref is not followed.
    await writeFile(join(root, 'outside.json'), 'decoy', 'utf8')
    const outcome = await store.restoreAfter(session, 6, unlink)
    expect(outcome.failed).toHaveLength(1)          // reported, not silent
    expect(outcome.restored).toEqual([])
    expect(outcome.deleted).toEqual([])
    expect(await readFile(join(root, 'outside.json'), 'utf8')).toBe('decoy')
  })
})

describe('pruneStale', () => {
  const day = 86_400_000
  const now = () => Date.now()

  /** Seed one anchor group with an entry file and pin every ancestor mtime. */
  async function seedSession(sessionId: string, anchor: string, callId: string, body: string, mtimeMs: number): Promise<void> {
    const anchorDir = join(root, sessionId, anchor)
    await mkdir(anchorDir, { recursive: true })
    const file = join(anchorDir, `${callId}.json`)
    await writeFile(file, body, 'utf8')
    const t = new Date(mtimeMs)
    await utimes(file, t, t)
    await utimes(anchorDir, t, t)
    await utimes(join(root, sessionId), t, t)
  }

  /** Seed a journal-only session (an entry directly in the session dir). */
  async function seedJournal(sessionId: string, name: string, body: string, mtimeMs: number): Promise<void> {
    const sessionDir = join(root, sessionId)
    await mkdir(sessionDir, { recursive: true })
    const file = join(sessionDir, name)
    await writeFile(file, body, 'utf8')
    const t = new Date(mtimeMs)
    await utimes(file, t, t)
    await utimes(sessionDir, t, t)
  }

  it('deletes finished-session dirs idle past maxAgeDays and keeps fresh ones', async () => {
    await seedSession('old', '1', 'a', '{}', now() - 40 * day)
    await seedSession('fresh', '1', 'a', '{}', now() - 1 * day)
    const rep = await store.pruneStale({ maxAgeDays: 30 })
    expect(rep).toMatchObject({ deleted: 1, kept: 1, scanned: 2, skippedActive: 0, dryRun: false })
    expect(rep.freedBytes).toBeGreaterThan(0)
    await expect(store.exists(join(root, 'old'))).resolves.toBe(false)
    await expect(store.exists(join(root, 'fresh'))).resolves.toBe(true)
  })

  it('measures the newest MEMBER mtime, not the session-dir mtime', async () => {
    await seedSession('nested', '1', 'a', '{}', now() - 40 * day)
    // A fresh file inside an otherwise old anchor group: newest member wins.
    const fresh = join(root, 'nested', '1', 'b.json')
    await writeFile(fresh, '{}', 'utf8')
    await utimes(join(root, 'nested', '1'), new Date(now() - 40 * day), new Date(now() - 40 * day))
    await utimes(join(root, 'nested'), new Date(now() - 40 * day), new Date(now() - 40 * day))
    const rep = await store.pruneStale({ maxAgeDays: 30 })
    expect(rep.deleted).toBe(0)
    expect(rep.kept).toBe(1)
  })

  it('never deletes the active session, even when idle past the cutoff', async () => {
    await seedSession('active', '1', 'a', '{}', now() - 40 * day)
    const rep = await store.pruneStale({ maxAgeDays: 30, keepActiveId: 'active' })
    expect(rep.skippedActive).toBe(1)
    expect(rep.deleted).toBe(0)
    await expect(store.exists(join(root, 'active'))).resolves.toBe(true)
  })

  it('reports without deleting when dryRun', async () => {
    await seedSession('old', '1', 'a', '{}', now() - 40 * day)
    const rep = await store.pruneStale({ maxAgeDays: 30, dryRun: true })
    expect(rep.dryRun).toBe(true)
    expect(rep.deleted).toBe(1)
    expect(rep.freedBytes).toBeGreaterThan(0)
    await expect(store.exists(join(root, 'old'))).resolves.toBe(true) // untouched
  })

  it('uses a strict older-than cutoff (== maxAgeDays is retained)', async () => {
    vi.useFakeTimers()
    try {
      const t0 = 1_700_000_000_000
      vi.setSystemTime(t0)
      await seedSession('exact', '1', 'a', '{}', t0 - 30 * day)
      // Exactly at the cutoff: not older-than => kept.
      const rep0 = await store.pruneStale({ maxAgeDays: 30 })
      expect(rep0.deleted).toBe(0)
      expect(rep0.kept).toBe(1)
      // One day later: now strictly older than 30 days => deleted.
      vi.setSystemTime(t0 + day)
      const rep1 = await store.pruneStale({ maxAgeDays: 30 })
      expect(rep1.deleted).toBe(1)
      expect(rep1.kept).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects a non-positive maxAgeDays instead of mass-deleting', async () => {
    await expect(store.pruneStale({ maxAgeDays: 0 })).rejects.toThrow(RangeError)
    await expect(store.pruneStale({ maxAgeDays: -5 })).rejects.toThrow(RangeError)
    await expect(store.pruneStale({ maxAgeDays: Number.NaN })).rejects.toThrow(RangeError)
  })

  it('returns an empty report when the root does not exist', async () => {
    const missing = new SnapshotStore(join(root, 'nope'))
    const rep = await missing.pruneStale({ maxAgeDays: 30 })
    expect(rep).toMatchObject({ scanned: 0, deleted: 0, kept: 0, skippedActive: 0, freedBytes: 0 })
  })

  it('counts mixed sessions and reports sizes correctly', async () => {
    await seedSession('a', '1', 'x', '{}', now() - 40 * day) // old -> delete (2 bytes)
    await seedSession('b', '1', 'x', '{}', now() - 1 * day)  // fresh -> keep (2 bytes)
    await seedSession('c', '1', 'x', '{}', now() - 40 * day) // old but active -> skip (2 bytes)
    const rep = await store.pruneStale({ maxAgeDays: 30, keepActiveId: 'c' })
    expect(rep).toMatchObject({ scanned: 3, deleted: 1, kept: 1, skippedActive: 1 })
    expect(rep.freedBytes).toBe(2)      // 'a' (one 2-byte file)
    expect(rep.remainingBytes).toBe(4)  // 'b' + 'c' (one 2-byte file each)
    await expect(store.exists(join(root, 'a'))).resolves.toBe(false)
    await expect(store.exists(join(root, 'b'))).resolves.toBe(true)
    await expect(store.exists(join(root, 'c'))).resolves.toBe(true)
  })

  it('measures and prunes a journal-only session (no anchor groups)', async () => {
    await seedJournal('j', 'restore-journal-x.json', '{}', now() - 40 * day)
    const rep = await store.pruneStale({ maxAgeDays: 30 })
    expect(rep.deleted).toBe(1)
    await expect(store.exists(join(root, 'j'))).resolves.toBe(false)
  })

  it('skips non-directories and dot-prefixed entries in the root', async () => {
    await writeFile(join(root, 'stray.txt'), 'x', 'utf8')
    await mkdir(join(root, '.hidden'), { recursive: true })
    await seedSession('real', '1', 'a', '{}', now() - 40 * day)
    const rep = await store.pruneStale({ maxAgeDays: 30 })
    expect(rep.scanned).toBe(1)
    expect(rep.deleted).toBe(1)
    await expect(store.exists(join(root, 'stray.txt'))).resolves.toBe(true)
    await expect(store.exists(join(root, '.hidden'))).resolves.toBe(true)
  })

  it('never follows a symlink out of the root (containment)', async () => {
    const outside = join(root, '..', `outside-${Date.now()}`)
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'secret.txt'), 's', 'utf8')
    try {
      await symlink(outside, join(root, 'link'), 'dir')
      await seedSession('real', '1', 'a', '{}', now() - 40 * day)
      const rep = await store.pruneStale({ maxAgeDays: 30 })
      expect(rep.scanned).toBe(1) // 'link' is a symlink => not a directory => skipped
      expect(rep.deleted).toBe(1)
      await expect(store.exists(join(outside, 'secret.txt'))).resolves.toBe(true)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('is idempotent: a second sweep removes nothing new', async () => {
    await seedSession('old', '1', 'a', '{}', now() - 40 * day)
    await store.pruneStale({ maxAgeDays: 30 })
    const rep2 = await store.pruneStale({ maxAgeDays: 30 })
    expect(rep2.deleted).toBe(0)
    expect(rep2.scanned).toBe(0)
  })

  it('keeps everything when maxAgeDays is large', async () => {
    await seedSession('old', '1', 'a', '{}', now() - 40 * day)
    const rep = await store.pruneStale({ maxAgeDays: 365 })
    expect(rep.deleted).toBe(0)
    expect(rep.kept).toBe(1)
  })
})

describe('clearSession', () => {
  it('reports a zero summary for a session with no data', async () => {
    const rep = await store.clearSession(session)
    expect(rep).toEqual({ sessionId: session, anchorGroups: 0, entries: 0, journals: 0, bytes: 0, dryRun: false })
    // A missing dir is a no-op regardless of the dry/apply switch.
    const dry = await store.clearSession('nope', { dryRun: true })
    expect(dry.dryRun).toBe(true)
    expect(dry.entries).toBe(0)
    expect(dry.anchorGroups).toBe(0)
  })

  it('summarizes anchor groups, entries, journals and bytes', async () => {
    const a = await touch('a.txt', 'one')
    const b = await touch('b.txt', 'two')
    const c = await touch('c.txt', 'three')
    await store.recordEntry(session, { callId: 'a1', anchorSeq: 5, path: a, before: 'one' })
    await store.recordEntry(session, { callId: 'b1', anchorSeq: 5, path: b, before: 'two' })
    await store.recordEntry(session, { callId: 'c1', anchorSeq: 7, path: c, before: 'three' })
    // Fabricate a journal file directly in the session dir (named by prefix).
    const sessionDir = store.sessionDir(session)
    await writeFile(join(sessionDir, 'restore-journal-op1.json'), JSON.stringify({ v: 1 }), 'utf8')
    const rep = await store.clearSession(session, { dryRun: true })
    expect(rep.anchorGroups).toBe(2)
    expect(rep.entries).toBe(3)
    expect(rep.journals).toBe(1)
    expect(rep.bytes).toBeGreaterThan(0)
    expect(rep.dryRun).toBe(true)
  })

  it('dry-run leaves disk and dedup memory untouched', async () => {
    const file = await touch('a.txt', 'original')
    await store.recordEntry(session, { callId: 'c1', anchorSeq: 5, path: file, before: 'original' })
    await store.lastKnownContent(session, file) // seed dedup state
    const rep = await store.clearSession(session, { dryRun: true })
    expect(rep.dryRun).toBe(true)
    expect(rep.entries).toBe(1)
    expect(await store.exists(store.sessionDir(session))).toBe(true)
    expect(await store.trackedPaths(session)).toEqual(new Set([file]))
    expect(await store.lastKnownContent(session, file)).toBe('original')
  })

  it('apply clears the session dir and resets dedup memory (no dangling link)', async () => {
    const file = await touch('a.txt', 'original')
    await store.recordEntry(session, { callId: 'c1', anchorSeq: 5, path: file, before: 'original' })
    const rep = await store.clearSession(session)
    expect(rep.dryRun).toBe(false)
    expect(rep.entries).toBe(1)
    expect(await store.exists(store.sessionDir(session))).toBe(false)
    expect(await store.trackedPaths(session)).toEqual(new Set())
    expect(await store.lastKnownContent(session, file)).toBeUndefined()
    // A fresh record for the same path/content must be a real entry, NOT a link
    // to the just-deleted prior entry (the dedup chain was reset).
    const file2 = await touch('a.txt', 'original')
    await store.recordEntry(session, { callId: 'c2', anchorSeq: 6, path: file2, before: 'original' })
    const entries = await store.entriesAfter(session, 0)
    expect(entries).toHaveLength(1)
    expect(isLinkEntry(entries[0]!)).toBe(false)
    expect(entries[0]!.path).toBe(file2)
  })

  it('clears a session even when a stale (orphaned) non-terminal restore journal exists', async () => {
    const file = await touch('a.txt', 'original')
    await store.recordEntry(session, { callId: 'c1', anchorSeq: 5, path: file, before: 'original' })
    await writeFile(file, 'rewritten', 'utf8')
    // Crash BEFORE the first restore action so a `running` journal stays on disk.
    await expect(store.restoreAfter(session, 5, unlink, undefined, { crash: () => { throw new Error('crash') } })).rejects.toThrow()
    const dir = store.sessionDir(session)
    expect(await store.exists(dir)).toBe(true)
    // Clearing is an explicit abandonment of this session's archive, so it must
    // proceed regardless of the orphaned journal (it is only ever stale — a
    // clear and a restore never interleave).
    const rep = await store.clearSession(session)
    expect(rep.dryRun).toBe(false)
    expect(await store.exists(dir)).toBe(false)
  })

  it('clears a session holding a corrupt (unclassifiable) journal', async () => {
    const file = await touch('a.txt', 'x')
    await store.recordEntry(session, { callId: 'c1', anchorSeq: 5, path: file, before: 'x' })
    await writeFile(join(store.sessionDir(session), 'restore-journal-bad.json'), JSON.stringify({ not: 'a journal' }), 'utf8')
    const rep = await store.clearSession(session)
    expect(rep.dryRun).toBe(false)
    expect(rep.journals).toBe(1)
    expect(await store.exists(store.sessionDir(session))).toBe(false)
  })

  it('apply on an already-empty session still resets the in-memory dedup state', async () => {
    const file = await touch('a.txt', 'original')
    await store.recordEntry(session, { callId: 'c1', anchorSeq: 5, path: file, before: 'original' })
    // Remove the session dir out-of-band while the in-memory dedup state still
    // holds this path's content (simulates an external wipe).
    await rm(store.sessionDir(session), { recursive: true, force: true })
    await store.clearSession(session) // apply on an empty/nonexistent dir
    expect(await store.lastKnownContent(session, file)).toBeUndefined()
    // A fresh record for the same path must be a full entry, not a dangling link.
    const file2 = await touch('a.txt', 'original')
    await store.recordEntry(session, { callId: 'c2', anchorSeq: 6, path: file2, before: 'original' })
    const entries = await store.entriesAfter(session, 0)
    expect(entries).toHaveLength(1)
    expect(isLinkEntry(entries[0]!)).toBe(false)
  })

  it('does not interfere with the age-based retention sweep', async () => {
    // Seed a stale session past the 30-day cutoff directly on disk.
    const staleDir = join(root, 'stale')
    const staleAnchor = join(staleDir, '1')
    await mkdir(staleAnchor, { recursive: true })
    const staleFile = join(staleAnchor, 'a.json')
    await writeFile(staleFile, '{}', 'utf8')
    const t = new Date(Date.now() - 40 * 86_400_000)
    await utimes(staleFile, t, t)
    await utimes(staleAnchor, t, t)
    await utimes(staleDir, t, t)
    // Clear the active session, then verify the stale sweep still removes `stale`.
    const file = await touch('a.txt', 'x')
    await store.recordEntry(session, { callId: 'c1', anchorSeq: 5, path: file, before: 'x' })
    await store.clearSession(session)
    const rep = await store.pruneStale({ keepActiveId: session, maxAgeDays: 30 })
    expect(rep.deleted).toBe(1)
    expect(await store.exists(join(root, 'stale'))).toBe(false)
  })
})

describe('store-root default (harness-home resolution)', () => {
  const prevHome = process.env.DSH_HOME
  const prevOverride = process.env.DSH_REWIND_SNAPSHOT_DIR
  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    if (prevOverride === undefined) delete process.env.DSH_REWIND_SNAPSHOT_DIR
    else process.env.DSH_REWIND_SNAPSHOT_DIR = prevOverride
  })

  it('follows $DSH_HOME when set', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-rewind-home-'))
    try {
      process.env.DSH_HOME = home
      expect(new SnapshotStore().root).toBe(join(home, 'rewind-snapshots'))
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('defaults under ~/.dsh when $DSH_HOME is unset', () => {
    delete process.env.DSH_HOME
    const s = new SnapshotStore()
    expect(isAbsolute(s.root)).toBe(true)
    expect(s.root.endsWith(join('.dsh', 'rewind-snapshots'))).toBe(true)
  })

  it('DSH_REWIND_SNAPSHOT_DIR env overrides the harness-home default', () => {
    process.env.DSH_HOME = join(tmpdir(), 'dsh-home-a')
    const override = join(tmpdir(), 'override')
    process.env.DSH_REWIND_SNAPSHOT_DIR = override
    expect(new SnapshotStore().root).toBe(override)
  })

  it('explicit root (snapshotDir) beats the env override', () => {
    process.env.DSH_REWIND_SNAPSHOT_DIR = join(tmpdir(), 'override')
    const explicit = join(tmpdir(), 'explicit')
    expect(new SnapshotStore(explicit).root).toBe(explicit)
  })

  it('opts.dshHome (config) beats $DSH_HOME for the default base', () => {
    process.env.DSH_HOME = join(tmpdir(), 'dsh-home-a')
    const configHome = join(tmpdir(), 'dsh-config')
    expect(new SnapshotStore(undefined, { dshHome: configHome }).root).toBe(join(configHome, 'rewind-snapshots'))
  })
})
