/**
 * Checkpoint store tests: dense per-message manifests, shared versions, the
 * retention window, load/orphan cleanup and the fail-closed metadata rules.
 * Everything runs against real files under a temporary directory.
 */
import { link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkpointFileName, parseCheckpoint, type Checkpoint } from '../src/snapshot-format.ts'
import { SnapshotStore, UnknownStoreVersionError, type StoreSession } from '../src/snapshot.ts'

let root: string
let ws: string
let storeRoot: string
let store: SnapshotStore
const sessionId = 'checkpoint-session'
const posixOnly = process.platform !== 'win32'

const view = (messageIds: readonly string[], version = 4): StoreSession => ({
  id: sessionId,
  version,
  messageIds,
})

async function touch(rel: string, content: string | Buffer): Promise<string> {
  const path = join(ws, rel)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content)
  return path
}

async function checkpoint(messageIds: readonly string[], version = 4): Promise<void> {
  const result = await store.createCheckpoints(sessionId, version, messageIds)
  expect(result.warnings).toEqual([])
}

async function readCheckpoint(messageId: string): Promise<Checkpoint> {
  const raw = JSON.parse(await readFile(join(storeRoot, sessionId, 'checkpoints', checkpointFileName(messageId)), 'utf8')) as unknown
  const parsed = parseCheckpoint(raw)
  if (parsed === undefined) throw new Error(`invalid checkpoint ${messageId}`)
  return parsed
}

async function checkpointFiles(): Promise<string[]> {
  return (await readdir(join(storeRoot, sessionId, 'checkpoints'))).filter(name => name.endsWith('.json')).sort()
}

async function versionFiles(): Promise<string[]> {
  return (await readdir(join(storeRoot, sessionId, 'versions')).catch(() => [] as string[])).sort()
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-rewind-checkpoint-'))
  ws = join(root, 'ws')
  storeRoot = join(root, 'store')
  await mkdir(ws, { recursive: true })
  store = new SnapshotStore(storeRoot)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('checkpoint creation', () => {
  it('writes one dense manifest per message and makes the last current', async () => {
    await store.loadSession(view(['m1', 'm2']))
    await checkpoint(['m1', 'm2'])
    expect(await checkpointFiles()).toHaveLength(2)
    expect((await readCheckpoint('m1')).files).toEqual({})
    expect((await readCheckpoint('m2')).files).toEqual({})

    const file = await touch('a.txt', 'one')
    const first = await store.captureFirstTouch(sessionId, file)
    expect(first.recorded).toBe(true)
    const m2 = await readCheckpoint('m2')
    expect(m2.files[file]).toMatchObject({ v: 1, blob: expect.stringMatching(/^[0-9a-f]{16}@v1$/), size: 3 })
    expect((await readCheckpoint('m1')).files).toEqual({})
  })

  it('records a first touch only once', async () => {
    await store.loadSession(view(['m1']))
    await checkpoint(['m1'])
    const file = await touch('a.txt', 'one')
    expect((await store.captureFirstTouch(sessionId, file)).recorded).toBe(true)
    expect((await store.captureFirstTouch(sessionId, file)).recorded).toBe(false)
    expect(Object.keys((await readCheckpoint('m1')).files)).toEqual([file])
    expect(await versionFiles()).toHaveLength(1)
  })

  it('records an absent file as a null v1 row', async () => {
    await store.loadSession(view(['m1']))
    await checkpoint(['m1'])
    const file = join(ws, 'created.txt')
    expect((await store.captureFirstTouch(sessionId, file)).recorded).toBe(true)
    expect((await readCheckpoint('m1')).files[file]).toMatchObject({ v: 1, blob: null })
    expect(await versionFiles()).toHaveLength(0)
  })

  it('rechecks tracked files at the next boundary and reuses unchanged versions', async () => {
    await store.loadSession(view(['m1']))
    await checkpoint(['m1'])
    const file = await touch('a.txt', 'one')
    await store.captureFirstTouch(sessionId, file)

    await checkpoint(['m2'])
    const m2 = await readCheckpoint('m2')
    expect(m2.files[file]).toMatchObject({ v: 1, blob: expect.stringMatching(/@v1$/) })

    await writeFile(file, 'two')
    await checkpoint(['m3'])
    const m3 = await readCheckpoint('m3')
    expect(m3.files[file]).toMatchObject({ v: 2, blob: expect.stringMatching(/@v2$/), size: 3 })
    expect(await versionFiles()).toHaveLength(2)
  })

  it('keeps the previous row when a tracked file grows over the cap', async () => {
    store = new SnapshotStore(storeRoot, { maxFileBytes: 4 })
    await store.loadSession(view(['m1']))
    await checkpoint(['m1'])
    const file = await touch('a.txt', 'ok')
    await store.captureFirstTouch(sessionId, file)
    const before = (await readCheckpoint('m1')).files[file]
    await writeFile(file, 'too large')
    await checkpoint(['m2'])
    expect((await readCheckpoint('m2')).files[file]).toEqual(before)
    expect((await store.preview(sessionId, 'm2')).uncovered).toEqual([{ path: file, size: 9 }])
  })

  it('returns actions and uncovered paths from one preview call', async () => {
    store = new SnapshotStore(storeRoot, { maxFileBytes: 4 })
    await store.loadSession(view(['m1', 'm2']))
    await checkpoint(['m1'])
    const changed = await touch('changed.txt', 'ok')
    const big = await touch('big.txt', 'ok')
    await store.captureFirstTouch(sessionId, changed)
    await store.captureFirstTouch(sessionId, big)
    await checkpoint(['m2'])
    await writeFile(changed, 'new')
    await writeFile(big, 'too large')

    const preview = await store.preview(sessionId, 'm2')
    expect(preview.files).toEqual([{ path: changed, action: 'restore' }])
    expect(preview.uncovered).toEqual([{ path: big, size: 9 }])
  })

  it('does not track a file first seen over the cap', async () => {
    store = new SnapshotStore(storeRoot, { maxFileBytes: 4 })
    await store.loadSession(view(['m1']))
    await checkpoint(['m1'])
    const file = await touch('big.txt', 'too large')
    expect((await store.captureFirstTouch(sessionId, file)).recorded).toBe(false)
    await checkpoint(['m2'])
    expect((await readCheckpoint('m2')).files).toEqual({})
    expect((await store.preview(sessionId, 'm2')).uncovered).toEqual([])
  })

  it.runIf(posixOnly)('does not follow a symlink planted at a JSON temp name', async () => {
    await store.loadSession(view(['m1']))
    const dir = join(storeRoot, sessionId, 'checkpoints')
    await mkdir(dir, { recursive: true })
    const victim = join(root, 'victim.json')
    await writeFile(victim, 'victim', 'utf8')
    await symlink(victim, join(dir, `${checkpointFileName('m1')}.tmp`))
    await checkpoint(['m1'])
    expect(await readFile(victim, 'utf8')).toBe('victim')
    expect(await readCheckpoint('m1')).toBeDefined()
  })

  it('abandons the current checkpoint when a batch cannot be written', async () => {
    await store.loadSession(view(['m1']))
    await checkpoint(['m1'])
    const file = await touch('a.txt', 'one')
    await store.captureFirstTouch(sessionId, file)
    // Make the next manifest write fail after the current reference was set.
    const checkpoints = join(storeRoot, sessionId, 'checkpoints')
    await rm(checkpoints, { recursive: true, force: true })
    await writeFile(checkpoints, 'not a directory')
    await expect(store.createCheckpoints(sessionId, 4, ['m2'])).rejects.toThrow()
    const later = join(ws, 'later.txt')
    await writeFile(later, 'two')
    expect((await store.captureFirstTouch(sessionId, later)).recorded).toBe(false)
  })

  it('does not track hard links', async () => {
    await store.loadSession(view(['m1']))
    await checkpoint(['m1'])
    const hard = join(ws, 'hard.txt')
    await writeFile(hard, 'two')
    const hardLink = join(ws, 'hard-link.txt')
    await link(hard, hardLink)
    expect((await store.captureFirstTouch(sessionId, hardLink)).recorded).toBe(false)
    expect(await readCheckpoint('m1').then(cp => cp.files)).toEqual({})
  })

  it.runIf(posixOnly)('does not track symlinks', async () => {
    await store.loadSession(view(['m1']))
    await checkpoint(['m1'])
    const target = await touch('target.txt', 'one')
    const symlinkPath = join(ws, 'link.txt')
    await symlink(target, symlinkPath)
    expect((await store.captureFirstTouch(sessionId, symlinkPath)).recorded).toBe(false)
    expect(await readCheckpoint('m1').then(cp => cp.files)).toEqual({})
  })
})

describe('load and retention', () => {
  it('drops manifests whose message is no longer in the session log', async () => {
    await store.loadSession(view(['m1', 'm2']))
    await checkpoint(['m1', 'm2'])
    expect(await checkpointFiles()).toHaveLength(2)
    const reopened = new SnapshotStore(storeRoot)
    const result = await reopened.loadSession(view(['m1']))
    expect(result.warnings).toEqual([])
    expect(await checkpointFiles()).toHaveLength(1)
    expect(await readCheckpoint('m1')).toBeDefined()
  })

  it('drops and records a corrupt manifest', async () => {
    await store.loadSession(view(['m1', 'm2']))
    await checkpoint(['m1', 'm2'])
    const file = join(storeRoot, sessionId, 'checkpoints', checkpointFileName('m2'))
    await writeFile(file, '{', 'utf8')
    const reopened = new SnapshotStore(storeRoot)
    const result = await reopened.loadSession(view(['m1', 'm2']))
    expect(result.warnings.some(warning => warning.includes('corrupt checkpoint') && warning.includes('discarded'))).toBe(true)
    await expect(stat(file)).rejects.toThrow()
    expect(await readdir(join(storeRoot, sessionId, 'checkpoints'))).toHaveLength(1)
  })

  it('retains only the newest 100 manifests', async () => {
    const ids = Array.from({ length: 101 }, (_, index) => `m${index + 1}`)
    await store.loadSession(view(ids))
    await checkpoint(ids)
    expect(await checkpointFiles()).toHaveLength(100)
    await expect(readCheckpoint('m1')).rejects.toThrow()
    expect(await readCheckpoint('m101')).toBeDefined()
  })

  it('deletes a version once no retained manifest references it', async () => {
    await store.loadSession(view(['m1']))
    await checkpoint(['m1'])
    const file = await touch('a.txt', 'one')
    await store.captureFirstTouch(sessionId, file)
    await writeFile(file, 'two')
    const ids = Array.from({ length: 100 }, (_, index) => `n${index + 1}`)
    const all = ['m1', ...ids]
    for (const id of ids) await checkpoint([id])
    // m1 is evicted; the 100 newer manifests all point at v2.
    expect(await versionFiles()).toHaveLength(1)
    expect((await readCheckpoint('n100')).files[file]).toMatchObject({ v: 2 })
    // Loading with the full log keeps the same window.
    const reopened = new SnapshotStore(storeRoot)
    await reopened.loadSession(view(all))
    expect(await versionFiles()).toHaveLength(1)
  })

  it('ignores a legacy layout without reading it', async () => {
    await mkdir(join(storeRoot, sessionId, '5'), { recursive: true })
    await writeFile(join(storeRoot, sessionId, '5', 'call.json'), '{"callId":"c"}', 'utf8')
    await writeFile(join(storeRoot, sessionId, 'journal-op.json'), '{}', 'utf8')
    const result = await store.loadSession(view(['m1']))
    expect(result.warnings.some(warning => warning.includes('legacy snapshot data ignored'))).toBe(true)
    await expect(stat(join(storeRoot, sessionId, '5', 'call.json'))).resolves.toBeDefined()
    expect(await store.restoreAfter(sessionId, 'm1')).toMatchObject({ noCheckpoint: true, restored: [], deleted: [] })
  })

  it('creates new storage alongside legacy data without touching it', async () => {
    const legacy = join(storeRoot, sessionId, '5')
    await mkdir(legacy, { recursive: true })
    await writeFile(join(legacy, 'call.json'), '{}', 'utf8')
    await store.loadSession(view(['m1']))
    await checkpoint(['m1'])
    await expect(stat(join(legacy, 'call.json'))).resolves.toBeDefined()
    await expect(stat(join(storeRoot, sessionId, 'meta.json'))).resolves.toBeDefined()
    await expect(stat(join(storeRoot, sessionId, 'checkpoints'))).resolves.toBeDefined()
  })

  it('treats a different session id as an empty store', async () => {
    await store.loadSession(view(['m1']))
    await checkpoint(['m1'])
    const other = new SnapshotStore(storeRoot)
    await other.loadSession({ id: 'other-session', version: 4, messageIds: ['m1'] })
    expect(await other.restoreAfter('other-session', 'm1')).toMatchObject({ noCheckpoint: true })
    await expect(stat(join(storeRoot, 'other-session'))).rejects.toThrow()
  })

  it('discards a lower store format with a store-specific warning', async () => {
    const dir = join(storeRoot, sessionId)
    await mkdir(dir, { recursive: true })
    const meta = join(dir, 'meta.json')
    await writeFile(meta, JSON.stringify({ store: 2, sessionFormat: 4 }), 'utf8')
    const result = await store.loadSession(view(['m1']))
    expect(result.warnings.some(warning => warning.includes('store format 2 is not supported'))).toBe(true)
    await expect(stat(meta)).rejects.toThrow()
    await checkpoint(['m1'])
    expect(await readCheckpoint('m1')).toBeDefined()
  })

  it('discards only the new storage when the session format changed', async () => {
    await store.loadSession(view(['m1']))
    await checkpoint(['m1'])
    const legacy = join(storeRoot, sessionId, '7')
    await mkdir(legacy, { recursive: true })
    await writeFile(join(legacy, 'old.json'), '{}', 'utf8')
    const metaPath = join(storeRoot, sessionId, 'meta.json')
    await writeFile(metaPath, JSON.stringify({ store: 3, sessionFormat: 3 }), 'utf8')

    const reopened = new SnapshotStore(storeRoot)
    const result = await reopened.loadSession(view(['m1'], 4))
    expect(result.warnings.some(warning => warning.includes('discarded'))).toBe(true)
    await expect(stat(join(storeRoot, sessionId, 'checkpoints'))).rejects.toThrow()
    await expect(stat(join(storeRoot, sessionId, 'versions'))).rejects.toThrow()
    await expect(stat(join(legacy, 'old.json'))).resolves.toBeDefined()
    expect(await reopened.restoreAfter(sessionId, 'm1')).toMatchObject({ noCheckpoint: true })
  })
})

describe('fail-closed metadata', () => {
  it('refuses reads and writes from a newer store', async () => {
    await store.loadSession(view(['m1']))
    await checkpoint(['m1'])
    await writeFile(join(storeRoot, sessionId, 'meta.json'), JSON.stringify({ store: 4, sessionFormat: 4 }), 'utf8')
    const reopened = new SnapshotStore(storeRoot)
    await reopened.loadSession(view(['m1']))
    expect(await reopened.readStoreVersion(sessionId)).toBe(4)
    await expect(reopened.createCheckpoints(sessionId, 4, ['m2'])).rejects.toBeInstanceOf(UnknownStoreVersionError)
    await expect(reopened.restoreAfter(sessionId, 'm1')).rejects.toBeInstanceOf(UnknownStoreVersionError)
    await expect(reopened.preview(sessionId, 'm1')).rejects.toBeInstanceOf(UnknownStoreVersionError)
  })

  it('discards new storage when meta is corrupt but leaves legacy members', async () => {
    await store.loadSession(view(['m1']))
    await checkpoint(['m1'])
    const legacy = join(storeRoot, sessionId, 'rescue')
    await mkdir(legacy, { recursive: true })
    await writeFile(join(storeRoot, sessionId, 'meta.json'), '{', 'utf8')
    const reopened = new SnapshotStore(storeRoot)
    const result = await reopened.loadSession(view(['m1']))
    expect(result.warnings.some(warning => warning.includes('corrupt'))).toBe(true)
    await expect(stat(join(storeRoot, sessionId, 'checkpoints'))).rejects.toThrow()
    await expect(stat(legacy)).resolves.toBeDefined()
  })
})

describe('clearSession', () => {
  it('counts legacy per-call entries in the report without reading them', async () => {
    const legacy = join(storeRoot, sessionId, '5')
    await mkdir(legacy, { recursive: true })
    await writeFile(join(legacy, 'a.json'), '{}', 'utf8')
    await writeFile(join(legacy, 'b.json'), '{}', 'utf8')
    await writeFile(join(legacy, 'c.before'), 'bytes', 'utf8')
    const dry = await store.clearSession(sessionId, { dryRun: true })
    expect(dry.entries).toBe(2)
    expect(dry.bytes).toBeGreaterThan(0)
  })

  it('clears a newer store without loading or version-gating it', async () => {
    const dir = join(storeRoot, sessionId)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'meta.json'), JSON.stringify({ store: 9, sessionFormat: 4 }), 'utf8')
    await writeFile(join(dir, 'checkpoints'), 'not a directory', 'utf8')
    const report = await store.clearSession(sessionId)
    expect(report.dryRun).toBe(false)
    expect(report.bytes).toBeGreaterThan(0)
    await expect(stat(dir)).rejects.toThrow()
  })

  it('reports a dry run and removes the whole directory on apply', async () => {
    await store.loadSession(view(['m1']))
    await checkpoint(['m1'])
    const dry = await store.clearSession(sessionId, { dryRun: true })
    expect(dry).toMatchObject({ entries: 1, dryRun: true })
    expect(dry.bytes).toBeGreaterThan(0)
    expect(await store.clearSession(sessionId)).toMatchObject({ entries: 1, dryRun: false })
    await expect(stat(join(storeRoot, sessionId))).rejects.toThrow()
    await expect(store.restoreAfter(sessionId, 'm1')).rejects.toThrow(/not loaded/)
  })
})
