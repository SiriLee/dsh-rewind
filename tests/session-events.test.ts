/**
 * Session event-log channel adapter probe (dsh-rewind × DSH 0.1.2).
 *
 * Harness 0.1.1-rc.2 exposes the whole log as `Session.events`; 0.1.2 removed
 * that member and replaced it with `snapshotEvents()` (and `eventAt` /
 * `ownEvents` / `seq`). `eventsOf` reads the full log through whichever channel
 * the host exposes, so the plugin keeps one code path across both. These
 * probes lock the branch selection and the empty-log fallback.
 *
 * The adapter is type-only coupled to `Session`; the test drives it with
 * minimal structural doubles (never a real Session) so a future harness shape
 * is exercised without the whole session machinery.
 */
import { describe, expect, it } from 'vitest'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { eventsOf } from '../src/session-events.ts'

/** Minimal event log entry the adapter only passes through (never inspects). */
const log = (n: number): readonly SessionEvent[] =>
  Array.from({ length: n }, (_, i) => ({ type: 'turn/start', seq: i, time: i, data: { turn: i } }) as SessionEvent)

/** A 0.1.2-shaped session: `snapshotEvents` present, `events` absent. */
const session012 = (events: readonly SessionEvent[]): unknown => ({
  snapshotEvents: () => events,
})

/** A 0.1.1-shaped session: `events` present, `snapshotEvents` absent. */
const session011 = (events: readonly SessionEvent[]): unknown => ({
  events,
})

describe('eventsOf (session channel adapter: 0.1.1 events / 0.1.2 snapshotEvents)', () => {
  it('reads the 0.1.1 `events` member when present', () => {
    const e = log(3)
    expect(eventsOf(session011(e) as Session)).toBe(e)
  })

  it('reads the 0.1.2 `snapshotEvents()` when the host removes `events`', () => {
    const e = log(2)
    expect(eventsOf(session012(e) as Session)).toBe(e)
  })

  it('prefers `snapshotEvents` when both channels are exposed', () => {
    const viaSnapshot = log(5)
    const viaEvents = log(1)
    const both = {
      snapshotEvents: () => viaSnapshot,
      events: viaEvents,
    }
    expect(eventsOf(both as unknown as Session)).toBe(viaSnapshot)
  })

  it('returns a stable array identity across repeated reads', () => {
    // The harness's `snapshotEvents()` caches its snapshot until the next
    // append; `eventsOf` only delegates, so a consumer reading many times sees
    // the same array (never a fresh copy per read).
    const e = log(4)
    const session = { snapshotEvents: () => e }
    expect(eventsOf(session as unknown as Session)).toBe(e)
    expect(eventsOf(session as unknown as Session)).toBe(e)
  })

  it('falls back to an empty log when the session exposes neither member', () => {
    expect(eventsOf({} as Session)).toEqual([])
  })
})
