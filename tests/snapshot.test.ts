/**
 * Unit tests for the checkpoint store (src/snapshot.ts): disk-backed
 * before-backups grouped by anchor message seq, with real files under a
 * temporary directory — exactly the production restore path.
 */
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
    const states = new Map<string, string | null>()

    expect(await reconcileTracked(store, session, 7, tracked, states)).toBe(1)
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
    const states = new Map<string, string | null>()

    expect(await reconcileTracked(store, session, 7, tracked, states)).toBe(1)
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
    const states = new Map<string, string | null>()

    // First sighting of the path: unconditionally record the current state.
    expect(await reconcileTracked(store, session, 7, tracked, states)).toBe(1)
    // Next boundary: state unchanged → nothing new recorded.
    expect(await reconcileTracked(store, session, 8, tracked, states)).toBe(0)
    // External change → recorded again.
    await writeFile(file, 'externally edited', 'utf8')
    expect(await reconcileTracked(store, session, 9, tracked, states)).toBe(1)
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
    const states = new Map<string, string | null>()
    expect(await reconcileTracked(store, session, 7, tracked, states)).toBe(0)
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
    const states = new Map<string, string | null>()
    expect(await reconcileTracked(store, session, 7, tracked, states)).toBe(1)
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
})
