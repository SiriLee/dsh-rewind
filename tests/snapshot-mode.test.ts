/**
 * Permission-bit tests for the checkpoint store (src/snapshot.ts, ADR-9/R3).
 *
 * `mode` is recorded at capture time and applied ONLY as part of a content
 * restore — a mode-only difference must never plan one (the plugin's contract
 * is "content is what a rewind restores"). A read-only target has to be
 * writable for the restore to land at all, so the store widens it for the
 * write and puts the recorded bits back afterwards; a rollback uses the
 * pre-restore bits it captured as `rescueMode`.
 *
 * The tests skip themselves on a filesystem where chmod does not take effect
 * (e.g. a Windows mount), because there is no permission state to assert.
 */
import { chmod, mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultProbe, SnapshotStore } from '../src/snapshot.ts'

let root: string
let store: SnapshotStore
const session = 'session-mode'

const unlink = async (path: string): Promise<void> => {
  await rm(path, { force: true })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-rewind-mode-'))
  store = new SnapshotStore(root)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function touch(rel: string, content: string, mode?: number): Promise<string> {
  const abs = join(root, 'ws', rel)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, content, 'utf8')
  if (mode !== undefined) await chmod(abs, mode)
  return abs
}

/** True when this filesystem actually honours chmod. */
async function chmodSupported(path: string): Promise<boolean> {
  await chmod(path, 0o600)
  return ((await stat(path)).mode & 0o7777) === 0o600
}

const modeOf = async (path: string): Promise<number> => (await stat(path)).mode & 0o7777

/** Capture a file the way the host does, with an explicit recorded mode. */
async function captureWithMode(callId: string, anchorSeq: number, live: string, mode?: number): Promise<void> {
  const staged = await store.stageCapture(session, callId)
  const copied = await defaultProbe.copy(live, staged)
  if (copied.kind !== 'copied') throw new Error('capture failed')
  await store.recordBackup(session, { callId, anchorSeq, path: live },
    { file: staged, size: copied.size, ...(mode !== undefined ? { mode } : {}) })
}

describe('file mode on restore', () => {
  it('applies the recorded mode together with the restored content', async () => {
    const live = await touch('mode.txt', 'A0', 0o644)
    if (!await chmodSupported(live)) return // filesystem without permission bits

    await captureWithMode('c1', 5, live, 0o640)
    await chmod(live, 0o600)
    await writeFile(live, 'A1', 'utf8')

    const outcome = await store.restoreAfter(session, 5, unlink)
    expect(outcome.restored).toEqual([live])
    expect(await readFile(live, 'utf8')).toBe('A0')
    expect(await modeOf(live)).toBe(0o640)
  })

  it('never plans a restore for a mode-only difference', async () => {
    const live = await touch('mode-only.txt', 'same', 0o644)
    if (!await chmodSupported(live)) return

    await captureWithMode('c1', 5, live, 0o644)
    await chmod(live, 0o600) // the user's own chmod, same content

    expect(await store.impactsAfter(session, 5)).toEqual([])
    const outcome = await store.restoreAfter(session, 5, unlink)
    expect(outcome).toEqual({ restored: [], deleted: [], skipped: [], failed: [] })
    // The live permission change is left alone (ADR-9: content is the contract).
    expect(await modeOf(live)).toBe(0o600)
  })

  it('restores a READ-ONLY target and puts its mode back (R3)', async () => {
    const live = await touch('readonly.txt', 'A0', 0o644)
    if (!await chmodSupported(live)) return

    await captureWithMode('c1', 5, live, 0o444)
    await writeFile(live, 'A1', 'utf8')
    await chmod(live, 0o444)

    const outcome = await store.restoreAfter(session, 5, unlink)
    expect(outcome.restored).toEqual([live])
    expect(outcome.failed).toEqual([])
    expect(await readFile(live, 'utf8')).toBe('A0')
    expect(await modeOf(live)).toBe(0o444)
  })

  it('rolls back to the pre-restore mode it captured', async () => {
    const live = await touch('rollback-mode.txt', 'A1', 0o644)
    if (!await chmodSupported(live)) return

    // Recorded before-state: content 'A1' with mode 0o644.
    await captureWithMode('c1', 5, live, 0o644)
    // The pre-restore state a rollback must restore exactly: another content
    // and the user's own (more restrictive) mode.
    await writeFile(live, 'A2', 'utf8')
    await chmod(live, 0o600)

    await expect(store.restoreAfter(session, 5, unlink, undefined, {
      crash: (point) => {
        if (point === 'after-action') throw new Error('simulated host crash')
      },
    })).rejects.toThrow('simulated host crash')
    // The restore landed content + mode, but crashed before its done-mark.
    expect(await readFile(live, 'utf8')).toBe('A1')
    expect(await modeOf(live)).toBe(0o644)

    // Roll back by op id straight from the journal file (reconciliation would
    // auto-heal the op, since its goal already matches the disk).
    const journalName = (await readdir(store.sessionDir(session))).find(name => name.startsWith('journal-'))
    if (journalName === undefined) throw new Error('expected a journal')
    const opId = journalName.slice('journal-'.length, -'.json'.length)
    const rollback = await store.rollbackRestore(session, opId, unlink)
    expect(rollback.restored).toEqual([live])
    expect(await readFile(live, 'utf8')).toBe('A2')
    expect(await modeOf(live)).toBe(0o600)
  })

  it('leaves the live mode alone for a legacy entry with no recorded mode', async () => {
    const live = await touch('legacy-mode.txt', 'A1', 0o644)
    if (!await chmodSupported(live)) return

    await mkdir(store.anchorDir(session, 5), { recursive: true })
    await writeFile(join(store.anchorDir(session, 5), 'legacy.json'), JSON.stringify({
      callId: 'legacy', anchorSeq: 5, path: live, before: 'A0', time: 1,
    }), 'utf8')
    await chmod(live, 0o600)

    const outcome = await store.restoreAfter(session, 5, unlink)
    expect(outcome.restored).toEqual([live])
    expect(await readFile(live, 'utf8')).toBe('A0')
    expect(await modeOf(live)).toBe(0o600)
  })
})
