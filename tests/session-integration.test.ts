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
import { planRewind } from '../src/rewind.ts'

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

/** Append the rewind marker (empty assistant) as the surface replacement. */
function applyRewind(session: Session, plan: ReturnType<typeof planRewind>): number {
  const event = session.append('assistant/message', { turn: 99, step: 0, message: emptyMarker() }, {
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
