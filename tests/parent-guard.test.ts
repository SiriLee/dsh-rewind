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
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
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
async function rawJournal(): Promise<{ actions: Record<string, unknown>[] }> {
  const name = (await readdir(join(root, session))).find(file => file.startsWith('journal-'))!
  return JSON.parse(await readFile(join(root, session, name), 'utf8')) as { actions: Record<string, unknown>[] }
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
