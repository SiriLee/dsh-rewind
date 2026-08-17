/**
 * Unit tests for the pure rewind planner (src/rewind.ts).
 */
import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, UserMessage } from '@deepseek-ai/dsh-session'
import {
  formatCandidate, listRewindCandidates, messagePreview, parseRewindTarget,
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
  it('plans a range shadowing everything after the target', () => {
    const { events, surface } = sampleLog()
    const plan = planRewind(events, surface, { kind: 'seq', seq: 2 })
    expect(plan.targetSeq).toBe(2)
    expect(plan.targetIndex).toBe(2)
    expect(plan.shadowedSeqs).toEqual([3, 4, 5])
    expect(plan.surfaceStart).toBe(3)
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

  it('rejects a target that is already the last surface node', () => {
    // A log whose most recent surface node is a user message: nothing follows.
    const events = [
      userEvent(0, 'first question'),
      assistantEvent(1, 'first answer'),
      userEvent(2, 'second question'),
    ]
    const surface = [0, 1, 2]
    try {
      planRewind(events, surface, { kind: 'seq', seq: 2 })
      throw new Error('expected throw')
    } catch (error) {
      expect((error as RewindError).code).toBe('nothing-after')
    }
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
