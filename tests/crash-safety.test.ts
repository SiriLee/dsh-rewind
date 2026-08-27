/**
 * Accident-scenario tests for the checkpoint store's crash safety
 * (src/snapshot.ts). Every scenario injects a crash at a concrete point —
 * a mid-checkpoint-commit, a mid-restore action, a delete, two consecutive
 * crashes — then re-instantiates the store (a host restart) and asserts that
 * journal reconciliation reports / finishes / undoes the op to a consistent
 * state. The properties under test:
 *
 *  - checkpoint commits are ATOMIC: a half-written crash commits nothing;
 *  - restore passes are JOURNALED: intent + per-action done-marks on disk;
 *  - reconcileRestores() reports "restored up to where, what changed" from
 *    the REAL disk (disk is truth, not the marks);
 *  - continueRestore() (补做) finishes an interrupted op deterministically;
 *  - rollbackRestore() (回滚) returns the workspace to the exact pre-restore
 *    state, idempotently across repeated crashes;
 *  - journal corruption is reported fail-loud, journal IO failure is
 *    non-fatal, and journal files never disturb the existing store paths;
 *  - storage stays bounded: terminal journals are recycled by the same
 *    per-commit prune pass that enforces the 100-anchor-group cap, while
 *    crashed (running) and corrupt journals are never destroyed.
 */
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SnapshotStore, type CrashPoint, type RestoreJournal, type RestoreRunOptions } from '../src/snapshot.ts'

let root: string
let store: SnapshotStore
const session = 'session-crash'

const unlink = async (path: string): Promise<void> => {
  await rm(path, { force: true })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-rewind-crash-'))
  store = new SnapshotStore(root)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function touch(rel: string, content: string): Promise<string> {
  const abs = join(root, 'ws', rel)
  await mkdir(join(root, 'ws'), { recursive: true })
  await writeFile(abs, content, 'utf8')
  return abs
}

/**
 * Crash-injection hook: throws at the given (point, index) to simulate a host
 * crash at exactly that spot. `index === undefined` fires on the first match.
 */
function crashAt(point: CrashPoint, index?: number): RestoreRunOptions {
  return {
    crash: (p, i) => {
      if (p === point && (index === undefined || i === index)) throw new Error('simulated host crash')
    },
  }
}

/** Read the session's journal files (tests run at most a few ops per session). */
async function readJournals(store: SnapshotStore, sessionId: string): Promise<RestoreJournal[]> {
  const dir = store.sessionDir(sessionId)
  const names = (await readdir(dir)).filter(n => n.startsWith('restore-journal-') && n.endsWith('.json'))
  return Promise.all(names.map(async name => JSON.parse(await readFile(join(dir, name), 'utf8')) as RestoreJournal))
}

/**
 * The standard multi-action scenario: a (edited), b (edited), c (created) —
 * all backed up before their edits. The anchors are DISTINCT (6/5/4) so
 * `entriesAfter` sorts deterministically (anchorSeq desc) and the restore
 * actions are always [a-restore, b-restore, c-delete] — a crash at a given
 * action index is stable across runs.
 */
async function seedThreeFileScenario(): Promise<{ a: string; b: string; c: string }> {
  const a = await touch('a.txt', 'A0')
  const b = await touch('b.txt', 'B0')
  const c = await touch('c.txt', 'C0')
  await store.recordEntry(session, { callId: 'ca', anchorSeq: 6, path: a, before: 'A0' })
  await store.recordEntry(session, { callId: 'cb', anchorSeq: 5, path: b, before: 'B0' })
  await store.recordEntry(session, { callId: 'cc', anchorSeq: 4, path: c, before: null })
  await writeFile(a, 'A1', 'utf8')
  await writeFile(b, 'B1', 'utf8')
  await writeFile(c, 'C1', 'utf8')
  return { a, b, c }
}

describe('atomic checkpoint commits', () => {
  it('a crash between the temp write and the rename commits nothing', async () => {
    const file = await touch('a.txt', 'original')
    await expect(
      store.recordEntry(session, { callId: 'c1', anchorSeq: 5, path: file, before: 'original' }, crashAt('after-temp-write')),
    ).rejects.toThrow('simulated host crash')

    // No committed entry: the crash left only the inert temp file, and the
    // reader never sees a half-written checkpoint.
    const anchorDir = store.anchorDir(session, 5)
    const names = await readdir(anchorDir)
    expect(names.filter(n => n.endsWith('.json'))).toEqual([])
    expect(names.some(n => n.endsWith('.tmp'))).toBe(true)
    expect(await store.entriesAfter(session, 5)).toEqual([])

    // The next commit of the same call id overwrites the leftover temp and
    // lands the entry atomically.
    await store.recordEntry(session, { callId: 'c1', anchorSeq: 5, path: file, before: 'original' })
    expect(await store.entriesAfter(session, 5)).toHaveLength(1)
    expect(await readdir(anchorDir)).toEqual(['c1.json'])
  })

  it('a planted half-written entry is ignored, never read as a checkpoint', async () => {
    const file = await touch('a.txt', 'original')
    const anchorDir = store.anchorDir(session, 5)
    await mkdir(anchorDir, { recursive: true })
    await writeFile(join(anchorDir, 'c1.json'), '{"callId":"c1","anchorSeq":5,"path":"/x","before":"orig', 'utf8')
    expect(await store.entriesAfter(session, 5)).toEqual([])
  })
})

describe('a crash mid-restore is journaled and reconciled after a host restart', () => {
  it('reports restored/pending from the real disk and continueRestore finishes the op', async () => {
    const { a, b, c } = await seedThreeFileScenario()
    // Crash right after the FIRST action's fs op (a restored on disk, but its
    // done-mark was never persisted): b and c are untouched.
    await expect(store.restoreAfter(session, 3, unlink, undefined, crashAt('after-action', 0))).rejects.toThrow('simulated host crash')
    expect(await readFile(a, 'utf8')).toBe('A0')
    expect(await readFile(b, 'utf8')).toBe('B1')
    expect(await readFile(c, 'utf8')).toBe('C1')

    // Host restart: the journal survives; the report derives from the disk.
    const restarted = new SnapshotStore(root)
    const reports = await restarted.reconcileRestores(session)
    expect(reports).toHaveLength(1)
    const report = reports[0]!
    expect(report.state).toBe('interrupted')
    expect(report.journalState).toBe('running')
    expect([...report.restored].sort()).toEqual([a])
    expect([...report.pending].sort()).toEqual([b, c])
    expect(report.failed).toEqual([])

    // 补做: continueRestore applies exactly what is still pending — the
    // already-restored a is marked done without being rewritten.
    const outcome = await restarted.continueRestore(session, report.opId, unlink)
    expect([...outcome.restored].sort()).toEqual([b])
    expect([...outcome.deleted].sort()).toEqual([c])
    expect(outcome.failed).toEqual([])
    expect(await readFile(a, 'utf8')).toBe('A0')
    expect(await readFile(b, 'utf8')).toBe('B0')
    expect(await store.exists(c)).toBe(false)
    expect(await restarted.reconcileRestores(session)).toEqual([])
  })

  it('rollbackRestore undoes the applied actions to the exact pre-restore state', async () => {
    const { a, b, c } = await seedThreeFileScenario()
    // Crash after the LAST action: all three landed (a restored, b restored,
    // c deleted), but only a and b got their done-marks persisted.
    await expect(store.restoreAfter(session, 3, unlink, undefined, crashAt('after-action', 2))).rejects.toThrow('simulated host crash')
    expect(await readFile(a, 'utf8')).toBe('A0')
    expect(await readFile(b, 'utf8')).toBe('B0')
    expect(await store.exists(c)).toBe(false)

    // The journal pins the per-action progress marks ("逐 action 完成后标记").
    const journal = (await readJournals(store, session))[0]!
    expect(journal.state).toBe('running')
    expect(journal.actions.map(action => action.path)).toEqual([a, b, c])
    expect(journal.actions.map(action => action.done)).toEqual([true, true, false])
    expect(journal.actions.map(action => action.rescue)).toEqual(['A1', 'B1', 'C1'])

    // 回滚: everything is returned to the pre-restore state — including the
    // delete that landed (c comes back) — regardless of the done-marks.
    const restarted = new SnapshotStore(root)
    const rollback = await restarted.rollbackRestore(session, journal.id, unlink)
    expect([...rollback.restored].sort()).toEqual([a, b, c])
    expect(rollback.deleted).toEqual([])
    expect(rollback.failed).toEqual([])
    expect(await readFile(a, 'utf8')).toBe('A1')
    expect(await readFile(b, 'utf8')).toBe('B1')
    expect(await readFile(c, 'utf8')).toBe('C1')
    expect(await restarted.reconcileRestores(session)).toEqual([])
  })
})

describe('a crash around a delete action', () => {
  async function seedSingleDelete(): Promise<string> {
    const c = await touch('c.txt', 'C1')
    await store.recordEntry(session, { callId: 'cc', anchorSeq: 6, path: c, before: null })
    return c
  }

  it('crash before the delete: the file stays and redo removes it', async () => {
    const c = await seedSingleDelete()
    await expect(store.restoreAfter(session, 5, unlink, undefined, crashAt('before-action', 0))).rejects.toThrow('simulated host crash')
    expect(await store.exists(c)).toBe(true)

    const restarted = new SnapshotStore(root)
    const reports = await restarted.reconcileRestores(session)
    expect(reports[0]!.state).toBe('interrupted')
    expect([...reports[0]!.pending]).toEqual([c])
    expect(reports[0]!.restored).toEqual([])

    const outcome = await restarted.continueRestore(session, reports[0]!.opId, unlink)
    expect(outcome.deleted).toEqual([c])
    expect(await store.exists(c)).toBe(false)
    expect(await restarted.reconcileRestores(session)).toEqual([])
  })

  it('crash right after the unlink: the disk already matches and auto-heals', async () => {
    const c = await seedSingleDelete()
    await expect(store.restoreAfter(session, 5, unlink, undefined, crashAt('after-action', 0))).rejects.toThrow('simulated host crash')
    expect(await store.exists(c)).toBe(false)

    // The delete landed but the mark did not; reconcile trusts the disk, so
    // the op is already complete and heals itself — nothing to report.
    const restarted = new SnapshotStore(root)
    const journal = (await readJournals(restarted, session))[0]!
    expect(journal.actions[0]!.done).toBe(false)
    expect(await restarted.reconcileRestores(session)).toEqual([])
    expect((await readJournals(restarted, session))[0]!.state).toBe('completed')
  })
})

describe('two consecutive crashes stay consistent', () => {
  it('redo chain: restore crash -> continue crash -> continue completes', async () => {
    const { a, b, c } = await seedThreeFileScenario()
    // Crash 1: mid-restore after the first action.
    await expect(store.restoreAfter(session, 3, unlink, undefined, crashAt('after-action', 0))).rejects.toThrow('simulated host crash')
    // Crash 2: mid-continue, right after b's restore applied (a was skipped as
    // already matching the target).
    let first: SnapshotStore = new SnapshotStore(root)
    const reports1 = await first.reconcileRestores(session)
    expect(reports1).toHaveLength(1)
    await expect(
      first.continueRestore(session, reports1[0]!.opId, unlink, undefined, crashAt('after-action', 1)),
    ).rejects.toThrow('simulated host crash')

    // After the second crash: a and b already match the target, c is pending.
    const second = new SnapshotStore(root)
    const reports2 = await second.reconcileRestores(session)
    expect(reports2).toHaveLength(1)
    expect([...reports2[0]!.restored].sort()).toEqual([a, b])
    expect([...reports2[0]!.pending]).toEqual([c])

    // Finish: continueRestore completes the op and the disk is consistent.
    const outcome = await second.continueRestore(session, reports2[0]!.opId, unlink)
    expect(outcome.restored).toEqual([])
    expect(outcome.deleted).toEqual([c])
    expect(await readFile(a, 'utf8')).toBe('A0')
    expect(await readFile(b, 'utf8')).toBe('B0')
    expect(await store.exists(c)).toBe(false)
    expect(await second.reconcileRestores(session)).toEqual([])
  })

  it('rollback chain: restore crash -> rollback crash -> rollback finishes', async () => {
    const { a, b, c } = await seedThreeFileScenario()
    // Crash 1: mid-restore after the SECOND action (a and b restored — a
    // marked, b applied-but-unmarked — c untouched, so the op stays
    // reconcilable).
    await expect(store.restoreAfter(session, 3, unlink, undefined, crashAt('after-action', 1))).rejects.toThrow('simulated host crash')
    expect(await readFile(a, 'utf8')).toBe('A0')
    expect(await readFile(b, 'utf8')).toBe('B0')
    expect(await readFile(c, 'utf8')).toBe('C1')
    // Crash 2: mid-rollback right after a was written back to its rescue
    // content — the journal is left in 'rollback-running'.
    let first: SnapshotStore = new SnapshotStore(root)
    const journal = (await readJournals(first, session))[0]!
    const reports1 = await first.reconcileRestores(session)
    expect(reports1).toHaveLength(1)
    await expect(
      first.rollbackRestore(session, journal.id, unlink, undefined, crashAt('after-action', 0)),
    ).rejects.toThrow('simulated host crash')
    expect((await readJournals(first, session))[0]!.state).toBe('rollback-running')

    // After the second crash: a is back at rescue, b is still at the restore
    // target (pending rollback), c was never touched so it trivially matches
    // its rescue — the report says exactly that.
    const second = new SnapshotStore(root)
    const reports2 = await second.reconcileRestores(session)
    expect(reports2).toHaveLength(1)
    expect(reports2[0]!.journalState).toBe('rollback-running')
    expect([...reports2[0]!.restored].sort()).toEqual([a, c])
    expect([...reports2[0]!.pending]).toEqual([b])

    // Finish the rollback: the workspace returns to the exact pre-restore state.
    const outcome = await second.rollbackRestore(session, journal.id, unlink)
    expect([...outcome.restored].sort()).toEqual([b])
    expect(await readFile(a, 'utf8')).toBe('A1')
    expect(await readFile(b, 'utf8')).toBe('B1')
    expect(await readFile(c, 'utf8')).toBe('C1')
    expect(await second.reconcileRestores(session)).toEqual([])
  })
})

describe('reconciliation auto-heal and failure reporting', () => {
  it('a later successful rewind heals the interrupted journal on reconcile', async () => {
    const { a, b, c } = await seedThreeFileScenario()
    await expect(store.restoreAfter(session, 3, unlink, undefined, crashAt('after-action', 0))).rejects.toThrow('simulated host crash')

    // The user just rewinds again: the normal plan re-applies the remaining
    // actions (a already matches, so it is not planned)…
    const restarted = new SnapshotStore(root)
    const outcome = await restarted.restoreAfter(session, 3, unlink)
    expect([...outcome.restored].sort()).toEqual([b])
    expect([...outcome.deleted].sort()).toEqual([c])

    // …and the first reconcile sees the stale journal's goal fully reached:
    // it auto-heals to 'completed' instead of reporting a false interruption
    // (the healing rewind's own journal is 'completed' too).
    expect(await restarted.reconcileRestores(session)).toEqual([])
    const journals = await readJournals(restarted, session)
    expect(journals).toHaveLength(2)
    for (const journal of journals) expect(journal.state).toBe('completed')
  })

  it('a corrupt journal is reported recovery-required, never silently dropped', async () => {
    const sessionDir = store.sessionDir(session)
    await mkdir(sessionDir, { recursive: true })
    await writeFile(join(sessionDir, 'restore-journal-op-broken.json'), '{"version":1,"id":"op-broken","sessionId":"x",', 'utf8')

    const reports = await store.reconcileRestores(session)
    expect(reports).toHaveLength(1)
    expect(reports[0]!.state).toBe('recovery-required')
    expect(reports[0]!.opId).toBe('op-broken')
    expect(reports[0]!.corrupt).toBeDefined()
  })

  it('journal IO failure is non-fatal: the restore still applies everything', async () => {
    const a = await touch('a.txt', 'A0')
    await store.recordEntry(session, { callId: 'ca', anchorSeq: 5, path: a, before: 'A0' })
    await writeFile(a, 'A1', 'utf8')

    // Lock the session dir so the journal temp write fails with EACCES.
    const sessionDir = store.sessionDir(session)
    await chmod(sessionDir, 0o555)
    let blocked = true
    try {
      await writeFile(join(sessionDir, '.probe'), 'x')
      blocked = false
    } catch {
      // Expected: the directory is read-only.
    }
    await chmod(sessionDir, 0o755)
    if (!blocked) return // filesystem without meaningful chmod: nothing to assert

    await chmod(sessionDir, 0o555)
    try {
      const outcome = await store.restoreAfter(session, 5, unlink)
      expect(outcome.restored).toEqual([a])
      expect(outcome.failed).toEqual([])
      expect(await readFile(a, 'utf8')).toBe('A0')
      // No journal could be persisted: the degradation is invisible and the
      // store reports nothing to reconcile.
      expect(await store.reconcileRestores(session)).toEqual([])
    } finally {
      await chmod(sessionDir, 0o755)
    }
  })

  it('journal files never disturb entriesAfter/prune; terminal ones are recycled', async () => {
    const a = await touch('a.txt', 'A0')
    for (let seq = 1; seq <= 3; seq++) {
      await store.recordEntry(session, { callId: `c${seq}`, anchorSeq: seq, path: a, before: 'A0' })
    }
    await writeFile(a, 'A1', 'utf8')
    await store.restoreAfter(session, 1, unlink) // writes a completed journal
    await store.prune(session, 1) // drops anchor groups 1..2

    expect(await store.entriesAfter(session, 1)).toHaveLength(1) // seq 3 kept
    expect(await store.reconcileRestores(session)).toEqual([])
    // The completed journal was recycled by the prune pass: journal files
    // never confuse planning, and the storage cap now bounds them too.
    expect((await readdir(store.sessionDir(session))).some(n => n.startsWith('restore-journal-'))).toBe(false)

    // A second restore still works.
    await writeFile(a, 'A2', 'utf8')
    const outcome = await store.restoreAfter(session, 1, unlink)
    expect(outcome.restored).toEqual([a])
    expect(await readFile(a, 'utf8')).toBe('A0')
  })

  it('repeated restores recycle terminal journals (bounded storage)', async () => {
    const a = await touch('a.txt', 'A0')
    await store.recordEntry(session, { callId: 'ca', anchorSeq: 5, path: a, before: 'A0' })
    for (let round = 1; round <= 4; round++) {
      await writeFile(a, `A${round}`, 'utf8')
      await store.restoreAfter(session, 5, unlink) // one completed journal each
      expect(await readFile(a, 'utf8')).toBe('A0')
    }
    // Every pass recycled the earlier terminal journals: at most the newest
    // one survives, never one journal per rewind.
    expect((await readdir(store.sessionDir(session))).filter(n => n.startsWith('restore-journal-'))).toHaveLength(1)
    expect(await store.reconcileRestores(session)).toEqual([])
  })

  it('prune recycles completed journals but keeps crashed (running) ones', async () => {
    const a = await touch('a.txt', 'A0')
    await store.recordEntry(session, { callId: 'ca', anchorSeq: 5, path: a, before: 'A0' })
    await writeFile(a, 'A1', 'utf8')
    // A crashed restore leaves a running journal…
    await expect(store.restoreAfter(session, 5, unlink, undefined, crashAt('before-action', 0))).rejects.toThrow('simulated host crash')
    // …then a normal restore completes a second one (beginRestore keeps the
    // running journal — only terminal journals are recycled).
    await store.restoreAfter(session, 5, unlink)

    const journalNames = async () => (await readdir(store.sessionDir(session))).filter(n => n.startsWith('restore-journal-'))
    expect(await journalNames()).toHaveLength(2)
    await store.prune(session, 1)
    expect(await journalNames()).toHaveLength(1) // completed recycled, running kept
    const kept = (await readJournals(store, session))[0]!
    expect(kept.state).toBe('running')
    // The surviving crashed op is still reconcilable; since the later normal
    // restore already reached the same target on disk, reconcile auto-heals
    // it to 'completed' instead of reporting a false interruption.
    expect(await store.reconcileRestores(session)).toEqual([])
    expect((await readJournals(store, session))[0]!.state).toBe('completed')
  })

  it('corrupt journals are never recycled', async () => {
    const sessionDir = store.sessionDir(session)
    await mkdir(sessionDir, { recursive: true })
    await writeFile(join(sessionDir, 'restore-journal-op-broken.json'), '{"version":1,"id":"op-broken","sessionId":"x",', 'utf8')
    await store.prune(session, 1)
    // An unclassifiable journal is kept: destroying it could erase the only
    // recovery record of an interrupted restore.
    expect(await store.reconcileRestores(session)).toHaveLength(1)
  })
})
