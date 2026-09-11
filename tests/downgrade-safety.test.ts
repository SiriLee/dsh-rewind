/**
 * Downgrade-safety contract (see the design's ADR-3 / ADR-10): after this
 * build has written snapshots, a RELEASED v1 build must be unable to touch the
 * workspace.
 *
 * The lever is schema-level: this build writes entries as
 * `{store: 2, callId, file, blob, size, time}` — it deliberately never reuses
 * the v1 keys `path` / `anchorSeq`, so the released v1 guard
 *
 *   if (typeof parsed.path !== 'string' || typeof parsed.anchorSeq !== 'number') return undefined
 *
 * rejects every one of them. A v1 build then plans NO action, because an entry
 * it cannot read is not an entry — not "the file was created". That is what
 * makes a downgrade cost snapshots only.
 *
 * `legacyReadEntry` below is a verbatim copy of the released v0.11.0 reader
 * (`src/snapshot.ts` at 0bfa087). If a future change renames `file` back to
 * `path` (or adds `anchorSeq`), this test fails — the contract is permanent.
 */
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CURRENT_STORE_VERSION, defaultProbe, reconcileTracked, SnapshotStore, UnknownStoreVersionError } from '../src/snapshot.ts'

let root: string
let store: SnapshotStore
const session = 'session-downgrade'

const unlink = async (path: string): Promise<void> => {
  await rm(path, { force: true })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-rewind-downgrade-'))
  store = new SnapshotStore(root)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** The released v0.11.0 entry reader, copied verbatim as the contract. */
async function legacyReadEntry(file: string): Promise<{ path: string; before: string | null } | undefined> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
    if (typeof parsed.path !== 'string' || typeof parsed.anchorSeq !== 'number') return undefined
    const base = {
      callId: String(parsed.callId ?? ''),
      anchorSeq: parsed.anchorSeq,
      path: parsed.path,
      time: typeof parsed.time === 'number' ? parsed.time : 0,
    }
    if (typeof parsed.ref === 'string') return { ...base, before: null }
    return { ...base, before: typeof parsed.before === 'string' ? parsed.before : null }
  } catch {
    return undefined
  }
}

/** Every entry JSON of a session (journals excluded), as absolute paths. */
async function entryFiles(sessionId: string): Promise<string[]> {
  const sessionDir = store.sessionDir(sessionId)
  const found: string[] = []
  for (const name of await readdir(sessionDir)) {
    if (!Number.isSafeInteger(Number(name))) continue
    for (const file of await readdir(join(sessionDir, name))) {
      if (file.endsWith('.json')) found.push(join(sessionDir, name, file))
    }
  }
  return found
}

/** A store with every v2 entry shape: real, dedup link, creation, boundary. */
async function seedV2Store(): Promise<string> {
  const file = join(root, 'ws', 'a.bin')
  await mkdir(join(root, 'ws'), { recursive: true })
  await writeFile(file, Buffer.from([0xd6, 0xd0, 0xce, 0xc4]))

  const capture = async (callId: string, anchorSeq: number): Promise<void> => {
    const staged = await store.stageCapture(session, callId)
    const copied = await defaultProbe.copy(file, staged)
    if (copied.kind !== 'copied') throw new Error('capture failed')
    await store.recordBackup(session, { callId, anchorSeq, path: file }, { file: staged, size: copied.size })
  }
  await capture('c1', 5) // real (blob sidecar)
  await capture('c2', 6) // identical content → dedup link
  const created = join(root, 'ws', 'created.txt')
  await store.recordBackup(session, { callId: 'c3', anchorSeq: 7, path: created }, null) // creation
  await writeFile(file, Buffer.from([1, 2, 3]))
  await writeFile(created, 'created')
  // A boundary re-check entry (the "external change" shape).
  await reconcileTracked(store, session, 8, await store.trackedPaths(session))
  return file
}

describe('a released v1 build cannot act on v2 snapshots', () => {
  it('rejects every entry shape this build writes', async () => {
    await seedV2Store()
    const files = await entryFiles(session)
    expect(files.length).toBeGreaterThanOrEqual(4)
    const shapes = new Set<string>()
    for (const file of files) {
      expect(await legacyReadEntry(file), `${relative(store.sessionDir(session), file)} must be unreadable to v1`).toBeUndefined()
      const parsed = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
      expect(parsed.store).toBe(2)
      expect(parsed.file).toBeTypeOf('string')
      // The two v1 key names must never come back (the contract itself).
      expect('path' in parsed).toBe(false)
      expect('anchorSeq' in parsed).toBe(false)
      shapes.add(typeof parsed.ref === 'string' ? 'link' : parsed.blob === null ? 'creation' : 'real')
    }
    // All three shapes were actually covered (real, link, creation).
    expect([...shapes].sort()).toEqual(['creation', 'link', 'real'])
  })

  it('keeps journals out of the released prefix so v1 reconciles none', async () => {
    const file = await seedV2Store()
    await writeFile(file, Buffer.from([9]))
    await store.restoreAfter(session, 5, unlink)
    const journals = (await readdir(store.sessionDir(session))).filter(name => name.endsWith('.json'))
    expect(journals.length).toBeGreaterThan(0)
    for (const name of journals) expect(name.startsWith('restore-journal-')).toBe(false)
  })

  it('stamps the store marker and reads back the current version', async () => {
    await seedV2Store()
    expect(await store.readStoreVersion(session)).toBe(CURRENT_STORE_VERSION)
  })
})

describe('a store written by a NEWER build is never touched', () => {
  it('fails the file restore closed and changes nothing', async () => {
    const file = await seedV2Store()
    await store.markStoreVersion(session, CURRENT_STORE_VERSION + 1)
    await writeFile(file, Buffer.from([0xaa]))

    await expect(store.restoreAfter(session, 5, unlink)).rejects.toBeInstanceOf(UnknownStoreVersionError)
    await expect(store.impactsAfter(session, 5)).rejects.toBeInstanceOf(UnknownStoreVersionError)
    // Nothing was restored, deleted or cleared: only a snapshot-level refusal.
    expect(await readFile(file)).toEqual(Buffer.from([0xaa]))
    expect(await store.exists(store.sessionDir(session))).toBe(true)
  })

  it('fails closed on a newer ENTRY version even without a marker', async () => {
    await seedV2Store()
    const anchorDir = store.anchorDir(session, 9)
    await mkdir(anchorDir, { recursive: true })
    await writeFile(join(anchorDir, 'future.json'), JSON.stringify({
      store: CURRENT_STORE_VERSION + 1, callId: 'future', file: join(root, 'x'), blob: null, size: 0, time: 1,
    }), 'utf8')
    await expect(store.impactsAfter(session, 5)).rejects.toBeInstanceOf(UnknownStoreVersionError)
  })

  it('refuses to write new entries into a newer store', async () => {
    await store.markStoreVersion(session, CURRENT_STORE_VERSION + 1)
    const file = join(root, 'ws', 'n.txt')
    await mkdir(join(root, 'ws'), { recursive: true })
    await writeFile(file, 'content')
    await expect(store.recordEntry(session, { callId: 'c1', anchorSeq: 5, path: file, before: 'content' }))
      .rejects.toBeInstanceOf(UnknownStoreVersionError)
    expect(await entryFiles(session)).toEqual([])
  })

  it('still lets the user clear the session explicitly', async () => {
    await seedV2Store()
    await store.markStoreVersion(session, CURRENT_STORE_VERSION + 1)
    const report = await store.clearSession(session)
    expect(report.dryRun).toBe(false)
    expect(await store.exists(store.sessionDir(session))).toBe(false)
  })
})

describe('v1 entries and v2 entries compose in one window', () => {
  it('reads a legacy entry next to a byte entry and restores both', async () => {
    const legacyPath = join(root, 'ws', 'legacy.txt')
    const bytePath = join(root, 'ws', 'byte.bin')
    await mkdir(join(root, 'ws'), { recursive: true })
    await writeFile(legacyPath, Buffer.from('old'))
    await writeFile(bytePath, Buffer.from('old'))

    // Released v1 entry, hand-written exactly as v0.11.0 wrote it.
    await mkdir(store.anchorDir(session, 5), { recursive: true })
    await writeFile(join(store.anchorDir(session, 5), 'legacy1.json'), JSON.stringify({
      callId: 'legacy1', anchorSeq: 5, path: legacyPath, before: 'v1-content', time: 1,
    }), 'utf8')
    const staged = await store.stageCapture(session, 'c2')
    await defaultProbe.copy(bytePath, staged)
    await store.recordBackup(session, { callId: 'c2', anchorSeq: 6, path: bytePath }, { file: staged, size: 4 })

    await writeFile(legacyPath, Buffer.from('changed'))
    await writeFile(bytePath, Buffer.from('changed'))
    const outcome = await store.restoreAfter(session, 5, unlink)
    expect([...outcome.restored].sort()).toEqual([bytePath, legacyPath])
    expect(await readFile(legacyPath, 'utf8')).toBe('v1-content')
    expect(await readFile(bytePath, 'utf8')).toBe('old')
  })
})

describe('untrusted journal references', () => {
  it('refuses a journal byte reference that escapes the session dir', async () => {
    const sessionDir = store.sessionDir(session)
    await mkdir(sessionDir, { recursive: true })
    const victim = join(root, 'ws', 'victim.txt')
    await mkdir(join(root, 'ws'), { recursive: true })
    await writeFile(victim, 'untouched', 'utf8')

    for (const [name, ref] of [
      ['traversal', '../../../../etc/passwd'],
      ['absolute', '/etc/passwd'],
      ['parent-segment', 'rescue/../../x.before'],
    ] as const) {
      await writeFile(join(sessionDir, `journal-op-${name}.json`), JSON.stringify({
        version: 2,
        id: `op-${name}`,
        sessionId: session,
        targetSeq: 5,
        startedAt: 1,
        state: 'running',
        actions: [{ path: victim, action: 'restore', before: { blob: ref }, rescue: null, done: false }],
      }), 'utf8')
    }

    const reports = await store.reconcileRestores(session)
    expect(reports).toHaveLength(3)
    for (const report of reports) {
      expect(report.state).toBe('recovery-required')
      expect(report.corrupt).toBeDefined()
      expect(report.restored).toEqual([])
      expect(report.pending).toEqual([])
    }
    // Nothing was written from the hostile journals.
    expect(await readFile(victim, 'utf8')).toBe('untouched')
  })

  it('treats an in-store reference to a missing sidecar as dangling, not corrupt', async () => {
    // Containment and existence are different questions: a well-formed ref
    // that points INSIDE the store but at a missing file is a dangling link
    // (reported as interrupted), never a traversal.
    const sessionDir = store.sessionDir(session)
    await mkdir(sessionDir, { recursive: true })
    const victim = join(root, 'ws', 'victim.txt')
    await mkdir(join(root, 'ws'), { recursive: true })
    await writeFile(victim, 'untouched', 'utf8')
    await writeFile(join(sessionDir, 'journal-op-dangling.json'), JSON.stringify({
      version: 2,
      id: 'op-dangling',
      sessionId: session,
      targetSeq: 5,
      startedAt: 1,
      state: 'running',
      actions: [{ path: victim, action: 'restore', before: { blob: '5/missing.before' }, rescue: null, done: false }],
    }), 'utf8')

    const reports = await store.reconcileRestores(session)
    expect(reports).toHaveLength(1)
    expect(reports[0]!.corrupt).toBeUndefined()
    expect(reports[0]!.state).toBe('interrupted')
    expect(reports[0]!.pending).toEqual([victim])
    expect(await readFile(victim, 'utf8')).toBe('untouched')
  })
})
