/**
 * Unit tests for the pure rewind planner (src/rewind.ts).
 */
import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, UserMessage } from '@deepseek-ai/dsh-session'
import {
  formatCandidate, listRewindCandidates, markerTurnOf, messagePreview, parseRewindTarget,
  planRewind, RewindError,
} from '../src/rewind.ts'

function userEvent(seq: number, text: string, time = seq * 60_000): SessionEvent<'user/message'> {
  return {
    type: 'user/message',
    seq,
    time,
    data: createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
  } as SessionEvent<'user/message'>
}

function assistantEvent(seq: number, text: string): SessionEvent<'assistant/message'> {
  return {
    type: 'assistant/message',
    seq,
    time: seq * 60_000,
    data: {
      turn: seq,
      step: 0,
      message: createAssistantMessage({
        content: [{ type: 'text', text }],
        source: { provider: 'test', model: 'test-model' },
      }),
    },
  } as SessionEvent<'assistant/message'>
}

/** A small log: u0, a1, u2, a3, u4, a5 (surface = every seq). */
function sampleLog(): { events: readonly SessionEvent[]; surface: readonly number[] } {
  const events = [
    userEvent(0, 'first question'),
    assistantEvent(1, 'first answer'),
    userEvent(2, 'second question'),
    assistantEvent(3, 'second answer'),
    userEvent(4, 'third question'),
    assistantEvent(5, 'third answer'),
  ]
  return { events, surface: [0, 1, 2, 3, 4, 5] }
}

function turnStartEvent(seq: number, turn: number): SessionEvent<'turn/start'> {
  return { type: 'turn/start', seq, time: seq * 60_000, data: { turn } } as SessionEvent<'turn/start'>
}

function turnEndEvent(seq: number, turn: number): SessionEvent<'turn/end'> {
  return {
    type: 'turn/end',
    seq,
    time: seq * 60_000,
    data: { turn, reason: { kind: 'completed' } },
  } as SessionEvent<'turn/end'>
}

/**
 * A realistic session log with two completed turns, exactly like the harness
 * produces: turn 1 (u0..a1), turn 2 (u2..a3), closed by `turn/end 2`.
 */
function twoTurnLog(): readonly SessionEvent[] {
  return [
    turnStartEvent(0, 1),
    userEvent(1, 'first question'),
    assistantEvent(2, 'first answer'),
    turnEndEvent(3, 1),
    turnStartEvent(4, 2),
    userEvent(5, 'second question'),
    assistantEvent(6, 'second answer'),
    turnEndEvent(7, 2),
  ]
}

describe('parseRewindTarget', () => {
  it('parses absolute seq targets', () => {
    expect(parseRewindTarget('@12')).toEqual({ kind: 'seq', seq: 12 })
    expect(parseRewindTarget(' @0 ')).toEqual({ kind: 'seq', seq: 0 })
  })

  it('parses recency indexes', () => {
    expect(parseRewindTarget('1')).toEqual({ kind: 'index', index: 1 })
    expect(parseRewindTarget('42')).toEqual({ kind: 'index', index: 42 })
  })

  it('rejects malformed tokens', () => {
    expect(parseRewindTarget('')).toBeUndefined()
    expect(parseRewindTarget('@-1')).toBeUndefined()
    expect(parseRewindTarget('@x')).toBeUndefined()
    expect(parseRewindTarget('0')).toBeUndefined()
    expect(parseRewindTarget('-3')).toBeUndefined()
    expect(parseRewindTarget('1.5')).toBeUndefined()
  })
})

describe('messagePreview', () => {
  it('joins text blocks and truncates', () => {
    const message = createUserMessage({
      content: [
        { type: 'text', text: 'hello ' },
        { type: 'text', text: 'world' },
      ],
      source: { kind: 'user' },
    })
    expect(messagePreview(message)).toBe('hello world')
    const long = createUserMessage({
      content: [{ type: 'text', text: 'x'.repeat(200) }],
      source: { kind: 'user' },
    })
    expect(messagePreview(long)).toHaveLength(80)
    expect(messagePreview(long).endsWith('…')).toBe(true)
  })
})

describe('listRewindCandidates', () => {
  it('lists surface user messages most recent first, numbered from 1', () => {
    const { events, surface } = sampleLog()
    const candidates = listRewindCandidates(events, surface)
    expect(candidates.map(c => [c.seq, c.index])).toEqual([[4, 1], [2, 2], [0, 3]])
  })

  it('skips user messages shadowed by replacement (not on the surface)', () => {
    const { events } = sampleLog()
    // u2 is shadowed by a compaction replacement at seq 6.
    const surface = [0, 1, 6, 4, 5]
    const candidates = listRewindCandidates(events, surface)
    expect(candidates.map(c => c.seq)).toEqual([4, 0])
  })

  it('respects the limit', () => {
    const { events, surface } = sampleLog()
    expect(listRewindCandidates(events, surface, 2).map(c => c.seq)).toEqual([4, 2])
  })

  it('renders candidates with a time + preview line', () => {
    const { events, surface } = sampleLog()
    const line = formatCandidate(listRewindCandidates(events, surface)[0]!)
    expect(line).toMatch(/^1\. \d{2}:\d{2} third question$/)
  })
})

describe('planRewind', () => {
  it('withdraws the target AND everything after it', () => {
    const { events, surface } = sampleLog()
    const plan = planRewind(events, surface, { kind: 'seq', seq: 2 })
    expect(plan.targetSeq).toBe(2)
    expect(plan.targetIndex).toBe(2)
    // Time-travel semantics: the target message itself is withdrawn too.
    expect(plan.shadowedSeqs).toEqual([2, 3, 4, 5])
    expect(plan.surfaceStart).toBe(2)
    expect(plan.surfaceEnd).toBe(5)
  })

  it('resolves recency indexes to seqs', () => {
    const { events, surface } = sampleLog()
    expect(planRewind(events, surface, { kind: 'index', index: 1 }).targetSeq).toBe(4)
    expect(planRewind(events, surface, { kind: 'index', index: 3 }).targetSeq).toBe(0)
  })

  it('rejects an out-of-range index', () => {
    const { events, surface } = sampleLog()
    expect(() => planRewind(events, surface, { kind: 'index', index: 9 }))
      .toThrowError(RewindError)
    try {
      planRewind(events, surface, { kind: 'index', index: 9 })
      throw new Error('expected throw')
    } catch (error) {
      expect((error as RewindError).code).toBe('invalid-index')
    }
  })

  it('rejects a target that is not a user message', () => {
    const { events, surface } = sampleLog()
    expect(() => planRewind(events, surface, { kind: 'seq', seq: 1 })).toThrowError(/not a user message/)
  })

  it('rejects a user message shadowed by compaction', () => {
    const { events } = sampleLog()
    // u2 no longer on the surface (compacted away).
    const surface = [0, 1, 6, 4, 5]
    try {
      planRewind(events, surface, { kind: 'seq', seq: 2 })
      throw new Error('expected throw')
    } catch (error) {
      expect((error as RewindError).code).toBe('not-on-surface')
    }
  })

  it('rewinds the last surface node away (withdraw the latest message)', () => {
    // A log whose most recent surface node is a user message: rewinding to it
    // withdraws the message itself (send-a-mistake → re-send), so the shadowed
    // range INCLUDES the target.
    const events = [
      userEvent(0, 'first question'),
      assistantEvent(1, 'first answer'),
      userEvent(2, 'second question'),
    ]
    const surface = [0, 1, 2]
    const plan = planRewind(events, surface, { kind: 'seq', seq: 2 })
    expect(plan.targetSeq).toBe(2)
    expect(plan.shadowedSeqs).toEqual([2])
    expect(plan.surfaceStart).toBe(2)
    expect(plan.surfaceEnd).toBe(2)
  })

  it('produces no candidates in a user-less log', () => {
    const events = [assistantEvent(0, 'answer only')]
    expect(() => planRewind(events, [0], { kind: 'index', index: 1 })).toThrowError(RewindError)
  })
})

describe('rewind marker message shape', () => {
  it('createUserMessage produces a user-role message usable as the marker', () => {
    const marker: UserMessage = createUserMessage({
      content: [{ type: 'text', text: '[回退标记]' }],
      source: { kind: 'user' },
    })
    expect(marker.role).toBe('user')
    expect(marker.source.kind).toBe('user')
    expect(marker.content[0]!.type).toBe('text')
  })
})

describe('markerTurnOf (regression: marker turn must never collide with the harness next turn)', () => {
  it('reuses the LAST STARTED turn, never lastTurn + 1', () => {
    const events = twoTurnLog()
    // The harness numbers its next real turn `last turn/start + 1` = 3. A
    // marker numbered 3 would precede the future `turn/start 3` and break the
    // client conversation-context builder ("received an update before its
    // start Match"). The marker must reuse an already-consumed turn instead.
    expect(markerTurnOf(events)).toBe(2)
    expect(markerTurnOf(events)).not.toBe(3)
  })

  it('stays collision-free after the harness continues the conversation (the exact crash repro)', () => {
    const events = [...twoTurnLog()]
    // The rewind executes: an empty marker is appended with markerTurnOf…
    const markerTurn = markerTurnOf(events)
    events.push({ ...assistantEvent(8, ''), data: { turn: markerTurn, step: 0, message: createAssistantMessage({ content: [], source: { provider: 'dsh-rewind', model: 'rewind-marker' } }) } } as SessionEvent<'assistant/message'>)
    // …and then the harness opens its NEXT real turn: `last turn/start + 1`.
    const nextRealTurn = markerTurn + 1
    events.push(turnStartEvent(9, nextRealTurn))
    // The client builder requires every `turn/start` to be the FIRST match of
    // its turn-tail context — no `assistant/message` may precede it.
    const markerEvent = events[events.length - 2] as SessionEvent<'assistant/message'>
    const turnStart = events[events.length - 1] as SessionEvent<'turn/start'>
    expect(turnStart.data.turn).toBe(3)
    expect(markerEvent.data.turn).not.toBe(turnStart.data.turn)
  })

  it('ignores assistant/message and turn/end turn numbers (legacy markers included)', () => {
    const events = [
      ...twoTurnLog(),
      // A legacy (pre-fix) marker numbered 3 followed by the harness turn/start 3.
      { ...assistantEvent(8, ''), data: { turn: 3, step: 0, message: createAssistantMessage({ content: [], source: { provider: 'dsh-rewind', model: 'rewind-marker' } }) } } as SessionEvent<'assistant/message'>,
      turnStartEvent(9, 3),
      userEvent(10, 'continued'),
      assistantEvent(11, 'answer'),
      turnEndEvent(12, 3),
    ]
    // The next rewind must NOT pick 4 (the next harness turn) nor 3 (taken by
    // the legacy marker + real turn): it reuses the last STARTED turn, 3 —
    // already consumed, so the harness's next turn (4) stays free.
    expect(markerTurnOf(events)).toBe(3)
    expect(markerTurnOf(events)).not.toBe(4)
  })

  it('returns 0 for a log with no turn/start yet', () => {
    const { events } = sampleLog()
    expect(events.some(event => event.type === 'turn/start')).toBe(false)
    expect(markerTurnOf(events)).toBe(0)
  })
})
