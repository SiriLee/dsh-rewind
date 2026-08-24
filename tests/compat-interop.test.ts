/**
 * Compatibility invariants I5–I7 probes — interop with compaction and the
 * tool pipeline (test-driven investigation).
 *
 *   I5  compaction interop — rewind never corrupts tool-pairing balance:
 *       a cancelled-turn leftover (assistant tool-call with no result) is
 *       shadowed away by a rewind so later compaction regions stay
 *       selectable; a target shadowed by a compaction checkpoint is refused
 *       with the plugin's own error (not a crash); a post-rewind compaction
 *       transaction stays replayable.
 *   I7  client ordering — the whole log (including tool/result events and
 *       ghost-step frames) satisfies the client conversation builder's
 *       turn-tail ordering and one-start-per-step rules.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId, createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { TokenMeter } from '@deepseek-ai/dsh-token-meter'
import { toolPairingBalancedAfter, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'
import { RewindError, planRewind } from '../src/rewind.ts'
import {
  applyRewind,
  appendToolTurn,
  appendTurn,
  assertTurnTailOrdering,
  buildTurnedSession,
  simulateCompaction,
  textMessage,
} from './helpers.ts'

/**
 * A cancelled turn: assistant issues one tool-call, the result never lands.
 * Mirrors the real agent loop, whose `finally` always closes the step and
 * the turn even on cancellation — only the tool RESULT is missing.
 */
function appendCancelledToolTurn(session: Session, turn: number, callId: CallId): void {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  session.append('user/message', textMessage(`cancelled question ${turn}`), { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn,
    step: 1,
    message: createAssistantMessage({
      content: [{ type: 'tool-call', id: callId, name: 'echo', arguments: '{}' }],
      source: { provider: 'test', model: 'test-model' },
    }),
  }, { surfaceOp: 'append' })
  // No tool/result — the turn was cancelled — but the step and turn DO close,
  // exactly like the agent loop's finally blocks.
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'aborted', reason: { kind: 'user' } } })
}

/** Latest surface node seq of the given type (human user only for user/message). */
function lastSurfaceSeqOf(session: Session, type: string): number {
  const surface = new Set(session.surface.nodes)
  for (let i = session.events.length - 1; i >= 0; i--) {
    const event = session.events[i]!
    if (event.type !== type || !surface.has(event.seq)) continue
    if (type === 'user/message') {
      const source = (event.data as { source?: { kind?: string } }).source
      if (source?.kind !== 'user') continue // skip compact checkpoints
    }
    return event.seq
  }
  throw new Error(`no surface ${type} found`)
}

describe('I5 compaction interop (probe: tool-pairing balance)', () => {
  it('a cancelled-turn leftover tool-call is shadowed away by a rewind, restoring balance', () => {
    const session = Session.create(SessionId('interop-unbalanced'))
    appendTurn(session, 1)
    appendCancelledToolTurn(session, 2, CallId('call-cancelled'))

    // Before the rewind the surface tail is unbalanced: the cut AFTER the
    // dangling tool-call node is mid-pair (open tool-call).
    const danglingCut = session.surface.nodes.at(-1)!
    expect(toolPairingBalancedBefore(session, danglingCut)).toBe(true)
    expect(toolPairingBalancedAfter(session, danglingCut)).toBe(false)

    // Rewind to turn 1's question: the dangling tool-call leaves the surface.
    const u1 = session.surface.nodes.find(seq =>
      session.events.find(e => e.seq === seq)?.type === 'user/message')!
    applyRewind(session, u1)

    const markerSeq = session.surface.nodes.at(-1)!
    expect(toolPairingBalancedAfter(session, markerSeq)).toBe(true)
    // The whole current surface is now a legal compaction region.
    const nodes = [...session.surface.nodes]
    expect(() => simulateCompaction(session, nodes[0]!, nodes[nodes.length - 1]!)).not.toThrow()
    // And the compacted log stays replayable.
    expect(() => new TokenMeter(new Context()).measure(session)).not.toThrow()
    expect(() => Session.create(session.id, session.events)).not.toThrow()
  })

  it('a rewind target shadowed by a compaction checkpoint is refused (not a crash)', () => {
    const session = buildTurnedSession() // turns 1, 2
    appendTurn(session, 3)
    const nodes = [...session.surface.nodes]
    simulateCompaction(session, nodes[0]!, nodes[1]!) // shadow turn 1

    // seq 2 (turn 1's question) is no longer on the surface.
    expect(() => planRewind(session.events, session.surface.nodes, { kind: 'seq', seq: 2 }))
      .toThrow(RewindError)
    try {
      planRewind(session.events, session.surface.nodes, { kind: 'seq', seq: 2 })
      expect.unreachable('expected RewindError')
    } catch (error) {
      expect(error).toBeInstanceOf(RewindError)
      expect((error as RewindError).code).toBe('not-on-surface')
    }

    // A compaction checkpoint itself is not a human user message → refused.
    const checkpointSeq = session.surface.nodes[0]!
    expect(() => planRewind(session.events, session.surface.nodes, { kind: 'seq', seq: checkpointSeq }))
      .toThrow(RewindError)
    try {
      planRewind(session.events, session.surface.nodes, { kind: 'seq', seq: checkpointSeq })
      expect.unreachable('expected RewindError')
    } catch (error) {
      expect((error as RewindError).code).toBe('not-a-user-message')
    }

    // Rewinding to a still-visible human message keeps working after a compact.
    const u3 = lastSurfaceSeqOf(session, 'user/message')
    expect(() => applyRewind(session, u3)).not.toThrow()
    expect(() => new TokenMeter(new Context()).measure(session)).not.toThrow()
    expect(() => Session.create(session.id, session.events)).not.toThrow()
  })

  it('a post-rewind compaction of the whole surface is legal and replayable', () => {
    const session = buildTurnedSession()
    applyRewind(session, lastSurfaceSeqOf(session, 'user/message'))
    const nodes = [...session.surface.nodes]
    expect(() => simulateCompaction(session, nodes[0]!, nodes[nodes.length - 1]!)).not.toThrow()
    expect(() => new TokenMeter(new Context()).measure(session)).not.toThrow()
    expect(() => Session.create(session.id, session.events)).not.toThrow()
  })

  it('R-OPENSTEP defense: an unclosed step refuses the rewind up front, and rewinds recover once the log is repaired', () => {
    // A log carrying an UNCLOSED step/start (abnormal log — manual edit,
    // crash between step/start and the agent loop's finally-closing step/end,
    // or a buggy third-party plugin) is accepted by Session.append. The
    // plugin now DETECTS it in planRewind and refuses the rewind with a typed
    // error (RewindError 'open-step') instead of appending a ghost-step frame
    // that would permanently break token-meter replay (and /compact) for the
    // session. The refusal is live detection — it never mutates the log — so
    // repairing the log restores rewinds with no unlock step.
    const session = Session.create(SessionId('interop-openstep'))
    appendTurn(session, 1)
    session.append('turn/start', { turn: 2 })
    session.append('step/start', { turn: 2, step: 1 }) // never closed
    session.append('user/message', textMessage('q2'), { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn: 2,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'tool-call', id: CallId('call-dangling'), name: 'echo', arguments: '{}' }],
        source: { provider: 'test', model: 'test-model' },
      }),
    }, { surfaceOp: 'append' })
    // no step/end — the log is abnormal from here on

    const target = lastSurfaceSeqOf(session, 'user/message')
    expect(() => applyRewind(session, target)).toThrow(RewindError)
    try {
      applyRewind(session, target)
      expect.unreachable('expected RewindError')
    } catch (error) {
      expect(error).toBeInstanceOf(RewindError)
      expect((error as RewindError).code).toBe('open-step')
    }
    // The log is untouched by the refusal.
    expect(session.events.length).toBe(10) // turn 1 (6) + turn 2 head (4)

    // Repair the log by closing the dangling step (what a fixed harness crash
    // recovery would do), then the rewind works again and the log replays.
    session.append('step/end', { turn: 2, step: 1 })
    session.append('turn/end', { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } })
    expect(() => applyRewind(session, target)).not.toThrow()
    expect(() => new TokenMeter(new Context()).measure(session)).not.toThrow()
    expect(() => Session.create(session.id, session.events)).not.toThrow()
  })
})

describe('I7 client ordering (probe: turn-tail + one-start-per-step)', () => {
  it('tool turns, rewind markers and ghost steps keep client ordering legal', () => {
    const session = Session.create(SessionId('interop-ordering'))
    appendToolTurn(session, 1, CallId('call-1'))
    appendTurn(session, 2)
    applyRewind(session, lastSurfaceSeqOf(session, 'user/message'))
    appendToolTurn(session, 3, CallId('call-2'))
    applyRewind(session, lastSurfaceSeqOf(session, 'user/message'))
    expect(() => assertTurnTailOrdering(session.events)).not.toThrow()
  })

  it('the resumed log (Session.create replay) satisfies the same ordering', () => {
    const session = Session.create(SessionId('interop-ordering'))
    appendToolTurn(session, 1, CallId('call-1'))
    appendTurn(session, 2)
    applyRewind(session, lastSurfaceSeqOf(session, 'user/message'))
    const resumed = Session.create(session.id, session.events)
    expect(() => assertTurnTailOrdering(resumed.events)).not.toThrow()
  })
})
