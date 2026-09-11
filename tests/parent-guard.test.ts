/**
 * Location-pin tests for the checkpoint store (src/snapshot.ts): every entry,
 * dedup link and journal action records the `realpath` of the tracked file's
 * parent directory at checkpoint time. A restore then refuses a path whose
 * directory no longer resolves there, because only the FINAL component of a
 * tracked path is link-checked — a repointed ancestor directory would otherwise
 * redirect the write (or the unlink) outside the recorded location.
 *
 * These cases pin the persisted field (the on-disk `parent` key, its absence
 * when the parent cannot be resolved, and its survival through prune
 * materialization); the enforcement cases live beside them.
 */
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultProbe, isLinkEntry, SnapshotStore } from '../src/snapshot.ts'

let root: string
let store: SnapshotStore
const session = 'session-parent'

const unlink = async (path: string): Promise<void> => {
  await rm(path, { force: true })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-rewind-parent-'))
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

/** Capture one file exactly the way the host does (staged byte copy, commit). */
async function captureAndRecord(callId: string, anchorSeq: number, live: string): Promise<void> {
  const staged = await store.stageCapture(session, callId)
  const copied = await defaultProbe.copy(live, staged)
  if (copied.kind === 'failed') throw new Error(copied.message)
  await store.recordBackup(session, { callId, anchorSeq, path: live },
    copied.kind === 'absent' ? null : { file: staged, size: copied.size })
}

/** The single entry file of an anchor group, parsed as raw JSON. */
async function rawEntry(anchorSeq: number): Promise<Record<string, unknown>> {
  const dir = store.anchorDir(session, anchorSeq)
  const name = (await readdir(dir)).find(file => file.endsWith('.json'))!
  return JSON.parse(await readFile(join(dir, name), 'utf8')) as Record<string, unknown>
}

/** The single journal file of the session, parsed as raw JSON. */
async function rawJournal(): Promise<{ state?: string; actions: Record<string, unknown>[] }> {
  const name = (await readdir(join(root, session))).find(file => file.startsWith('journal-'))!
  return JSON.parse(await readFile(join(root, session, name), 'utf8')) as { state?: string; actions: Record<string, unknown>[] }
}

describe('location pin', () => {
  it('records the checkpoint-time parent realpath on the entry and on disk', async () => {
    const live = await touch('pinned/f.txt', 'before')
    await captureAndRecord('c1', 5, live)

    const expected = await realpath(dirname(live))
    const [entry] = await store.entriesAfter(session, 0)
    expect(entry?.parent).toBe(expected)
    // The on-disk field name is a durable contract, not an implementation detail.
    expect((await rawEntry(5)).parent).toBe(expected)
  })

  it('records no pin for a path whose parent cannot be resolved', async () => {
    const ghost = join(root, 'does-not-exist', 'f.txt')
    await store.recordBackup(session, { callId: 'c2', anchorSeq: 6, path: ghost }, null)

    const [entry] = await store.entriesAfter(session, 0)
    expect(entry?.path).toBe(ghost)
    expect(entry?.parent).toBeUndefined()
    expect(await rawEntry(6)).not.toHaveProperty('parent')
  })

  it('ignores a malformed pin and treats the entry as unpinned', async () => {
    const live = await touch('malformed/f.txt', 'x')
    await mkdir(store.anchorDir(session, 7), { recursive: true })
    await writeFile(join(store.anchorDir(session, 7), 'e.json'), JSON.stringify({
      store: 2, callId: 'c3', file: live, blob: 'e.before', size: 1, parent: 42, time: 1,
    }), 'utf8')
    await writeFile(join(store.anchorDir(session, 7), 'e.before'), 'x', 'utf8')

    const [entry] = await store.entriesAfter(session, 0)
    expect(entry?.path).toBe(live)
    expect(entry?.parent).toBeUndefined()
  })

  it('pins a dedup link and keeps the pin when prune materializes it', async () => {
    const live = await touch('link/f.txt', 'same')
    await captureAndRecord('l1', 1, live)
    await captureAndRecord('l2', 2, live) // identical content → a link entry

    const links = await store.entriesAfter(session, 0)
    expect(links.map(isLinkEntry)).toEqual([true, false])
    expect(links[0]?.parent).toBe(await realpath(dirname(live)))

    await store.prune(session, 1) // drops group 1, materializes the surviving link
    const after = await store.entriesAfter(session, 0)
    expect(after).toHaveLength(1)
    expect(isLinkEntry(after[0]!)).toBe(false)
    expect(after[0]?.parent).toBe(await realpath(dirname(live)))
  })

  it('keeps the pin when prune materializes a creation link', async () => {
    await mkdir(join(root, 'ws'), { recursive: true })
    const ghost = join(root, 'ws', 'ghost.txt') // never exists on disk
    await store.recordBackup(session, { callId: 'g1', anchorSeq: 1, path: ghost }, null)
    await store.recordBackup(session, { callId: 'g2', anchorSeq: 2, path: ghost }, null)

    const links = await store.entriesAfter(session, 0)
    expect(links.map(isLinkEntry)).toEqual([true, false])

    await store.prune(session, 1) // drops group 1, materializes the creation link
    const after = await store.entriesAfter(session, 0)
    expect(after).toHaveLength(1)
    const materialized = after[0]!
    if (isLinkEntry(materialized)) throw new Error('expected a materialized real snapshot')
    expect(materialized.before).toBeNull()
    expect(materialized.parent).toBe(await realpath(join(root, 'ws')))

    // The materialized creation still refuses a repointed ancestor, so its
    // delete cannot escape through a link either.
    const { outside } = await repoint(dirname(ghost), 'ghost.txt')
    const outcome = await store.restoreAfter(session, 1, unlink)
    expect(outcome.skipped).toEqual([ghost])
    expect(await readFile(join(outside, 'ghost.txt'), 'utf8')).toBe('decoy')
  })

  it('carries the pin into every journal action', async () => {
    const live = await touch('journal/f.txt', 'before')
    await captureAndRecord('j1', 5, live)
    await writeFile(live, 'after', 'utf8')

    const outcome = await store.restoreAfter(session, 5, unlink)
    expect(outcome.restored).toEqual([live])

    const actions = (await rawJournal()).actions
    expect(actions).toHaveLength(1)
    expect(actions[0]?.path).toBe(live)
    expect(actions[0]?.parent).toBe(await realpath(dirname(live)))
  })
})

/** Replace `dir` with a symlink to a fresh directory holding `decoy`. */
async function repoint(dir: string, decoyName?: string): Promise<{ outside: string; moved: string }> {
  const moved = `${dir}-real`
  await rename(dir, moved)
  const outside = join(root, 'outside', moved.slice(root.length).replace(/[^a-zA-Z0-9]+/g, '_'))
  await mkdir(outside, { recursive: true })
  if (decoyName !== undefined) await writeFile(join(outside, decoyName), 'decoy', 'utf8')
  await symlink(outside, dir, 'dir')
  return { outside, moved }
}

describe('repointed ancestor directory', () => {
  it('refuses the restore and leaves the outside file alone', async () => {
    const live = await touch('dir/f.txt', 'before')
    await captureAndRecord('r1', 5, live)
    await writeFile(live, 'edited', 'utf8')

    const { outside, moved } = await repoint(dirname(live), 'f.txt')
    await writeFile(live, 'edited', 'utf8') // lands through the link, in `outside`

    // The preview must not promise a restore the apply pass will refuse.
    await expect(store.impactsAfter(session, 5)).resolves.toEqual([])
    const outcome = await store.restoreAfter(session, 5, unlink)
    expect(outcome).toEqual({ restored: [], deleted: [], skipped: [live], failed: [] })
    // The recorded file is untouched (still the model's post-edit bytes) and
    // the outside decoy was neither overwritten nor read as the target.
    expect(await readFile(join(outside, 'f.txt'), 'utf8')).toBe('edited')
    expect(await readFile(join(moved, 'f.txt'), 'utf8')).toBe('edited')
  })

  it('refuses a creation delete through a repointed ancestor', async () => {
    // The sharpest case: the record says "was created", so the restore wants to
    // UNLINK the path — through the link that would delete an outside file the
    // model never wrote.
    const live = await touch('newdir/created.txt', 'created')
    await store.recordBackup(session, { callId: 'r2', anchorSeq: 5, path: live }, null)

    const { outside } = await repoint(dirname(live), 'created.txt')
    const outcome = await store.restoreAfter(session, 5, unlink)
    expect(outcome.skipped).toEqual([live])
    expect(await readFile(join(outside, 'created.txt'), 'utf8')).toBe('decoy')
  })

  it('still restores through a STABLE symlinked ancestor', async () => {
    // A symlinked workspace (or temp) root is normal: both the pin and the
    // check are `realpath`s, so it must never be a false skip.
    const real = join(root, 'ws', 'real')
    await mkdir(real, { recursive: true })
    await writeFile(join(real, 'f.txt'), 'before', 'utf8')
    const link = join(root, 'ws', 'linked')
    await symlink(real, link, 'dir')
    const live = join(link, 'f.txt')

    await captureAndRecord('s1', 5, live)
    await writeFile(live, 'after', 'utf8')

    const outcome = await store.restoreAfter(session, 5, unlink)
    expect(outcome).toEqual({ restored: [live], deleted: [], skipped: [], failed: [] })
    expect(await readFile(join(real, 'f.txt'), 'utf8')).toBe('before')
  })

  it('still recreates a deleted parent directory', async () => {
    const live = await touch('gone/f.txt', 'before')
    await captureAndRecord('g1', 5, live)
    await rm(dirname(live), { recursive: true, force: true })

    const outcome = await store.restoreAfter(session, 5, unlink)
    expect(outcome).toEqual({ restored: [live], deleted: [], skipped: [], failed: [] })
    expect(await readFile(live, 'utf8')).toBe('before')
  })

  it('refuses when a deleted parent is replaced by a symlink', async () => {
    const live = await touch('swap/f.txt', 'before')
    await captureAndRecord('w1', 5, live)
    await rm(dirname(live), { recursive: true, force: true })

    const outside = join(root, 'outside-created')
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'f.txt'), 'decoy', 'utf8')
    await symlink(outside, dirname(live), 'dir')

    const outcome = await store.restoreAfter(session, 5, unlink)
    expect(outcome.skipped).toEqual([live])
    expect(await readFile(join(outside, 'f.txt'), 'utf8')).toBe('decoy')
  })

  it('does not mistake a directory named "..foo" for an escape', async () => {
    // The containment predicate must accept a legitimate `..`-prefixed name;
    // only a real `..` segment means the recorded location escaped the pin.
    const dir = join(root, 'ws', '..foo')
    await mkdir(dir, { recursive: true })
    const live = join(dir, 'f.txt')
    await writeFile(live, 'before', 'utf8')
    await captureAndRecord('d1', 5, live)
    await rm(dir, { recursive: true, force: true })

    const outcome = await store.restoreAfter(session, 5, unlink)
    expect(outcome).toEqual({ restored: [live], deleted: [], skipped: [], failed: [] })
    expect(await readFile(live, 'utf8')).toBe('before')
  })

  it('keeps an unpinned (legacy) entry working', async () => {
    // Entries written before the pin existed have no location to verify; they
    // keep the released final-component behavior instead of being refused.
    const live = await touch('legacy/f.txt', 'before')
    await mkdir(store.anchorDir(session, 5), { recursive: true })
    await writeFile(join(store.anchorDir(session, 5), 'legacy.before'), 'before', 'utf8')
    await writeFile(join(store.anchorDir(session, 5), 'legacy.json'), JSON.stringify({
      store: 2, callId: 'legacy', file: live, blob: 'legacy.before', size: 6, time: 1,
    }), 'utf8')
    await writeFile(live, 'after', 'utf8')

    const outcome = await store.restoreAfter(session, 5, unlink)
    expect(outcome.restored).toEqual([live])
    expect(await readFile(live, 'utf8')).toBe('before')
  })

  it('refuses a continue after the ancestor moved, and keeps the op open', async () => {
    const live = await touch('cont/f.txt', 'before')
    await captureAndRecord('k1', 5, live)
    await writeFile(live, 'edited', 'utf8')

    // Crash before the first fs op: the journal stays `running` with the action
    // pending, which is exactly the post-restart state.
    await expect(store.restoreAfter(session, 5, unlink, defaultProbe, {
      crash: point => { if (point === 'before-action') throw new Error('crash') },
    })).rejects.toThrow('crash')

    const { outside } = await repoint(dirname(live), 'f.txt')
    await writeFile(live, 'edited', 'utf8')

    const opId = (await readdir(join(root, session))).find(name => name.startsWith('journal-'))!
      .slice('journal-'.length, -'.json'.length)
    const outcome = await store.continueRestore(session, opId, unlink)
    expect(outcome.restored).toEqual([])
    expect(outcome.failed.map(entry => entry.path)).toEqual([live])
    expect(outcome.failed[0]?.message).toMatch(/moved or repointed/)
    expect(await readFile(join(outside, 'f.txt'), 'utf8')).toBe('edited')
    // Not done, not completed: the op is still outstanding.
    expect((await rawJournal()).state).toBe('running')
  })

  it('refuses a rollback after the ancestor moved, and asks for recovery', async () => {
    const live = await touch('roll/f.txt', 'before')
    await captureAndRecord('b1', 5, live)
    await writeFile(live, 'edited', 'utf8')

    await expect(store.restoreAfter(session, 5, unlink, defaultProbe, {
      crash: point => { if (point === 'before-action') throw new Error('crash') },
    })).rejects.toThrow('crash')

    const { outside } = await repoint(dirname(live), 'f.txt')
    // Differ from the rescue bytes too, otherwise the rollback would (correctly)
    // report the path as already back at its pre-restore state.
    await writeFile(live, 'changed-outside', 'utf8')

    const opId = (await readdir(join(root, session))).find(name => name.startsWith('journal-'))!
      .slice('journal-'.length, -'.json'.length)
    const outcome = await store.rollbackRestore(session, opId, unlink)
    expect(outcome.failed.map(entry => entry.path)).toEqual([live])
    expect(await readFile(join(outside, 'f.txt'), 'utf8')).toBe('changed-outside')
    // A rollback that could not undo the path must not claim to be rolled back.
    expect((await rawJournal()).state).toBe('recovery-required')
  })
})
