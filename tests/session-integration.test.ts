/**
 * Integration tests against a real dsh-session: build a session log, plan a
 * rewind, append the marker with a surface replace, and verify the surface
 * and the derived model messages — the exact mechanism `executeRewind` uses.
 */
import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { planRewind, RewindError } from '../src/rewind.ts'

function textMessage(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function assistantMessage(text: string) {
  return createAssistantMessage({
    content: [{ type: 'text', text }],
    source: { provider: 'test', model: 'test-model' },
  })
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
  it('appends a marker whose replace shadows everything after the target', () => {
    const session = buildSession()
    expect([...session.surface.nodes]).toEqual([0, 1, 2, 3])

    const plan = planRewind(session.events, session.surface.nodes, { kind: 'index', index: 1 })
    expect(plan.targetSeq).toBe(2)
    expect(plan.shadowedSeqs).toEqual([3])

    const marker = textMessage('[回退标记] 对话已回退到 seq 2')
    const event = session.append('user/message', marker, {
      surfaceOp: { op: 'replace', start: plan.surfaceStart, end: plan.surfaceEnd },
      sourceEventSeqs: [...plan.shadowedSeqs],
    })

    // The log stays append-only (audit trail intact).
    expect(session.events).toHaveLength(5)
    expect(session.events[4]).toBe(event)
    expect(event.seq).toBe(4)

    // The surface now ends at the marker; the shadowed nodes left the model context.
    expect([...session.surface.nodes]).toEqual([0, 1, 2, 4])

    // The model messages derive from the cut surface, marker included.
    const messages = session.deriveMessages()
    expect(messages.map(m => m.content[0]!.type === 'text' ? (m.content[0] as { text: string }).text : ''))
      .toEqual(['first question', 'first answer', 'second question', '[回退标记] 对话已回退到 seq 2'])
  })

  it('keeps rewinding after a rewind (rewind can itself be rewound)', () => {
    const session = buildSession()
    const first = planRewind(session.events, session.surface.nodes, { kind: 'index', index: 1 })
    session.append('user/message', textMessage('marker one'), {
      surfaceOp: { op: 'replace', start: first.surfaceStart, end: first.surfaceEnd },
      sourceEventSeqs: [...first.shadowedSeqs],
    })
    expect([...session.surface.nodes]).toEqual([0, 1, 2, 4])

    // Rewind again, to the first user message.
    const second = planRewind(session.events, session.surface.nodes, { kind: 'index', index: 3 })
    expect(second.targetSeq).toBe(0)
    expect(second.shadowedSeqs).toEqual([1, 2, 4])
    session.append('user/message', textMessage('marker two'), {
      surfaceOp: { op: 'replace', start: second.surfaceStart, end: second.surfaceEnd },
      sourceEventSeqs: [...second.shadowedSeqs],
    })
    expect([...session.surface.nodes]).toEqual([0, 5])
    const messages = session.deriveMessages()
    expect(messages).toHaveLength(2)
    expect((messages[0]!.content[0] as { text: string }).text).toBe('first question')
  })

  it('rewinds the last user message away (withdraw + re-send) end to end', () => {
    const session = buildSession()
    // seq 2 is the second user message with assistant 3 still after it — valid,
    // shadows only the assistant reply.
    const plan = planRewind(session.events, session.surface.nodes, { kind: 'seq', seq: 2 })
    expect(plan.shadowedSeqs).toEqual([3])

    // A session ending with a user message: rewinding to it withdraws the
    // message itself — the surface ends before it, and the next append follows.
    const open = Session.create(SessionId('rewind-open'))
    open.append('user/message', textMessage('first question'), { surfaceOp: 'append' })
    open.append('user/message', textMessage('oops, sent by mistake'), { surfaceOp: 'append' })
    expect([...open.surface.nodes]).toEqual([0, 1])

    const withdraw = planRewind(open.events, open.surface.nodes, { kind: 'seq', seq: 1 })
    expect(withdraw.shadowedSeqs).toEqual([1])
    open.append('user/message', textMessage('[回退标记] 已撤回 seq 1'), {
      surfaceOp: { op: 'replace', start: withdraw.surfaceStart, end: withdraw.surfaceEnd },
      sourceEventSeqs: [...withdraw.shadowedSeqs],
    })
    expect([...open.surface.nodes]).toEqual([0, 2])
    open.append('user/message', textMessage('the corrected question'), { surfaceOp: 'append' })
    const messages = open.deriveMessages()
    expect(messages.map(m => (m.content[0] as { text: string }).text))
      .toEqual(['first question', '[回退标记] 已撤回 seq 1', 'the corrected question'])
  })

  it('survives a rewind followed by new user traffic', () => {
    const session = buildSession()
    const plan = planRewind(session.events, session.surface.nodes, { kind: 'seq', seq: 0 })
    session.append('user/message', textMessage('marker'), {
      surfaceOp: { op: 'replace', start: plan.surfaceStart, end: plan.surfaceEnd },
      sourceEventSeqs: [...plan.shadowedSeqs],
    })
    session.append('user/message', textMessage('follow-up question'), { surfaceOp: 'append' })
    const messages = session.deriveMessages()
    expect(messages.map(m => (m.content[0] as { text: string }).text))
      .toEqual(['first question', 'marker', 'follow-up question'])
  })
})
