/**
 * Checkpoint restore tests: dense target rows, the v1 fallback, created-file
 * deletes, external changes, the over-cap rule, links and location pins,
 * version integrity, atomic per-file replacement and rerun convergence.
 */
import { link, mkdir, mkdtemp, readFile, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SnapshotStore, UnknownStoreVersionError, type StoreSession } from '../src/snapshot.ts'

let root: string
let ws: string
let storeRoot: string
let store: SnapshotStore
const sessionId = 'restore-session'
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

async function checkpoint(messageIds: readonly string[]): Promise<void> {
  const result = await store.createCheckpoints(sessionId, 4, messageIds)
  expect(result.warnings).toEqual([])
}

async function capture(path: string): Promise<void> {
  const result = await store.captureFirstTouch(sessionId, path)
  expect(result.recorded).toBe(true)
}

async function prepare(ids: readonly string[] = ['m1', 'm2', 'm3']): Promise<void> {
  await store.loadSession(view(ids))
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-rewind-restore-'))
  ws = join(root, 'ws')
  storeRoot = join(root, 'store')
  await mkdir(ws, { recursive: true })
  store = new SnapshotStore(storeRoot)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('dense restore semantics', () => {
  it('restores the target message state, not the latest record', async () => {
    await prepare()
    await checkpoint(['m1'])
    const file = await touch('a.txt', 'one')
    await capture(file)
    await checkpoint(['m2'])
    await writeFile(file, 'two')
    await checkpoint(['m3'])
    await writeFile(file, 'external')

    const outcome = await store.restoreAfter(sessionId, 'm2')
    expect(outcome.restored).toEqual([file])
    expect(await readFile(file, 'utf8')).toBe('one')
  })

  it('uses the first later row for a path first tracked after the target', async () => {
    await prepare(['m1', 'm2'])
    await checkpoint(['m1', 'm2'])
    const file = await touch('a.txt', 'one')
    await capture(file) // row lands in m2 (current)
    await writeFile(file, 'two')

    const outcome = await store.restoreAfter(sessionId, 'm1')
    expect(outcome.restored).toEqual([file])
    expect(await readFile(file, 'utf8')).toBe('one')
  })

  it('deletes a file created after the target', async () => {
    await prepare(['m1', 'm2', 'm3'])
    await checkpoint(['m1'])
    await checkpoint(['m2'])
    const file = join(ws, 'created.txt')
    await capture(file) // absent: null v1 row in m2
    await writeFile(file, 'new')
    await checkpoint(['m3'])

    const outcome = await store.restoreAfter(sessionId, 'm1')
    expect(outcome.deleted).toEqual([file])
    await expect(stat(file)).rejects.toThrow()
  })

  it('deletes a created file even when it is over the size cap', async () => {
    store = new SnapshotStore(storeRoot, { maxFileBytes: 4 })
    await prepare(['m1', 'm2', 'm3'])
    await checkpoint(['m1'])
    await checkpoint(['m2'])
    const file = join(ws, 'big-created.txt')
    await capture(file)
    await writeFile(file, 'over the cap')
    await checkpoint(['m3'])

    const outcome = await store.restoreAfter(sessionId, 'm1')
    expect(outcome.deleted).toEqual([file])
    await expect(stat(file)).rejects.toThrow()
  })

  it('keeps a first-touch row when the tool later fails', async () => {
    await prepare(['m1', 'm2'])
    await checkpoint(['m1'])
    const file = await touch('a.txt', 'one')
    await capture(file) // the write that would change it never happens
    await checkpoint(['m2'])

    const outcome = await store.restoreAfter(sessionId, 'm1')
    expect(outcome).toMatchObject({ restored: [], deleted: [], failed: [], noCheckpoint: false })
    expect(await readFile(file, 'utf8')).toBe('one')
  })

  it('is idempotent: a second restore is a no-op', async () => {
    await prepare(['m1', 'm2'])
    await checkpoint(['m1'])
    const file = await touch('a.txt', 'one')
    await capture(file)
    await checkpoint(['m2'])
    await writeFile(file, 'two')

    expect((await store.restoreAfter(sessionId, 'm1')).restored).toEqual([file])
    expect(await store.restoreAfter(sessionId, 'm1')).toMatchObject({
      restored: [], deleted: [], skipped: [], failed: [], noCheckpoint: false,
    })
  })
})

describe('safety rules', () => {
  it('reports no checkpoint for an unknown message', async () => {
    await prepare(['m1'])
    expect(await store.restoreAfter(sessionId, 'missing')).toEqual({
      restored: [], deleted: [], skipped: [], failed: [], noCheckpoint: true,
    })
  })

  it.runIf(posixOnly)('skips a path that became a symlink after capture', async () => {
    await prepare(['m1', 'm2'])
    await checkpoint(['m1'])
    const dir = join(ws, 'd')
    const victim = join(dir, 'victim.txt')
    await mkdir(dir, { recursive: true })
    await writeFile(victim, 'safe')
    const file = join(dir, 'file.txt')
    await writeFile(file, 'one')
    await capture(file)
    await checkpoint(['m2'])

    await rm(file)
    const outside = join(root, 'outside')
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'file.txt'), 'outside')
    await symlink(join(outside, 'file.txt'), file)

    const outcome = await store.restoreAfter(sessionId, 'm1')
    expect(outcome.skipped).toContainEqual({ path: file, reason: 'unsafe' })
    expect(await readFile(join(outside, 'file.txt'), 'utf8')).toBe('outside')
  })

  it.runIf(posixOnly)('skips a path whose parent directory was repointed', async () => {
    await prepare(['m1', 'm2'])
    await checkpoint(['m1'])
    const dir = join(ws, 'project')
    const file = join(dir, 'a.txt')
    await mkdir(dir, { recursive: true })
    await writeFile(file, 'one')
    await capture(file)
    await checkpoint(['m2'])

    await rm(dir, { recursive: true })
    const outside = join(root, 'outside-dir')
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'a.txt'), 'victim')
    await symlink(outside, dir)

    const outcome = await store.restoreAfter(sessionId, 'm1')
    expect(outcome.skipped).toContainEqual({ path: file, reason: 'parent' })
    expect(await readFile(join(outside, 'a.txt'), 'utf8')).toBe('victim')
  })

  it('skips a currently over-cap tracked file', async () => {
    store = new SnapshotStore(storeRoot, { maxFileBytes: 4 })
    await prepare(['m1', 'm2'])
    await checkpoint(['m1'])
    const file = await touch('a.txt', 'ok')
    await capture(file)
    await checkpoint(['m2'])
    await writeFile(file, 'too large')

    const outcome = await store.restoreAfter(sessionId, 'm1')
    expect(outcome.skipped).toContainEqual({ path: file, reason: 'oversized' })
    expect(await readFile(file, 'utf8')).toBe('too large')
  })

  it.runIf(posixOnly)('does not follow a symlink planted at the restore temp name', async () => {
    await prepare(['m1', 'm2'])
    await checkpoint(['m1'])
    const file = await touch('a.txt', 'one')
    await capture(file)
    await checkpoint(['m2'])
    await writeFile(file, 'two')
    const victim = join(root, 'victim.txt')
    await writeFile(victim, 'victim')
    await symlink(victim, `${file}.rewind-tmp`)

    const outcome = await store.restoreAfter(sessionId, 'm1')
    expect(outcome.restored).toEqual([file])
    expect(await readFile(victim, 'utf8')).toBe('victim')
    expect(await readFile(file, 'utf8')).toBe('one')
  })

  it('fails a missing version without touching the file', async () => {
    await prepare(['m1', 'm2'])
    await checkpoint(['m1'])
    const file = await touch('a.txt', 'one')
    await capture(file)
    await checkpoint(['m2'])
    await writeFile(file, 'two')
    await rm(join(storeRoot, sessionId, 'versions'), { recursive: true, force: true })

    const outcome = await store.restoreAfter(sessionId, 'm1')
    expect(outcome.failed).toHaveLength(1)
    expect(outcome.failed[0]!.path).toBe(file)
    expect(await readFile(file, 'utf8')).toBe('two')
  })

  it('fails a truncated version without touching the file', async () => {
    await prepare(['m1', 'm2'])
    await checkpoint(['m1'])
    const file = await touch('a.txt', 'one')
    await capture(file)
    await checkpoint(['m2'])
    await writeFile(file, 'two')
    const versions = join(storeRoot, sessionId, 'versions')
    const names = await (await import('node:fs/promises')).readdir(versions)
    await truncate(join(versions, names[0]!), 1)

    const outcome = await store.restoreAfter(sessionId, 'm1')
    expect(outcome.failed).toHaveLength(1)
    expect(await readFile(file, 'utf8')).toBe('two')
  })

  it('keeps a single-file atomic replace and converges on rerun', async () => {
    let fail = true
    store = new SnapshotStore(storeRoot, {
      testHooks: {
        beforeRestoreRename: () => {
          if (fail) {
            fail = false
            throw new Error('injected crash')
          }
        },
      },
    })
    await prepare(['m1', 'm2'])
    await checkpoint(['m1'])
    const file = await touch('a.txt', 'one')
    await capture(file)
    await checkpoint(['m2'])
    await writeFile(file, 'two')

    const first = await store.restoreAfter(sessionId, 'm1')
    expect(first.failed).toHaveLength(1)
    // The temp file was cleaned up and the target is still the complete old file.
    expect(await readFile(file, 'utf8')).toBe('two')
    await expect(stat(`${file}.rewind-tmp`)).rejects.toThrow()

    const second = await store.restoreAfter(sessionId, 'm1')
    expect(second.restored).toEqual([file])
    expect(await readFile(file, 'utf8')).toBe('one')
  })
})

describe('a newer store still allows the conversation rewind', () => {
  it('fails only the file operation', async () => {
    await prepare(['m1'])
    await checkpoint(['m1'])
    await writeFile(join(storeRoot, sessionId, 'meta.json'), JSON.stringify({ store: 9, sessionFormat: 4 }), 'utf8')
    const reopened = new SnapshotStore(storeRoot)
    await reopened.loadSession(view(['m1']))
    await expect(reopened.restoreAfter(sessionId, 'm1')).rejects.toBeInstanceOf(UnknownStoreVersionError)
  })
})
