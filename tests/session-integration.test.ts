/**
 * Integration tests against a real dsh-session: build a session log, plan a
 * rewind (withdraw semantics: the target AND everything after it), append the
 * empty-assistant marker with a surface replace, and verify the surface and
 * the derived model messages — the exact mechanism `executeRewind` uses.
 */
import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { AssistantMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { markerTurnOf, planRewind } from '../src/rewind.ts'

function textMessage(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function assistantMessage(text: string) {
  return createAssistantMessage({
    content: [{ type: 'text', text }],
    source: { provider: 'test', model: 'test-model' },
  })
}

/** The empty-content marker the host uses: derives to null (no model noise). */
function emptyMarker(): AssistantMessage {
  return createAssistantMessage({ content: [], source: { provider: 'dsh-rewind', model: 'rewind-marker' } })
}

/**
 * Append the rewind marker (empty assistant) as the surface replacement.
 * The turn comes from `markerTurnOf` — the LAST STARTED turn — exactly like
 * the host's `executeRewind` does. A marker must never be numbered
 * `lastTurn/start + 1`: the harness numbers its next real turn that way, so
 * the log would hold an `assistant/message` BEFORE the `turn/start` of the
 * same turn, which the client conversation-context builder rejects
 * ("…received an update before its start Match") and history vanishes.
 */
function applyRewind(session: Session, plan: ReturnType<typeof planRewind>): number {
  const event = session.append('assistant/message', { turn: markerTurnOf(session.events), step: 0, message: emptyMarker() }, {
    surfaceOp: { op: 'replace', start: plan.surfaceStart, end: plan.surfaceEnd },
    sourceEventSeqs: [...plan.shadowedSeqs],
  })
  return event.seq
}

/** A session with two completed turns: u0/a1 (turn 0), u2/a3 (turn 1). */
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
function assertTurnTailOrdering(events: Session['events']): void {
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
  it('withdraws the target and everything after it; the empty marker leaves no model noise', () => {
    const session = buildSession()
    expect([...session.surface.nodes]).toEqual([0, 1, 2, 3])

    const plan = planRewind(session.events, session.surface.nodes, { kind: 'index', index: 1 })
    expect(plan.targetSeq).toBe(2)
    expect(plan.shadowedSeqs).toEqual([2, 3])

    const markerSeq = applyRewind(session, plan)

    // The log stays append-only (audit trail intact).
    expect(session.events).toHaveLength(5)
    expect(markerSeq).toBe(4)

    // The surface ends at the (unrendered, empty) marker.
    expect([...session.surface.nodes]).toEqual([0, 1, 4])

    // The model context is exactly "before the withdrawn message": no marker,
    // no second question, no second answer.
    const messages = session.deriveMessages()
    expect(messages.map(m => (m.content[0] as { text: string }).text))
      .toEqual(['first question', 'first answer'])
  })

  it('regression: a rewind followed by the harness next turn never violates turn-tail ordering (history-load crash)', () => {
    const session = buildTurnedSession()
    // Rewind to the first user message (turn 1).
    const plan = planRewind(session.events, session.surface.nodes, { kind: 'seq', seq: 1 })
    const markerSeq = applyRewind(session, plan)
    const marker = session.events.find(event => event.seq === markerSeq)!
    expect(marker.type).toBe('assistant/message')
    expect((marker as { data: { turn: number } }).data.turn).toBe(2)

    // The harness continues the session with its next real turn:
    // `last turn/start + 1`. This is the exact sequence that broke the client
    // conversation-context builder before the fix (marker numbered max+1=3).
    session.append('turn/start', { turn: 3 })
    session.append('step/start', { turn: 3, step: 1 })
    session.append('user/message', textMessage('follow-up after rewind'), { surfaceOp: 'append' })
    session.append('assistant/message', { turn: 3, step: 1, message: assistantMessage('follow-up answer') }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 3, step: 1 })
    session.append('turn/end', { turn: 3, reason: { kind: 'completed' } })

    // The marker (turn 2) must never share a turn number with a later
    // turn/start — the ordering replay above must pass.
    expect((marker as { data: { turn: number } }).data.turn).not.toBe(3)
    expect(() => assertTurnTailOrdering(session.events)).not.toThrow()

    // The rewind cut still holds on the model-visible surface: only the
    // follow-up turn remains (the marker derives to null).
    const messages = session.deriveMessages()
    expect(messages.map(m => (m.content[0] as { text: string }).text))
      .toEqual(['follow-up after rewind', 'follow-up answer'])
  })

  it('keeps rewinding after a rewind (rewind can itself be rewound)', () => {
    const session = buildSession()
    const first = planRewind(session.events, session.surface.nodes, { kind: 'index', index: 1 })
    applyRewind(session, first)
    expect([...session.surface.nodes]).toEqual([0, 1, 4])

    // Rewind again, to the first user message: everything (incl. the marker
    // and the first message itself) is withdrawn.
    const second = planRewind(session.events, session.surface.nodes, { kind: 'index', index: 1 })
    expect(second.targetSeq).toBe(0)
    expect(second.shadowedSeqs).toEqual([0, 1, 4])
    const markerSeq = applyRewind(session, second)
    expect([...session.surface.nodes]).toEqual([markerSeq])
    expect(session.deriveMessages()).toEqual([])
  })

  it('withdraws the latest message end to end, then re-sends', () => {
    const open = Session.create(SessionId('rewind-open'))
    open.append('user/message', textMessage('first question'), { surfaceOp: 'append' })
    open.append('user/message', textMessage('oops, sent by mistake'), { surfaceOp: 'append' })
    expect([...open.surface.nodes]).toEqual([0, 1])

    const withdraw = planRewind(open.events, open.surface.nodes, { kind: 'seq', seq: 1 })
    expect(withdraw.shadowedSeqs).toEqual([1])
    applyRewind(open, withdraw)
    expect([...open.surface.nodes]).toEqual([0, 2])

    open.append('user/message', textMessage('the corrected question'), { surfaceOp: 'append' })
    const messages = open.deriveMessages()
    expect(messages.map(m => (m.content[0] as { text: string }).text))
      .toEqual(['first question', 'the corrected question'])
  })

  it('survives a rewind followed by new user traffic', () => {
    const session = buildSession()
    const plan = planRewind(session.events, session.surface.nodes, { kind: 'seq', seq: 0 })
    const markerSeq = applyRewind(session, plan)
    session.append('user/message', textMessage('follow-up question'), { surfaceOp: 'append' })
    const messages = session.deriveMessages()
    expect(messages.map(m => (m.content[0] as { text: string }).text))
      .toEqual(['follow-up question'])
    expect([...session.surface.nodes]).toEqual([markerSeq, 5])
  })
})
