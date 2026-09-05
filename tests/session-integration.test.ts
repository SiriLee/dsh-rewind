/**
 * Integration tests against a real dsh-session: build a session log, plan a
 * rewind (withdraw semantics: the target AND everything after it), append the
 * empty `user/message` marker with a surface replace, and verify the surface
 * and the derived model messages — the exact mechanism `executeRewind` uses.
 *
 * The marker is a `user/message` (v2 reserves surface `replace` to a node
 * that cites the shadowed seqs via `sourceEventSeqs`; `assistant/message` can
 * no longer carry them). An empty `user/message` derives to itself, so it
 * stays as a present-but-empty user turn at the surface tail — it carries no
 * language, but it is no longer projected to `null` the way the old empty
 * `assistant/message` marker was.
 */
import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { AssistantMessage, UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, type SessionEvent, type SessionSeq } from '@deepseek-ai/dsh-session'
import { planRewind } from '../src/rewind.ts'

function textMessage(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function assistantMessage(text: string): AssistantMessage {
  return createAssistantMessage({
    content: [{ type: 'text', text }],
    source: { provider: 'test', model: 'test-model' },
  })
}

/** The empty-content `user/message` rewind marker the host appends. */
function emptyMarker(): UserMessage {
  return createUserMessage({ content: [], source: { kind: 'plugin', plugin: 'dsh-rewind' } })
}

/**
 * Append the rewind marker (a single empty `user/message` surface replace) —
 * the exact shape the host's `executeRewind` appends on the v0.1.3/v2 line:
 * no ghost `step/start`…`step/end` frame, because the token-meter's step
 * machine ignores `user/message` and the session invariant imposes no
 * open-turn requirement on it.
 */
function applyRewind(session: Session, plan: ReturnType<typeof planRewind>): number {
  const event = session.append('user/message', emptyMarker(), {
    surfaceOp: { op: 'replace', start: plan.surfaceStart as SessionSeq, end: plan.surfaceEnd as SessionSeq },
    sourceEventSeqs: [...plan.shadowedSeqs] as SessionSeq[],
  })
  return event.seq
}

/** A session with two user/assistant pairs but no turn brackets. */
function buildSession(): Session {
  const session = Session.create(SessionId('rewind-integration'))
  session.append('user/message', textMessage('first question'), { surfaceOp: 'append' })
  session.append('assistant/message', { turn: 0, step: 0, message: assistantMessage('first answer') }, { surfaceOp: 'append' })
  session.append('user/message', textMessage('second question'), { surfaceOp: 'append' })
  session.append('assistant/message', { turn: 1, step: 0, message: assistantMessage('second answer') }, { surfaceOp: 'append' })
  return session
}

/**
 * Mini-replay of the client conversation-context "turn-tail" matching rule
 * (dsh-client-ui-conversation): every `turn/start T` must be the FIRST match
 * for turn T — no `assistant/message`/`turn/end`/tool event may precede it,
 * or the runtime throws "…turn-tail<T> received an update before its start
 * Match" and history load fails. Throws when the invariant is violated.
 */
function assertTurnTailOrdering(events: readonly SessionEvent[]): void {
  const firstRole = new Map<string, 'start' | 'update'>()
  for (const event of events) {
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
    if (id === undefined || role === undefined) continue
    const first = firstRole.get(id)
    if (first === undefined) {
      firstRole.set(id, role)
    } else if (role === 'start' && first === 'update') {
      throw new Error(`conversation Context turn-tail${id} received an update before its start Match`)
    }
  }
}

/** A session shaped like a real harness session: two bracketed turns. */
function buildTurnedSession(): Session {
  const session = Session.create(SessionId('rewind-turned'))
  session.append('turn/start', { turn: 1 })
  session.append('user/message', textMessage('first question'), { surfaceOp: 'append' })
  session.append('assistant/message', { turn: 1, step: 0, message: assistantMessage('first answer') }, { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  session.append('turn/start', { turn: 2 })
  session.append('user/message', textMessage('second question'), { surfaceOp: 'append' })
  session.append('assistant/message', { turn: 2, step: 0, message: assistantMessage('second answer') }, { surfaceOp: 'append' })
  session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
  return session
}

describe('in-place rewind over a real session', () => {
  it('withdraws the target and everything after it; the empty user/message marker sits at the tail', () => {
    const session = buildSession()
    expect([...session.surface.nodes]).toEqual([0, 1, 2, 3])

    const plan = planRewind(session.snapshotEvents(), session.surface.nodes, { kind: 'index', index: 1 })
    expect(plan.targetSeq).toBe(2)
    expect(plan.shadowedSeqs).toEqual([2, 3])

    const markerSeq = applyRewind(session, plan)

    // One event replaces the range — no ghost step frame.
    expect(session.snapshotEvents()).toHaveLength(5)
    expect(markerSeq).toBe(4)
    const marker = session.snapshotEvents().find(event => event.seq === markerSeq)!
    expect(marker.type).toBe('user/message')

    // The surface ends at the marker.
    expect([...session.surface.nodes]).toEqual([0, 1, 4])

    // The model context is the pre-rewind messages plus the marker as a
    // present-but-empty user turn (an empty user/message derives to itself).
    const messages = session.deriveMessages()
    expect(messages.length).toBe(3)
    expect((messages[0]!.content[0] as { text: string }).text).toBe('first question')
    expect((messages[1]!.content[0] as { text: string }).text).toBe('first answer')
    expect(messages[2]!.role).toBe('user')
    expect(messages[2]!.content).toEqual([])
  })

  it('regression: a rewind followed by the harness next turn never violates turn-tail ordering', () => {
    const session = buildTurnedSession()
    const plan = planRewind(session.snapshotEvents(), session.surface.nodes, { kind: 'seq', seq: 1 })
    const markerSeq = applyRewind(session, plan)
    const marker = session.snapshotEvents().find(event => event.seq === markerSeq)!
    expect(marker.type).toBe('user/message')

    // The harness continues with its next real turn (last turn/start + 1).
    session.append('turn/start', { turn: 3 })
    session.append('step/start', { turn: 3, step: 1 })
    session.append('user/message', textMessage('follow-up after rewind'), { surfaceOp: 'append' })
    session.append('assistant/message', { turn: 3, step: 1, message: assistantMessage('follow-up answer') }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 3, step: 1 })
    session.append('turn/end', { turn: 3, reason: { kind: 'completed' } })

    // The marker is a turn-less user/message, so it never collides with a
    // later turn number — the ordering replay must pass.
    expect(() => assertTurnTailOrdering(session.snapshotEvents())).not.toThrow()

    // The rewind cut holds on the model-visible surface: marker, then the
    // follow-up turn. The marker content is empty.
    const messages = session.deriveMessages()
    expect(messages.length).toBe(3)
    expect(messages[0]!.content).toEqual([])
    expect((messages[1]!.content[0] as { text: string }).text).toBe('follow-up after rewind')
    expect((messages[2]!.content[0] as { text: string }).text).toBe('follow-up answer')
  })

  it('keeps rewinding after a rewind (rewind can itself be rewound)', () => {
    const session = buildSession()
    const first = planRewind(session.snapshotEvents(), session.surface.nodes, { kind: 'index', index: 1 })
    applyRewind(session, first)
    expect([...session.surface.nodes]).toEqual([0, 1, 4])

    const second = planRewind(session.snapshotEvents(), session.surface.nodes, { kind: 'index', index: 1 })
    expect(second.targetSeq).toBe(0)
    expect(second.shadowedSeqs).toEqual([0, 1, 4])
    const markerSeq = applyRewind(session, second)
    expect([...session.surface.nodes]).toEqual([markerSeq])
    const messages = session.deriveMessages()
    expect(messages.length).toBe(1)
    expect(messages[0]!.content).toEqual([])
  })

  it('withdraws the latest message end to end, then re-sends', () => {
    const open = Session.create(SessionId('rewind-open'))
    open.append('user/message', textMessage('first question'), { surfaceOp: 'append' })
    open.append('user/message', textMessage('oops, sent by mistake'), { surfaceOp: 'append' })
    expect([...open.surface.nodes]).toEqual([0, 1])

    const withdraw = planRewind(open.snapshotEvents(), open.surface.nodes, { kind: 'seq', seq: 1 })
    expect(withdraw.shadowedSeqs).toEqual([1])
    applyRewind(open, withdraw)
    expect([...open.surface.nodes]).toEqual([0, 2])

    open.append('user/message', textMessage('the corrected question'), { surfaceOp: 'append' })
    const messages = open.deriveMessages()
    expect(messages.length).toBe(3)
    expect((messages[0]!.content[0] as { text: string }).text).toBe('first question')
    expect(messages[1]!.content).toEqual([])
    expect((messages[2]!.content[0] as { text: string }).text).toBe('the corrected question')
  })

  it('survives a rewind followed by new user traffic', () => {
    const session = buildSession()
    const plan = planRewind(session.snapshotEvents(), session.surface.nodes, { kind: 'seq', seq: 0 })
    const markerSeq = applyRewind(session, plan)
    session.append('user/message', textMessage('follow-up question'), { surfaceOp: 'append' })
    const messages = session.deriveMessages()
    expect(messages.length).toBe(2)
    expect(messages[0]!.content).toEqual([])
    expect((messages[1]!.content[0] as { text: string }).text).toBe('follow-up question')
    // marker at seq 4, follow-up at seq 5.
    expect([...session.surface.nodes]).toEqual([markerSeq, 5])
  })
})
