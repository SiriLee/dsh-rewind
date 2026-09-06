import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, writeFile, readdir, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { runRewindFix, type RewindFixDeps } from '../src/rewind-fix.ts'
import { decodeZstd, encodeSessionLog } from '../src/session-log-io.ts'

type EventInput = Record<string, unknown>
function ev(fields: EventInput): SessionEvent {
  return fields as unknown as SessionEvent
}

const HEADER = { type: 'session', version: 0, createdAt: 1, delegationDepth: 0 } as const

function turn(base: number, n: number): SessionEvent[] {
  return [
    ev({ type: 'turn/start', seq: base + 0, time: 1, data: { turn: n } }),
    ev({ type: 'step/start', seq: base + 1, time: 1, data: { turn: n, step: 1 } }),
    ev({ type: 'user/message', seq: base + 2, time: 2, data: { role: 'user', content: [{ type: 'text', text: `q${n}` }], source: { kind: 'user' }, id: `u${n}` } }),
    ev({ type: 'assistant/message', seq: base + 3, time: 3, data: { turn: n, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: `a${n}` }], source: { kind: 'model', provider: 'p', model: 'm' }, id: `a${n}` } } }),
    ev({ type: 'step/end', seq: base + 4, time: 3, data: { turn: n, step: 1 } }),
    ev({ type: 'turn/end', seq: base + 5, time: 4, data: { turn: n, reason: { kind: 'completed' } } }),
  ]
}

function ghostMarker(base: number, id: string, start: number, end: number, seqs: number[]): SessionEvent[] {
  return [
    ev({ type: 'command/run', seq: base + 0, time: 9, data: {} }),
    ev({ type: 'step/start', seq: base + 1, time: 9, data: { turn: 99, step: 0 } }),
    ev({
      type: 'assistant/message', seq: base + 2, time: 9,
      data: { turn: 99, step: 0, message: { role: 'assistant', content: [], source: { kind: 'model', provider: 'dsh-rewind', model: 'rewind-marker' }, id } },
      surfaceOp: { op: 'replace', start, end },
      sourceEventSeqs: seqs,
    }),
    ev({ type: 'step/end', seq: base + 3, time: 9, data: { turn: 99, step: 0 } }),
    ev({ type: 'command/done', seq: base + 4, time: 9, data: {} }),
  ]
}

const header = (id: string): string => JSON.stringify({ ...HEADER, id })

/** A marker-bearing session that needs repair (B form). */
function markerSession(): SessionEvent[] {
  return [...turn(0, 1), ...ghostMarker(6, 'm-ghost', 2, 5, [2, 5]), ...turn(11, 2)]
}

/** A session with no rewind markers (should be skipped). */
function cleanSession(): SessionEvent[] {
  return turn(0, 1)
}

/** A mini dependency harness that persists real `.jsonl.zstd` files under a temp dir. */
class TempPersistence implements RewindFixDeps {
  readonly root: string
  loaded = new Set<string>()
  clearedCount = 0
  cleared: string[] = []
  /** When set, clearSession throws (exercises the rollback branch). */
  sabotageClear = false
  /** When set, readRaw returns stale content for the just-written session. */
  sabotageVerify = false
  private readonly original = new Map<string, string>()

  constructor(root: string) {
    this.root = root
  }

  locateFor(id: string): string {
    return join(this.root, `${id}.jsonl.zstd`)
  }

  async writeSession(id: string, events: SessionEvent[]): Promise<void> {
    const buffer = encodeSessionLog(header(id), events)
    await writeFile(this.locateFor(id), buffer)
    this.original.set(id, decodeZstd(buffer))
  }

  async listSnapshots(): Promise<Array<{ header: SessionHeader }>> {
    const out: Array<{ header: SessionHeader }> = []
    for (const file of await readdir(this.root)) {
      if (!file.endsWith('.jsonl.zstd')) continue
      const id = file.slice(0, -'.jsonl.zstd'.length)
      const plain = decodeZstd(await readFile(join(this.root, file)))
      out.push({ header: { ...(JSON.parse(plain.split('\n')[0]!)) as SessionHeader } })
    }
    return out
  }

  async readRaw(id: Parameters<RewindFixDeps['readRaw']>[0]): Promise<{ content: string } | undefined> {
    const p = this.locateFor(id as string)
    try {
      // If a repair wrote this session AND verify is sabotaged, return the
      // ORIGINAL content so the post-write verification sees a mismatch.
      if (this.sabotageVerify && this.original.has(id as string)) {
        return { content: this.original.get(id as string)! }
      }
      return { content: decodeZstd(await readFile(p)) }
    } catch {
      return undefined
    }
  }

  locate(header: SessionHeader): { path: string } {
    return { path: this.locateFor(header.id as string) }
  }

  isSessionLoaded(id: Parameters<RewindFixDeps['isSessionLoaded']>[0]): boolean {
    return this.loaded.has(id as string)
  }

  async clearSession(id: string): Promise<unknown> {
    if (this.sabotageClear) throw new Error('clearSession exploded')
    this.clearedCount += 1
    this.cleared.push(id)
    return {}
  }
}

describe('rewind-fix orchestration', () => {
  let root: string
  let p: TempPersistence

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rewind-fix-'))
    p = new TempPersistence(root)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('applies the repair to a marker-bearing closed session and clears its snapshots', async () => {
    await p.writeSession('session-a', markerSession())
    const text = await runRewindFix(p, { apply: true, launcherHasMarkers: false })
    expect(text).toContain('repaired')

    // The on-disk artifact now decodes to form-C markers (no legacy assistant markers).
    const plain = decodeZstd(await readFile(p.locateFor('session-a')))
    const lines = plain.split('\n').filter(Boolean).slice(1)
    const decoded: SessionEvent[] = []
    for (const line of lines) decoded.push(JSON.parse(line) as SessionEvent)
    // Re-encode the flat event list to inspect: the marker event must be a user/message now.
    expect(decoded.some(e => e.type === 'user/message' && (e.data as { source?: { plugin?: string } }).source?.plugin === 'dsh-rewind')).toBe(true)
    expect(decoded.some(e => e.type === 'assistant/message' && (e.data as { message?: { source?: { provider?: string } } }).message?.source?.provider === 'dsh-rewind')).toBe(false)
    expect(p.clearedCount).toBe(1)
  })

  it('dry-run does not write and does not clear snapshots', async () => {
    await p.writeSession('session-a', markerSession())
    const before = decodeZstd(await readFile(p.locateFor('session-a')))
    const text = await runRewindFix(p, { apply: false, launcherHasMarkers: false })
    expect(text).toContain('dry-run')
    expect(text).toContain('1 will be repaired')
    const after = decodeZstd(await readFile(p.locateFor('session-a')))
    expect(after).toBe(before)
    expect(p.clearedCount).toBe(0)
  })

  it('skips a session the harness has loaded', async () => {
    await p.writeSession('session-a', markerSession())
    p.loaded.add('session-a')
    const text = await runRewindFix(p, { apply: true, launcherHasMarkers: false })
    expect(text).toContain('SKIP (loaded)')
    expect(p.clearedCount).toBe(0)
    // The file is untouched (still has the legacy marker).
    const plain = decodeZstd(await readFile(p.locateFor('session-a')))
    expect(plain).toContain('rewind-marker')
  })

  it('fails safely when the session is locked by another process', async () => {
    await p.writeSession('session-a', markerSession())
    await writeFile(`${p.locateFor('session-a')}.rewind-fix.lock`, 'lock')
    const text = await runRewindFix(p, { apply: true, launcherHasMarkers: false })
    expect(text).toContain('locked by another process')
    expect(p.clearedCount).toBe(0)
  })

  it('rolls back to the original artifact when the post-write commit fails', async () => {
    await p.writeSession('session-a', markerSession())
    const original = decodeZstd(await readFile(p.locateFor('session-a')))
    p.sabotageClear = true
    const text = await runRewindFix(p, { apply: true, launcherHasMarkers: false })
    expect(text).toContain('FAIL')
    // The rollback restored the original artifact (from the .bak).
    const restored = decodeZstd(await readFile(p.locateFor('session-a')))
    expect(restored).toBe(original)
    expect(p.clearedCount).toBe(0)
  })

  it('is idempotent: a second run sees no legacy markers and re-scribbles nothing', async () => {
    await p.writeSession('session-a', markerSession())
    const first = await runRewindFix(p, { apply: true, launcherHasMarkers: false })
    expect(first).toContain('repaired')
    const afterFirst = decodeZstd(await readFile(p.locateFor('session-a')))
    const second = await runRewindFix(p, { apply: true, launcherHasMarkers: false })
    expect(second).toContain('SKIP (no markers)')
    const afterSecond = decodeZstd(await readFile(p.locateFor('session-a')))
    expect(afterSecond).toBe(afterFirst)
    expect(p.clearedCount).toBe(1)
  })

  it('emits the launcher guard when the running session itself needs repair', async () => {
    const text = await runRewindFix(p, { apply: false, launcherHasMarkers: true })
    expect(text).toContain('needs repair')
    expect(text).toContain('Start a NEW session')
  })
})
