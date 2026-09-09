import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, writeFile, readdir, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { runRewindFix, renderRewindFixReport, type RewindFixDeps, type RewindFixResult } from '../src/rewind-fix.ts'
import { decodeZstd, decodeEventBody, encodeSessionLog } from '../src/session-log-io.ts'

/** A stub renderer: returns `key|{params}` so tests can assert on layout keys. */
const stubT = (key: string, params?: Record<string, string | number>): string =>
  key + (params ? '|' + JSON.stringify(params) : '')

function outcomeOf(result: RewindFixResult, id: string) {
  const o = result.sessions.find(s => s.id === id)
  if (o === undefined) throw new Error(`no outcome for ${id}`)
  return o
}

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

/** An already-form-C session whose `/rewind` args target is stale (needs C→C). */
function staleCSession(): SessionEvent[] {
  return [
    ...turn(0, 1),
    ev({ type: 'command/run', seq: 6, time: 9, data: { commandId: 'c1', name: 'rewind', args: ' @5 chat' } }),
    ev({
      type: 'user/message', seq: 7, time: 9,
      data: { role: 'user', content: [], source: { kind: 'plugin', plugin: 'dsh-rewind' }, id: 'm1' },
      surfaceOp: { op: 'replace', start: 2, end: 5 },
      sourceEventSeqs: [2, 5],
    }),
    ev({ type: 'command/done', seq: 8, time: 9, data: { commandId: 'c1', kind: 'success', sourceEventSeq: 7 } }),
    ...turn(9, 2),
  ]
}

/** A session whose rewind marker is an OLD empty form-C (no A/B, no stale args): only the content must be upgraded. */
function emptyFormCSession(): SessionEvent[] {
  return [
    ...turn(0, 1),
    ev({ type: 'command/run', seq: 6, time: 9, data: { commandId: 'c1', name: 'rewind', args: ' @2 chat' } }),
    ev({
      type: 'user/message', seq: 7, time: 9,
      data: { role: 'user', content: [], source: { kind: 'plugin', plugin: 'dsh-rewind' }, id: 'm1' },
      surfaceOp: { op: 'replace', start: 2, end: 5 },
      sourceEventSeqs: [2, 5],
    }),
    ev({ type: 'command/done', seq: 8, time: 9, data: { commandId: 'c1', kind: 'success', sourceEventSeq: 7 } }),
    ...turn(9, 2),
  ]
}

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

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
  /** When set, isSessionLoaded returns true from the 2nd call per id (loaded-between recheck). */
  simulateLoadBetween = false
  private readonly loadCalls = new Map<string, number>()
  /** Simulated read latency (ms) so concurrent readRaw calls overlap; 0 = off. */
  latencyMs = 0
  /** Live and max concurrent readRaw calls, used to assert the pool bound. */
  inFlight = 0
  maxInFlight = 0
  private readonly original = new Map<string, string>()

  constructor(root: string) {
    this.root = root
  }

  locateFor(id: string): string {
    return join(this.root, `${id}.jsonl.zstd`)
  }

  async writeSession(id: string, events: SessionEvent[]): Promise<void> {
    const buffer = await encodeSessionLog(header(id), events)
    await writeFile(this.locateFor(id), buffer)
    this.original.set(id, await decodeZstd(buffer))
  }

  async listSnapshots(): Promise<Array<{ header: SessionHeader }>> {
    const out: Array<{ header: SessionHeader }> = []
    for (const file of (await readdir(this.root)).sort()) {
      if (!file.endsWith('.jsonl.zstd')) continue
      const id = file.slice(0, -'.jsonl.zstd'.length)
      const plain = await decodeZstd(await readFile(join(this.root, file)))
      out.push({ header: { ...(JSON.parse(plain.split('\n')[0]!)) as SessionHeader } })
    }
    return out
  }

  async readRaw(id: Parameters<RewindFixDeps['readRaw']>[0]): Promise<{ content: string } | undefined> {
    this.inFlight += 1
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight)
    try {
      if (this.latencyMs > 0) await delay(this.latencyMs)
      const p = this.locateFor(id as string)
      try {
        // If a repair wrote this session AND verify is sabotaged, return the
        // ORIGINAL content so the post-write verification sees a mismatch.
        if (this.sabotageVerify && this.original.has(id as string)) {
          return { content: this.original.get(id as string)! }
        }
        return { content: await decodeZstd(await readFile(p)) }
      } catch {
        return undefined
      }
    } finally {
      this.inFlight -= 1
    }
  }

  locate(header: SessionHeader): { path: string } {
    return { path: this.locateFor(header.id as string) }
  }

  isSessionLoaded(id: Parameters<RewindFixDeps['isSessionLoaded']>[0]): boolean {
    const key = id as string
    const calls = (this.loadCalls.get(key) ?? 0) + 1
    this.loadCalls.set(key, calls)
    if (this.simulateLoadBetween) return calls > 1
    return this.loaded.has(key)
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
    const result = await runRewindFix(p, { apply: true, launcherHasMarkers: false })
    expect(result.apply).toBe(true)
    expect(outcomeOf(result, 'session-a').status).toBe('repaired')

    // The on-disk artifact now decodes to form-C markers (no legacy assistant markers).
    const plain = await decodeZstd(await readFile(p.locateFor('session-a')))
    const lines = plain.split('\n').filter(Boolean).slice(1)
    const decoded: SessionEvent[] = []
    for (const line of lines) decoded.push(JSON.parse(line) as SessionEvent)
    expect(decoded.some(e => e.type === 'user/message' && (e.data as { source?: { plugin?: string } }).source?.plugin === 'dsh-rewind')).toBe(true)
    expect(decoded.some(e => e.type === 'assistant/message' && (e.data as { message?: { source?: { provider?: string } } }).message?.source?.provider === 'dsh-rewind')).toBe(false)
    expect(p.clearedCount).toBe(1)
  })

  it('detects and rewires a stale args target on an already-form-C session (C→C)', async () => {
    await p.writeSession('session-c', staleCSession())
    const result = await runRewindFix(p, { apply: true, launcherHasMarkers: false })
    expect(outcomeOf(result, 'session-c').status).toBe('repaired')
    expect(outcomeOf(result, 'session-c').staleArgs).toBe(1)

    // The on-disk artifact now carries the rewired args target (args == surfaceOp.start).
    const plain = await decodeZstd(await readFile(p.locateFor('session-c')))
    const decoded = decodeEventBody(plain.split('\n').filter(Boolean).slice(1).join('\n'))
    const cmd = decoded.find(e => e.type === 'command/run')!
    expect((cmd.data as { args?: string }).args).toBe(' @2 chat')
    expect(p.clearedCount).toBe(1)
  })

  it('reports an already-form-C stale-args session in dry-run without writing', async () => {
    await p.writeSession('session-c', staleCSession())
    const result = await runRewindFix(p, { apply: false, launcherHasMarkers: false })
    const o = outcomeOf(result, 'session-c')
    expect(o.status).toBe('repaired')
    expect(o.staleArgs).toBe(1)
    // dry-run never writes or clears snapshots.
    expect(p.clearedCount).toBe(0)
  })

  it('C→C repair is idempotent: after the fix a second run skips the session', async () => {
    await p.writeSession('session-c', staleCSession())
    await runRewindFix(p, { apply: true, launcherHasMarkers: false })
    const second = await runRewindFix(p, { apply: false, launcherHasMarkers: false })
    const o = outcomeOf(second, 'session-c')
    expect(o.status).toBe('skipped')
    expect(o.staleArgs).toBe(0)
    expect(p.clearedCount).toBe(1)
  })

  it('upgrades an old empty form-C marker (no A/B, no stale args) and writes the (empty message) content', async () => {
    // Issue #21: a session whose ONLY rewind marker is the old empty form-C must
    // be repaired (contentUpgrades > 0) and its marker content rewritten to the
    // canonical (empty message) placeholder — even with a=0, b=0, staleArgs=0.
    await p.writeSession('session-fc', emptyFormCSession())
    const result = await runRewindFix(p, { apply: true, launcherHasMarkers: false })
    const o = outcomeOf(result, 'session-fc')
    expect(o.status).toBe('repaired')
    expect(o.staleArgs).toBe(0)
    expect(p.clearedCount).toBe(1)

    // The on-disk artifact now carries the canonical placeholder in the marker.
    const plain = await decodeZstd(await readFile(p.locateFor('session-fc')))
    const decoded = decodeEventBody(plain.split('\n').filter(Boolean).slice(1).join('\n'))
    const marker = decoded.find(e => e.type === 'user/message'
      && (e.data as { source?: { plugin?: string } }).source?.plugin === 'dsh-rewind')!
    expect((marker.data as { content?: unknown[] }).content).toEqual([{ type: 'text', text: '(empty message)' }])
    expect((marker.data as { id?: unknown }).id).toBe('m1')

    // Idempotent: a second run sees the canonical marker and skips.
    const second = await runRewindFix(p, { apply: false, launcherHasMarkers: false })
    const o2 = outcomeOf(second, 'session-fc')
    expect(o2.status).toBe('skipped')
    expect(o2.reason).toBe('no-markers')
    expect(p.clearedCount).toBe(1)
  })

  it('dry-run records "will be repaired" without writing or clearing snapshots', async () => {
    await p.writeSession('session-a', markerSession())
    const before = await decodeZstd(await readFile(p.locateFor('session-a')))
    const result = await runRewindFix(p, { apply: false, launcherHasMarkers: false })
    expect(result.apply).toBe(false)
    expect(outcomeOf(result, 'session-a').status).toBe('repaired')
    const after = await decodeZstd(await readFile(p.locateFor('session-a')))
    expect(after).toBe(before)
    expect(p.clearedCount).toBe(0)
  })

  it('skips a session the harness has loaded', async () => {
    await p.writeSession('session-a', markerSession())
    p.loaded.add('session-a')
    const result = await runRewindFix(p, { apply: true, launcherHasMarkers: false })
    const outcome = outcomeOf(result, 'session-a')
    expect(outcome.status).toBe('skipped')
    expect(outcome.reason).toBe('loaded')
    expect(p.clearedCount).toBe(0)
    // The file is untouched (still has the legacy marker).
    const plain = await decodeZstd(await readFile(p.locateFor('session-a')))
    expect(plain).toContain('rewind-marker')
  })

  it('fails safely when the session is locked by another process', async () => {
    await p.writeSession('session-a', markerSession())
    // A LIVE holder records its pid; a live lock must NOT be taken over.
    await writeFile(`${p.locateFor('session-a')}.rewind-fix.lock`, String(process.pid))
    const result = await runRewindFix(p, { apply: true, launcherHasMarkers: false })
    const outcome = outcomeOf(result, 'session-a')
    expect(outcome.status).toBe('failed')
    expect(outcome.reason).toBe('locked')
    expect(p.clearedCount).toBe(0)
  })

  it('rolls back to the original artifact when the post-write commit fails', async () => {
    await p.writeSession('session-a', markerSession())
    const original = await decodeZstd(await readFile(p.locateFor('session-a')))
    p.sabotageClear = true
    const result = await runRewindFix(p, { apply: true, launcherHasMarkers: false })
    expect(outcomeOf(result, 'session-a').status).toBe('failed')
    // The rollback restored the original artifact (from the .bak).
    const restored = await decodeZstd(await readFile(p.locateFor('session-a')))
    expect(restored).toBe(original)
    expect(p.clearedCount).toBe(0)
  })

  it('is idempotent: a second run sees no legacy markers and re-scribbles nothing', async () => {
    await p.writeSession('session-a', markerSession())
    const first = await runRewindFix(p, { apply: true, launcherHasMarkers: false })
    expect(outcomeOf(first, 'session-a').status).toBe('repaired')
    const afterFirst = await decodeZstd(await readFile(p.locateFor('session-a')))
    const second = await runRewindFix(p, { apply: true, launcherHasMarkers: false })
    const outcome2 = outcomeOf(second, 'session-a')
    expect(outcome2.status).toBe('skipped')
    expect(outcome2.reason).toBe('no-markers')
    const afterSecond = await decodeZstd(await readFile(p.locateFor('session-a')))
    expect(afterSecond).toBe(afterFirst)
    expect(p.clearedCount).toBe(1)
  })

  it('emits the launcher guard flag when the running session itself needs repair', async () => {
    const result = await runRewindFix(p, { apply: false, launcherHasMarkers: true })
    expect(result.launcherHasMarkers).toBe(true)
  })

  it('renders the result headline FIRST (collapsed summary), then per-session detail', async () => {
    await p.writeSession('session-a', markerSession())
    const result = await runRewindFix(p, { apply: false, launcherHasMarkers: false })
    const lines = renderRewindFixReport(result, stubT).split('\n')
    // Headline (dry-run) is the first line so the client card summary shows it.
    expect(lines[0]).toMatch(/^rewindfix\.dryRun\|/)
    // The per-session counts line follows it (for the repaired session).
    const countsLine = lines.find(l => l.includes('rewindfix.counts|'))
    expect(countsLine).toBeDefined()
    expect(lines.indexOf(countsLine!)).toBeGreaterThan(0)
  })

  it('renders the apply headline first with the write-ok arrow for a repaired session', async () => {
    await p.writeSession('session-a', markerSession())
    const result = await runRewindFix(p, { apply: true, launcherHasMarkers: false })
    const lines = renderRewindFixReport(result, stubT).split('\n')
    expect(lines[0]).toMatch(/^rewindfix\.done\|/)
    expect(lines.some(l => l.includes('rewindfix.writeOk'))).toBe(true)
  })

  it('bounds concurrency to the pool size and preserves snapshot order', async () => {
    await p.writeSession('session-a', markerSession())
    await p.writeSession('session-b', markerSession())
    await p.writeSession('session-c', markerSession())
    p.latencyMs = 20
    const result = await runRewindFix(p, { apply: true, launcherHasMarkers: false, concurrency: 2 })
    // Never more than `concurrency` sessions' reads are in-flight at once.
    expect(p.maxInFlight).toBeLessThanOrEqual(2)
    // All three processed.
    expect(result.sessions).toHaveLength(3)
    // Order preserved (listSnapshots is sorted, pool writes positional results).
    expect(result.sessions.map(s => s.id)).toEqual(['session-a', 'session-b', 'session-c'])
    expect(p.clearedCount).toBe(3)
  })

  it('rolls back on a post-write round-trip mismatch', async () => {
    await p.writeSession('session-a', markerSession())
    const original = await decodeZstd(await readFile(p.locateFor('session-a')))
    p.sabotageVerify = true // readRaw returns the stale original after the write
    const result = await runRewindFix(p, { apply: true, launcherHasMarkers: false })
    expect(outcomeOf(result, 'session-a').status).toBe('failed')
    // The rollback restored the original artifact.
    expect(await decodeZstd(await readFile(p.locateFor('session-a')))).toBe(original)
    expect(p.clearedCount).toBe(0)
  })

  it('skips a session that became loaded between the scan and the write', async () => {
    await p.writeSession('session-a', markerSession())
    const before = await decodeZstd(await readFile(p.locateFor('session-a')))
    p.simulateLoadBetween = true // first isSessionLoaded(each id) is false, later true
    const result = await runRewindFix(p, { apply: true, launcherHasMarkers: false })
    const outcome = outcomeOf(result, 'session-a')
    expect(outcome.status).toBe('skipped')
    expect(outcome.reason).toBe('loaded-between')
    // The file was not written (original marker still present).
    expect(await decodeZstd(await readFile(p.locateFor('session-a')))).toBe(before)
    expect(p.clearedCount).toBe(0)
  })

  it('takes over a stale lock left by a dead process', async () => {
    await p.writeSession('session-a', markerSession())
    await writeFile(`${p.locateFor('session-a')}.rewind-fix.lock`, '999999999') // dead pid
    const result = await runRewindFix(p, { apply: true, launcherHasMarkers: false })
    expect(outcomeOf(result, 'session-a').status).toBe('repaired')
    expect(p.clearedCount).toBe(1)
    // The stale lock is gone after the run.
    await expect(readFile(`${p.locateFor('session-a')}.rewind-fix.lock`)).rejects.toThrow()
  })

  it('refuses a live lock held by the current process', async () => {
    await p.writeSession('session-a', markerSession())
    const lockPath = `${p.locateFor('session-a')}.rewind-fix.lock`
    await writeFile(lockPath, String(process.pid)) // live pid
    const result = await runRewindFix(p, { apply: true, launcherHasMarkers: false })
    const outcome = outcomeOf(result, 'session-a')
    expect(outcome.status).toBe('failed')
    expect(outcome.reason).toBe('locked')
    expect(p.clearedCount).toBe(0)
  })
})
