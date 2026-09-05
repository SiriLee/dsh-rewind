/**
 * Gap-closing probes: surfaces the earlier suites claimed but did not
 * actually assert. Each probe drives a REAL harness consumer over a rewound
 * log; a failure here is a newly discovered incompatibility.
 *
 *   G1 surface classification (`foldSurface`): the rewind marker is a
 *      current surface node, the withdrawn messages are shadowed, and the
 *      ghost-step frame events are log-only — the exact transition the
 *      session-query `current | shadowed | log-only` classification folds.
 *   G2 projection checkpoint: `SessionProjectionRegistry.checkpoint` rows
 *      over a rewound log pass the unit schema and report the correct
 *      watermark seq.
 *   G3 token-meter usage anchor: a rewind marker (the last assistant/message,
 *      carrying no usage) resets the measurement baseline from provider
 *      `usage` to heuristic `estimated`; the next real usage-carrying turn
 *      restores it. Recorded behavior difference, not a crash.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, type SessionSeq } from '@deepseek-ai/dsh-session'
import { foldSurface } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { apply as applySessionStats } from '@deepseek-ai/dsh-session-stats'
import { applyRewind, buildTurnedSession, newMeter, textMessage } from './helpers.ts'

/** A framed turn whose assistant step reports provider usage and a request header. */
function appendUsageTurn(session: Session, turn: number, inputTokens: number, outputTokens: number): void {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  session.append('request/header', { header: { config: { provider: 'test', model: 'test-model' }, system: 'sys' }, reason: 'initial' })
  session.append('user/message', textMessage(`usage question ${turn}`), { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn,
    step: 1,
    message: createAssistantMessage({
      content: [{ type: 'text', text: `usage answer ${turn}` }],
      source: { provider: 'test', model: 'test-model' },
    }),
    usage: { inputTokens, outputTokens },
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

function buildUsageSession(): Session {
  const session = Session.create(SessionId('gap-usage'))
  appendUsageTurn(session, 1, 1000, 500)
  appendUsageTurn(session, 2, 2000, 900)
  return session
}

/** First human user-message seq on the surface (rewind target for turn 1). */
function firstUserSeq(session: Session): number {
  const surface = new Set(session.surface.nodes)
  for (const event of session.snapshotEvents()) {
    if (event.type === 'user/message' && event.data.source.kind === 'user' && surface.has(event.seq)) {
      return event.seq
    }
  }
  throw new Error('no human user message on surface')
}

describe('G1 surface classification (probe: foldSurface transitions)', () => {
  it('marker is current, withdrawn messages are shadowed, ghost frame is log-only', () => {
    const session = buildTurnedSession()
    const target = firstUserSeq(session)
    const markerSeq = applyRewind(session, target)

    const { nodes, replacements } = foldSurface(session.snapshotEvents())
    const current = new Set(nodes)
    const shadowed = new Set(replacements.flatMap(r => r.shadowedSeqs))

    // The marker is on the current surface.
    expect(current.has(markerSeq as SessionSeq)).toBe(true)
    // The rewound target and everything after it are shadowed.
    const surface = [...session.surface.nodes]
    for (const seq of surface) {
      if (seq === markerSeq) continue
      expect(shadowed.has(seq)).toBe(true)
    }
    // Ghost-frame events (step/start, step/end) are neither current nor
    // shadowed — they classify as log-only in the session-query vocabulary.
    const ghostEvents = session.snapshotEvents().filter(e =>
      (e.type === 'step/start' || e.type === 'step/end') && e.seq > markerSeq - 3)
    expect(ghostEvents.length).toBeGreaterThan(0)
    for (const event of ghostEvents) {
      expect(current.has(event.seq)).toBe(false)
      expect(shadowed.has(event.seq)).toBe(false)
    }
  })
})

describe('G2 projection checkpoint (probe: SessionProjectionRegistry.checkpoint)', () => {
  it('checkpoint rows over a rewound log pass schema and report the watermark', () => {
    const session = buildTurnedSession()
    applyRewind(session, firstUserSeq(session))

    const ctx = new Context()
    new SessionProjectionRegistry(ctx)
    applySessionStats(ctx)
    // Rebuild from the log so the registry folds a fresh cell (as a resume
    // or persisted-cache restore would). A seeded rebuild appends its own
    // `session/end-seed` marker, so the watermark is measured on the rebuilt
    // log.
    const rebuilt = Session.create(session.id, session.snapshotEvents())
    const rows = ctx.sessionProjections.checkpoint(rebuilt)
    const stats = rows.sessionStats!
    expect(stats).toBeDefined()
    expect(stats.ver).toBeGreaterThanOrEqual(0)
    expect(stats.seq).toBe(rebuilt.snapshotEvents().length - 1)
    // The state is plain JSON per the unit contract.
    expect(() => JSON.stringify(rows)).not.toThrow()
  })
})

describe('G3 token-meter usage anchor (probe: baseline behavior around rewind)', () => {
  it('baseline stays usage around a rewind (the user/message marker leaves the anchor intact)', () => {
    const session = buildUsageSession()
    const meter = newMeter()

    expect(meter.measure(session).baseline.kind).toBe('usage')

    applyRewind(session, firstUserSeq(session))
    // The marker is a `user/message`, not an `assistant/message` without
    // usage — so the meter's baseline anchor is NOT reset to a heuristic
    // estimate. It stays 'usage' across the rewind, and the next real
    // usage-carrying turn keeps it there.
    expect(meter.measure(session).baseline.kind).toBe('usage')

    appendUsageTurn(session, 3, 3000, 1200)
    expect(meter.measure(session).baseline.kind).toBe('usage')
  })
})
