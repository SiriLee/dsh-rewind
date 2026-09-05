/**
 * Unit tests for the pure rewind planner (src/rewind.ts).
 */
import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, UserMessage } from '@deepseek-ai/dsh-session'
import {
  formatCandidate, formatCandidateList, listRewindCandidates, messagePreview, parseRewindTarget,
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

/** A plugin-injected `user/message` (renders as a `context` node, not a user bubble). */
function injectedContextEvent(seq: number, text: string, plugin = 'compact'): SessionEvent<'user/message'> {
  return {
    type: 'user/message',
    seq,
    time: seq * 60_000,
    data: {
      id: `ctx-${seq}`,
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin },
    },
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

  it('excludes injected context user/messages (non-user source) from candidates', () => {
    const events = [
      userEvent(0, 'first question'),
      injectedContextEvent(1, 'injected system context'),
      userEvent(2, 'second question'),
      injectedContextEvent(3, 'another injection', 'some-plugin'),
    ]
    const surface = events.map(e => e.seq)
    // Only the human user messages (seq 0, 2) are rewindable.
    const candidates = listRewindCandidates(events, surface)
    expect(candidates.map(c => c.seq)).toEqual([2, 0])
  })

  it('keeps the newest DEFAULT_CANDIDATE_LIMIT (100) by default', () => {
    const events: readonly SessionEvent[] = Array.from({ length: 105 }, (_, i) => userEvent(i, `msg ${i}`))
    const surface = events.map(e => e.seq)
    const candidates = listRewindCandidates(events, surface)
    expect(candidates).toHaveLength(100)
    expect(candidates[0]!.seq).toBe(104)
    expect(candidates[99]!.seq).toBe(5)
  })

  it('renders candidates with a time + preview line', () => {
    const { events, surface } = sampleLog()
    const line = formatCandidate(listRewindCandidates(events, surface)[0]!)
    expect(line).toMatch(/^1\. \d{2}:\d{2} third question$/)
  })
})

describe('formatCandidateList', () => {
  it('encodes an empty list as candidates=0', () => {
    expect(formatCandidateList([])).toBe('candidates=0')
  })

  it('encodes each candidate as a tab-separated seq/time/preview line', () => {
    const list = formatCandidateList([
      { seq: 4, time: 240_000, preview: 'third question', index: 1 },
      { seq: 0, time: 0, preview: 'first question', index: 2 },
    ])
    expect(list).toBe('candidates=2\n4\t240000\tthird question\n0\t0\tfirst question')
  })

  it('preserves newest-first order from the input candidates', () => {
    const { events, surface } = sampleLog()
    const text = formatCandidateList(listRewindCandidates(events, surface))
    expect(text).toBe(
      'candidates=3\n4\t240000\tthird question\n2\t120000\tsecond question\n0\t0\tfirst question',
    )
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
    expect(() => planRewind(events, surface, { kind: 'seq', seq: 1 })).toThrowError(/not a human user message/)
  })

  it('rejects an injected context user/message as a target', () => {
    // A plugin-injected `user/message` (source.kind !== 'user') on the surface
    // is a `context` node, never a user prompt — not a valid rewind boundary.
    const events = [
      userEvent(0, 'first question'),
      {
        type: 'user/message',
        seq: 1,
        time: 60_000,
        data: {
          id: 'ctx-1',
          role: 'user' as const,
          content: [{ type: 'text' as const, text: 'injected system context' }],
          source: { kind: 'plugin', plugin: 'compact' },
        },
      } as SessionEvent<'user/message'>,
    ]
    const surface = [0, 1]
    expect(() => planRewind(events, surface, { kind: 'seq', seq: 1 })).toThrowError(/not a human user message/)
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
  it('the marker is an empty user/message with a plugin source (v2 surface replace)', () => {
    const marker: UserMessage = createUserMessage({
      content: [],
      source: { kind: 'plugin', plugin: 'dsh-rewind' },
    })
    expect(marker.role).toBe('user')
    expect(marker.source.kind).toBe('plugin')
    expect((marker.source as { plugin?: string }).plugin).toBe('dsh-rewind')
    expect(marker.content).toEqual([])
  })
})
