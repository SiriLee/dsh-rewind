/**
 * Cross-channel session event-log reader.
 *
 * This is a "0.1.1-rc.2 ↔ 0.1.2-rc.1" dual-channel reader. Harness 0.1.1-rc.2
 * exposes the full log as `Session.events` (`get events(): readonly
 * SessionEvent[]`); the 0.1.2 line (alpha.4+, now 0.1.2-rc.1) removed that
 * member and replaced it with the on-demand APIs `snapshotEvents(from?, to?)`
 * (half-open range, internally cached), `eventAt(seq)`, `ownEvents()` and
 * `seq`. This module reads the full log through whichever channel the host
 * exposes, so the plugin keeps one code path across both endpoints.
 *
 * `snapshotEvents()` is deliberately preferred over `ownEvents()`:
 * `snapshotEvents()` defaults to the whole log (including any fork-inherited
 * prefix), which is exactly what `Session.events` returned on 0.1.1-rc.2 — the
 * rewind semantics are preserved for fork-seeded sessions. `ownEvents()`
 * would drop the inherited prefix and change behaviour.
 *
 * @module dsh-rewind/session-events
 */

import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

/**
 * Read the full event log of a session, transparently across harness channels:
 * - 0.1.1-rc.2 (`Session.events`): the live immutable log array.
 * - 0.1.2-rc.1 (`Session.snapshotEvents()`): a deep-frozen snapshot, cached
 *   by the session until the next append. This is the single 0.1.2-line
 *   channel (alpha.2/3 still exposed `events` and thus fall into the
 *   0.1.1-rc.2 branch below).
 *
 * Falls back to an empty log when the session exposes neither member (a future
 * harness shape) rather than throwing — callers already treat the empty log as
 * "no candidates".
 *
 * @param session - the session to read.
 * @returns the full event log in log order (the same shape 0.1.1-rc.2's `events`
 *   returned, so existing consumers are unchanged).
 */
export function eventsOf(session: Session): readonly SessionEvent[] {
  const s = session as unknown as {
    snapshotEvents?: () => readonly SessionEvent[]
    events?: readonly SessionEvent[]
  }
  if (s.snapshotEvents !== undefined) return s.snapshotEvents()
  if (s.events !== undefined) return s.events
  return []
}
