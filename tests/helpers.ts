/**
 * Shared test utilities for the compatibility probe suites.
 *
 * Everything here drives the REAL harness packages (dsh-session,
 * dsh-llm, dsh-compaction) exactly the way the host plugin does, so a probe
 * failure means the plugin's mechanism is incompatible with a real DSH
 * consumer — not a bug in a mock.
 */
import { ToolCallId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { AssistantMessage, UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, type SessionSeq } from '@deepseek-ai/dsh-session'
import {
  CompactionId,
  compactCheckpointSource,
  toolPairingBalancedAfter,
  toolPairingBalancedBefore,
} from '@deepseek-ai/dsh-compaction'
import { markerStepOf, markerTurnOf, planRewind } from '../src/rewind.ts'
import { Context } from '@deepseek-ai/cordis'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { TokenMeter } from '@deepseek-ai/dsh-token-meter'

/**
 * Build a token meter whose context has the session-projections service
 * registered. DSH 0.1.2 (0.1.2-rc.1) made TokenMeter a cordis service that
 * requires `ctx.sessionProjections`; registering the projection registry on a
 * fresh context satisfies that, so the probe can `measure()` a session the way
 * a real harness consumer would.
 */
export function newMeter(): TokenMeter {
  const ctx = new Context()
  new SessionProjectionRegistry(ctx)
  return new TokenMeter(ctx)
}

export function textMessage(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

export function assistantMessage(text: string): AssistantMessage {
  return createAssistantMessage({
    content: [{ type: 'text', text }],
    source: { provider: 'test', model: 'test-model' },
  })
}

/** The empty-content marker the host appends: derives to null (no model noise). */
export function emptyMarker(): AssistantMessage {
  return createAssistantMessage({ content: [], source: { provider: 'dsh-rewind', model: 'rewind-marker' } })
}

/**
 * One real-shape harness turn: turn/start → step/start(1) → user →
 * assistant → step/end → turn/end (the agent loop's exact ordering; steps
 * start at 1). The turn is COMPLETE and balanced — the baseline shape every
 * scenario generator composes from.
 */
export function appendTurn(session: Session, turn: number): void {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  session.append('user/message', textMessage(`question ${turn}`), { surfaceOp: 'append' })
  session.append('assistant/message', { turn, step: 1, message: assistantMessage(`answer ${turn}`) }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

/**
 * A turn whose assistant step performs one tool call with a matching result —
 * a balanced tool pair on the surface (what the compaction region validator
 * requires). Shape: user → assistant(tool-call) → tool/call → tool/result →
 * assistant(text) → step/end → turn/end.
 */
export function appendToolTurn(session: Session, turn: number, callId: ToolCallId): void {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  session.append('user/message', textMessage(`tool question ${turn}`), { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn,
    step: 1,
    message: createAssistantMessage({
      content: [{ type: 'tool-call', id: callId, name: 'echo', arguments: '{}' }],
      source: { provider: 'test', model: 'test-model' },
    }),
  }, { surfaceOp: 'append' })
  session.append('tool/call', { turn, step: 1, callId, name: 'echo', arguments: '{}' })
  session.append('tool/result', {
    turn,
    step: 1,
    message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'ok' }], isError: false }),
  }, { surfaceOp: 'append' })
  session.append('assistant/message', { turn, step: 1, message: assistantMessage(`tool answer ${turn}`) }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

/** A session shaped exactly like a real harness session: two completed turns. */
export function buildTurnedSession(): Session {
  const session = Session.create(SessionId('compat-session'))
  appendTurn(session, 1)
  appendTurn(session, 2)
  return session
}

/**
 * Apply a rewind exactly like `executeRewind` does since v0.3.4: plan against
 * the live surface, then append the ghost-step marker frame
 * (step/start → empty assistant/message → step/end).
 * @returns the marker's log seq.
 */
export function applyRewind(session: Session, targetSeq: number): number {
  const plan = planRewind(session.snapshotEvents(), session.surface.nodes, { kind: 'seq', seq: targetSeq })
  const turn = markerTurnOf(session.snapshotEvents())
  const step = markerStepOf(session.snapshotEvents(), turn)
  session.append('step/start', { turn, step })
  const event = session.append('assistant/message', { turn, step, message: emptyMarker() }, {
    surfaceOp: { op: 'replace', start: plan.surfaceStart as SessionSeq, end: plan.surfaceEnd as SessionSeq },
    sourceEventSeqs: [...plan.shadowedSeqs] as SessionSeq[],
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
export function simulateCompaction(session: Session, start: number, end: number): void {
  expectBalance(session, start, end)
  const nodes = session.surface.nodes
  const startIdx = nodes.indexOf(start as SessionSeq)
  const endIdx = nodes.indexOf(end as SessionSeq)
  const shadowedSeqs = nodes.slice(startIdx, endIdx + 1)
  const compactionId = CompactionId(`comp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  const startEvent = session.append('compaction/start', { compactionId, turn: null })
  const summaryEvent = session.append('compaction/summary', {
    compactionId,
    summary: [{ type: 'text', text: 'summarized' }],
    shadowedRange: { start: start as SessionSeq, end: end as SessionSeq },
    shadowedSeqs,
    shadowedTokenCount: 7,
    provider: 'test',
    model: 'test-model',
  })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'summary' }],
    source: compactCheckpointSource(compactionId),
  }), {
    surfaceOp: { op: 'replace', start: start as SessionSeq, end: end as SessionSeq },
    sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...shadowedSeqs],
  })
  session.append('compaction/end', { compactionId, turn: null })
}

/** Assert the tool-pairing balance the compaction region validator requires. */
export function expectBalance(session: Session, start: number, end: number): void {
  const before = toolPairingBalancedBefore(session, start as SessionSeq)
  const after = toolPairingBalancedAfter(session, end as SessionSeq)
  if (before !== true || after !== true) {
    throw new Error(`tool-pairing balance violated at [${start}, ${end}]: before=${before} after=${after}`)
  }
}

/**
 * Mini-replay of the client conversation-context "turn-tail" matching rule
 * (dsh-client-ui-conversation): every `turn/start T` must be the FIRST match
 * for turn T — no `assistant/message`/`turn/end`/tool event may precede it,
 * or the runtime throws "…turn-tail<T> received an update before its start
 * Match" and history load fails. Also asserts every `step/start` is unique
 * (a reused step number makes history load fail with "more than one start
 * Match"). Throws when any invariant is violated.
 */
export function assertTurnTailOrdering(events: readonly unknown[]): void {
  const firstRole = new Map<string, 'start' | 'update'>()
  const stepStarts = new Set<string>()
  for (const raw of events) {
    const event = raw as { type: string; data: { turn?: number; step?: number } }
    let id: string | undefined
    let role: 'start' | 'update' | undefined
    if (event.type === 'turn/start') {
      id = String(event.data.turn)
      role = 'start'
    } else if (event.type === 'turn/end' || event.type === 'tool/call' || event.type === 'tool/result') {
      id = String(event.data.turn)
      role = 'update'
    } else if (event.type === 'assistant/message') {
      id = String(event.data.turn)
      role = 'update'
    }
    if (id !== undefined && role !== undefined) {
      const first = firstRole.get(id)
      if (first === undefined) firstRole.set(id, role)
      else if (first === 'start' && role === 'update') {
        // update after start: legal (a turn tail is a trailing update)
      } else if (first === 'update' && role === 'start') {
        throw new Error(`turn-tail ordering violated: turn ${id} received an update before its start Match`)
      }
    }
    if (event.type === 'step/start' && event.data.turn !== undefined && event.data.step !== undefined) {
      const key = `${event.data.turn}:${event.data.step}`
      if (stepStarts.has(key)) {
        throw new Error(`step/start reused for ${key}: "more than one start Match"`)
      }
      stepStarts.add(key)
    }
  }
}
