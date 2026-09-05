/**
 * Reproduction of the hypothetical host-restart flow:
 *
 *   1. open plugin conversation, do a rewind;
 *   2. close & restart the host (session log replayed via `Session.create`),
 *      continue the conversation with a real turn;
 *   3. close & restart again, continue with a real turn, then rewind again.
 *
 * Every restart is modeled as `Session.create(id, events)` — the same
 * resume-preflight replay the harness performs when reloading a persisted
 * session. Each probe asserts the invariants the plugin must preserve
 * (replayability, surface consistency, step/turn structure, turn-tail
 * ordering).
 */
import { describe, expect, it } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { applyRewind, appendToolTurn, appendTurn, assertTurnTailOrdering, buildTurnedSession, newMeter } from './helpers.ts'

/** Restart the host: replay the log through a fresh session (resume preflight). */
function restart(session: Session): Session {
  return Session.create(session.id, session.snapshotEvents())
}

/** Probe the invariants over the current session log. */
function probe(session: Session): void {
  // I1 replayability (token-meter + resume preflight)
  expect(() => newMeter().measure(session)).not.toThrow()
  expect(() => Session.create(session.id, session.snapshotEvents())).not.toThrow()
  // I3 turn-tail ordering + step structure
  expect(() => assertTurnTailOrdering(session.snapshotEvents())).not.toThrow()
}

/** Latest surface human user seq. */
function latestUserSeq(session: Session): number {
  const surface = new Set(session.surface.nodes)
  for (let i = session.snapshotEvents().length - 1; i >= 0; i--) {
    const event = session.snapshotEvents()[i]!
    if (event.type === 'user/message'
      && (event.data as { source?: { kind?: string } }).source?.kind === 'user'
      && surface.has(event.seq)) return event.seq
  }
  throw new Error('no human user on surface')
}

describe('restart flow: rewind -> restart -> continue -> restart -> rewind', () => {
  it('turn-flow: rewind, restart, real turn, restart, real turn + rewind', () => {
    let session = buildTurnedSession() // turns 1, 2
    probe(session)

    // Step 1: rewind to turn 1's question.
    const u1 = session.surface.nodes.find(seq =>
      session.snapshotEvents().find(e => e.seq === seq)?.type === 'user/message')!
    applyRewind(session, u1)
    probe(session)

    // Step 2: restart, continue with a real turn (turn 3).
    session = restart(session)
    probe(session)
    appendTurn(session, 3)
    probe(session)

    // Step 3: restart again, continue with a real turn (turn 4).
    session = restart(session)
    probe(session)
    appendTurn(session, 4)
    probe(session)

    // Step 4: rewind again to the newest human user.
    applyRewind(session, latestUserSeq(session))
    probe(session)

    // The marker is a turn-less `user/message` (v2 surface replace), so it
    // can never collide with a future real turn number.
    const marker = [...session.snapshotEvents()].reverse().find(e => e.type === 'user/message'
      && (e.data as { source?: { kind?: string }; content?: unknown[] }).source?.kind === 'plugin'
      && (e.data as { content?: unknown[] })?.content?.length === 0)
    expect(marker).toBeDefined()

    probe(session)
  })

  it('tool-turn flow: rewind, restart, tool turn, restart, rewind', () => {
    let session = buildTurnedSession()
    appendToolTurn(session, 3, ToolCallId('restart-call'))
    probe(session)

    applyRewind(session, latestUserSeq(session))
    probe(session)

    session = restart(session)
    appendToolTurn(session, 4, ToolCallId('restart-call-2'))
    probe(session)

    session = restart(session)
    applyRewind(session, latestUserSeq(session))
    probe(session)
  })

  it('adversarial: restart then rewind immediately (no real turn between)', () => {
    let session = buildTurnedSession()
    applyRewind(session, latestUserSeq(session)) // marker reuses turn 2
    probe(session)

    // Restart, then rewind again right away — the marker must reuse the same
    // last-started turn with a NEW step (no step/start collision).
    session = restart(session)
    applyRewind(session, latestUserSeq(session))
    probe(session)

    // Continue with a real turn after the second restart.
    session = restart(session)
    appendTurn(session, 3)
    probe(session)
  })

  it('adversarial: rewind, restart, real turn, rewind, restart, rewind (back-to-back rewinds across restarts)', () => {
    let session = buildTurnedSession()
    applyRewind(session, latestUserSeq(session))
    probe(session)

    session = restart(session)
    appendTurn(session, 3)
    probe(session)

    // Second rewind shadows turn 3, then restart again and rewind once more.
    applyRewind(session, latestUserSeq(session))
    probe(session)

    session = restart(session)
    applyRewind(session, latestUserSeq(session))
    probe(session)

    session = restart(session)
    appendTurn(session, 4)
    probe(session)
  })
})
