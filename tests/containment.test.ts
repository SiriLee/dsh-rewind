/**
 * Restore containment against a workspace-confined model (GHSA-67px-g83w-4rv3).
 *
 * The model can delete, rename and re-create directories and links inside the
 * workspace while a rewind runs through host `node:fs`, outside that sandbox.
 * Every record therefore pins where its directory resolved when it was
 * captured — projecting through a missing chain — so a link created later
 * cannot pass as the recorded location, and the apply pass re-checks that the
 * final component is still one regular file before it writes or unlinks.
 */
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultProbe, SnapshotStore, type DiskProbe } from '../src/snapshot.ts'

const run = promisify(execFile)
const session = 'session-containment'
const posixOnly = process.platform !== 'win32'

let root: string
let store: SnapshotStore
let outside: string

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-rewind-containment-')))
  outside = join(root, 'outside')
  await mkdir(outside)
  store = new SnapshotStore(join(root, 'store'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const unlink = async (path: string): Promise<void> => {
  await rm(path, { force: true })
}

async function touch(rel: string, content: string): Promise<string> {
  const abs = join(root, 'ws', rel)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, content, 'utf8')
  return abs
}

/** Capture one file exactly the way the host does (staged byte copy, commit). */
async function capture(callId: string, anchorSeq: number, live: string): Promise<void> {
  const staged = await store.stageCapture(session, callId)
  const copied = await defaultProbe.copy(live, staged)
  if (copied.kind === 'failed') throw new Error(copied.message)
  await store.recordBackup(session, { callId, anchorSeq, path: live },
    copied.kind === 'absent' ? null : { file: staged, size: copied.size })
}

describe('a location pin projected through a missing directory', () => {
  it('refuses a delete through a directory later recreated as a symlink', async () => {
    const live = await touch('d/authorized_keys', 'agent')
    await capture('w1', 1, live)
    // The model's `rm -rf d`; the boundary re-check records the path as absent.
    await rm(dirname(live), { recursive: true })
    await capture('w2', 2, live)
    // The model's `ln -s ~/.ssh d` (an outside directory holding the victim).
    const victim = join(outside, 'authorized_keys')
    await writeFile(victim, 'user keys', 'utf8')
    await symlink(outside, dirname(live), 'dir')

    // The preview reports nothing to do, and the pass touches nothing outside.
    expect(await store.impactsAfter(session, 2)).toEqual([])
    expect(await store.restoreAfter(session, 2, unlink)).toEqual({
      restored: [], deleted: [], skipped: [live], failed: [],
    })
    expect(await readFile(victim, 'utf8')).toBe('user keys')
  })

  it('pins where the directory would resolve, not the symlink target', async () => {
    const live = await touch('d/f.txt', 'x')
    await capture('p1', 1, live)
    await rm(dirname(live), { recursive: true })
    await capture('p2', 2, live)

    const [entry] = await store.entriesAfter(session, 2)
    expect(entry?.parent).toBe(join(root, 'ws', 'd'))
  })
})

describe('the apply pass re-checks the final component', () => {
  it('refuses a write through a final symlink swapped in after planning', async () => {
    const live = await touch('d/f.txt', 'before')
    await capture('r1', 5, live) // the recorded state a rewind restores
    await writeFile(live, 'after', 'utf8')
    const victim = join(outside, 'victim')
    await writeFile(victim, 'user content', 'utf8')

    expect(await store.impactsAfter(session, 5)).toEqual([{ path: live, action: 'restore' }])
    // The model's swap, in the window between planning and the write: the probe
    // captures the rescue copy first, then the final component becomes a link.
    const swapping: DiskProbe = {
      ...defaultProbe,
      copy: async (path, dest) => {
        const outcome = await defaultProbe.copy(path, dest)
        if (path === live) {
          await rm(live)
          await symlink(victim, live)
        }
        return outcome
      },
    }

    const outcome = await store.restoreAfter(session, 5, unlink, swapping)
    expect(outcome.restored).toEqual([])
    expect(outcome.failed.map(file => file.path)).toEqual([live])
    expect(outcome.failed[0]?.message).toMatch(/moved or repointed/)
    // Without the apply-time check, copyFile would follow the link and the
    // outside file would have received the recorded "before" bytes.
    expect(await readFile(victim, 'utf8')).toBe('user content')
  })

  it.skipIf(!posixOnly)('skips a FIFO at planning time instead of blocking on it', async () => {
    const live = join(root, 'ws', 'd', 'f.txt')
    await mkdir(dirname(live), { recursive: true })
    await capture('f1', 7, live)
    await run('mkfifo', [live])

    expect(await store.impactsAfter(session, 7)).toEqual([])
    expect(await store.restoreAfter(session, 7, unlink)).toEqual({
      restored: [], deleted: [], skipped: [live], failed: [],
    })
  })
})
