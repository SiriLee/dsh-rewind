/**
 * Compaction compatibility (issue #2 regression protection): the rewind
 * marker's ghost-step frame must keep the session log replayable by the
 * harness compression pipeline.
 *
 * These tests drive the REAL packages — dsh-session, dsh-token-meter,
 * dsh-compaction — exactly the way the harness does:
 *   - `/compact` (manual or automatic) measures the session through the
 *     token-meter's replay (`measure()`), which throws
 *     "assistant/message at seq N has no matching step/start event" on a bare
 *     (pre-v0.3.4) marker — the issue #2 failure;
 *   - the compaction transaction then selects a surface range and replaces it
 *     with a checkpoint (`user/message` + replace), after which the meter
 *     replays the log again.
 *
 * Every case here must pass for the fix to hold. The marker shape under test
 * is exactly what `executeRewind` appends: an empty `assistant/message`
 * wrapped in its own `step/start` … `step/end` frame with a fresh step
 * number (`markerStepOf`).
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { TokenMeter } from '@deepseek-ai/dsh-token-meter'
import {
  CompactionId,
  compactCheckpointSource,
  toolPairingBalancedAfter,
  toolPairingBalancedBefore,
} from '@deepseek-ai/dsh-compaction'
import { markerStepOf, markerTurnOf, planRewind } from '../src/rewind.ts'

function textMessage(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function assistantMessage(text: string) {
  return createAssistantMessage({
    content: [{ type: 'text', text }],
    source: { provider: 'test', model: 'test-model' },
  })
}

function emptyMarker() {
  return createAssistantMessage({ content: [], source: { provider: 'dsh-rewind', model: 'rewind-marker' } })
}

/**
 * One real-shape harness turn: turn/start → step/start(1) → user → assistant
 * → step/end → turn/end (the agent loop's exact ordering; steps start at 1).
 */
function appendTurn(session: Session, turn: number): void {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  session.append('user/message', textMessage(`question ${turn}`), { surfaceOp: 'append' })
  session.append('assistant/message', { turn, step: 1, message: assistantMessage(`answer ${turn}`) }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

/** A session shaped exactly like a real harness session: two completed turns. */
function buildTurnedSession(): Session {
  const session = Session.create(SessionId('compact-compat'))
  appendTurn(session, 1)
  appendTurn(session, 2)
  return session
}

/**
 * Apply a rewind exactly like `executeRewind` does since v0.3.4: plan against
 * the live surface, then append the ghost-step marker frame.
 * @returns the marker's log seq.
 */
function applyRewind(session: Session, targetSeq: number): number {
  const plan = planRewind(session.events, session.surface.nodes, { kind: 'seq', seq: targetSeq })
  const turn = markerTurnOf(session.events)
  const step = markerStepOf(session.events, turn)
  session.append('step/start', { turn, step })
  const event = session.append('assistant/message', { turn, step, message: emptyMarker() }, {
    surfaceOp: { op: 'replace', start: plan.surfaceStart, end: plan.surfaceEnd },
    sourceEventSeqs: [...plan.shadowedSeqs],
  })
  session.append('step/end', { turn, step })
  return event.seq
}

/**
 * Simulate the compaction transaction (`compactSurfaceRegion`'s commit
 * shape): replace the given surface range with a checkpoint. Asserts the
 * tool-pairing balance at both cut points first, like
 * `validateSurfaceRegion` does.
 */
function simulateCompaction(session: Session, start: number, end: number): void {
  expect(toolPairingBalancedBefore(session, start)).toBe(true)
  expect(toolPairingBalancedAfter(session, end)).toBe(true)
  const nodes = session.surface.nodes
  const startIdx = nodes.indexOf(start)
  const endIdx = nodes.indexOf(end)
  const shadowedSeqs = nodes.slice(startIdx, endIdx + 1)
  const compactionId = CompactionId(`comp-${Date.now()}`)
  const startEvent = session.append('compaction/start', { compactionId, turn: null })
  const summaryEvent = session.append('compaction/summary', {
    compactionId,
    summary: [{ type: 'text', text: 'summarized' }],
    shadowedRange: { start, end },
    shadowedSeqs,
    shadowedTokenCount: 7,
    provider: 'test',
    model: 'test-model',
  })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'summary' }],
    source: compactCheckpointSource(compactionId),
  }), {
    surfaceOp: { op: 'replace', start, end },
    sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...shadowedSeqs],
  })
  session.append('compaction/end', { compactionId, turn: null })
}

/** Compare two derived contexts ignoring random message ids. */
function contentOf(messages: readonly { role: string; content: readonly { type: string; text?: unknown }[] }[]): string[] {
  return messages.map(m => `${m.role}:${(m.content[0] as { text?: string })?.text ?? ''}`)
}

describe('compact compatibility (issue #2 regression)', () => {
  it('token-meter replay passes with the ghost-step marker (bare markers throw)', () => {
    const session = buildTurnedSession()
    applyRewind(session, 8) // rewind to turn 2's question (seq 8)
    const meter = new TokenMeter(new Context())
    expect(() => meter.measure(session)).not.toThrow()
    const measurement = meter.measure(session)
    // Surface [user1, assistant1, marker]: the marker is empty → 0 tokens,
    // and the meter prices exactly the on-surface nodes.
    expect(measurement.nodes.map(n => n.seq)).toEqual([2, 3, session.events.at(-2)!.seq])
    expect(measurement.nodes.find(n => n.seq === session.events.at(-2)!.seq)!.tokens).toBe(0)
  })

  it('agent context is byte-identical to the pre-v0.3.4 bare marker (same surface)', () => {
    const ghost = buildTurnedSession()
    applyRewind(ghost, 8)
    // The pre-v0.3.4 shape: the same marker WITHOUT the step frame. Same
    // surface → the model must see exactly the same messages.
    const bare = buildTurnedSession()
    const plan = planRewind(bare.events, bare.surface.nodes, { kind: 'seq', seq: 8 })
    bare.append('assistant/message', { turn: markerTurnOf(bare.events), step: 1, message: emptyMarker() }, {
      surfaceOp: { op: 'replace', start: plan.surfaceStart, end: plan.surfaceEnd },
      sourceEventSeqs: [...plan.shadowedSeqs],
    })
    expect([...ghost.surface.nodes].length).toBe([...bare.surface.nodes].length)
    expect(contentOf(ghost.deriveMessages())).toEqual(contentOf(bare.deriveMessages()))
    expect(contentOf(ghost.deriveMessages())).toEqual(['user:question 1', 'assistant:answer 1'])
  })

  it('the compaction transaction works and the meter replays the post-compaction log', () => {
    const session = buildTurnedSession()
    applyRewind(session, 8)
    const nodes = [...session.surface.nodes] // [user1, assistant1, marker]
    simulateCompaction(session, nodes[0]!, nodes[nodes.length - 1]!)
    const measurement = new TokenMeter(new Context()).measure(session)
    expect(measurement.nodes.map(n => n.seq)).toEqual([session.events.at(-2)!.seq])
  })

  it('multi-rewind + interleaved real turns + compaction stays replayable', () => {
    const session = buildTurnedSession()
    applyRewind(session, 8) // back to turn 2's question
    appendTurn(session, 3) // real turn 3 continues
    applyRewind(session, 2) // back to turn 1's question
    appendTurn(session, 4) // real turn 4

    const meter = new TokenMeter(new Context())
    expect(() => meter.measure(session)).not.toThrow()
    const before = meter.measure(session)

    const nodes = [...session.surface.nodes]
    simulateCompaction(session, nodes[0]!, nodes[nodes.length - 1]!)
    expect(() => meter.measure(session)).not.toThrow()
    expect(meter.measure(session).nodes).toHaveLength(1)
    expect(before.nodes.length).toBeGreaterThan(1)
  })

  it('every step/start in the log is unique (client "more than one start Match" immunity)', () => {
    const session = buildTurnedSession()
    applyRewind(session, 8)
    appendTurn(session, 3)
    applyRewind(session, 2)
    const seen = new Set<string>()
    for (const event of session.events) {
      if (event.type !== 'step/start') continue
      const key = `${event.data.turn}:${event.data.step}`
      expect(seen.has(key)).toBe(false)
      seen.add(key)
    }
  })
})
