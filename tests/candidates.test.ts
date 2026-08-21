/**
 * Unit tests for the client-side rewind candidate computation
 * (src/client/candidates.ts): which user messages the `/rewind` command
 * decoration's popupSelect shell offers, their order (most recent first),
 * withdrawn-row exclusion, preview truncation, and the popupSelect row
 * mapping — the client mirror of the host's `listRewindCandidates`.
 */
import { describe, expect, it } from 'vitest'
import type { RewindKey } from '../src/client/locales.ts'
import {
  formatCandidateTime,
  messagePreviewOf,
  rewindCandidatesOf,
  rewindOptionsOf,
  type CandidateChat,
} from '../src/client/candidates.ts'

/** A user/steering chat node fixture; only fields the listing reads are real. */
function userNode(key: string, seq: number, time: number, text: string, kind = 'user') {
  return { key, kind, anchorSeq: seq, data: { seq, time, content: [{ type: 'text', text }] } }
}

function snap(nodes: readonly ReturnType<typeof userNode>[]): CandidateChat {
  return {
    order: nodes.map(node => node.key),
    nodes: new Map(nodes.map(node => [node.key, node])),
  }
}

/** A translate that returns the key, for option-label assertions. */
const t = (key: RewindKey): string => key

describe('rewindCandidatesOf', () => {
  it('lists surface user messages most recent first, numbered from 1', () => {
    const chat = snap([
      userNode('u0', 0, 1000, 'first'),
      userNode('u1', 1, 2000, 'second'),
      userNode('u2', 2, 3000, 'third'),
    ])
    expect(rewindCandidatesOf(chat, new Set())).toEqual([
      { seq: 2, time: 3000, preview: 'third', index: 1 },
      { seq: 1, time: 2000, preview: 'second', index: 2 },
      { seq: 0, time: 1000, preview: 'first', index: 3 },
    ])
  })

  it('skips withdrawn (hidden) messages', () => {
    const chat = snap([
      userNode('u0', 0, 1000, 'first'),
      userNode('u1', 1, 2000, 'second'),
      userNode('u2', 2, 3000, 'third'),
    ])
    const candidates = rewindCandidatesOf(chat, new Set([1, 2]))
    expect(candidates.map(candidate => candidate.seq)).toEqual([0])
  })

  it('includes steering rows and skips non-user rows', () => {
    const chat = snap([
      userNode('u0', 0, 1000, 'plain'),
      userNode('s1', 1, 2000, 'steered', 'steering'),
      userNode('a2', 2, 3000, 'assistant', 'assistant'),
    ])
    expect(rewindCandidatesOf(chat, new Set()).map(candidate => candidate.seq)).toEqual([1, 0])
  })

  it('caps the list at the default 10', () => {
    const nodes = Array.from({ length: 12 }, (_, i) => userNode(`u${i}`, i, i, `msg ${i}`))
    const candidates = rewindCandidatesOf(snap(nodes), new Set())
    expect(candidates).toHaveLength(10)
    expect(candidates[0]!.seq).toBe(11)
    expect(candidates[9]!.seq).toBe(2)
  })

  it('respects an explicit limit', () => {
    const nodes = Array.from({ length: 12 }, (_, i) => userNode(`u${i}`, i, i, `msg ${i}`))
    const candidates = rewindCandidatesOf(snap(nodes), new Set(), 5)
    expect(candidates.map(candidate => candidate.seq)).toEqual([11, 10, 9, 8, 7])
  })

  it('produces no candidates for an empty or all-hidden chat', () => {
    expect(rewindCandidatesOf(snap([]), new Set())).toEqual([])
    const chat = snap([userNode('u0', 0, 0, 'only')])
    expect(rewindCandidatesOf(chat, new Set([0]))).toEqual([])
  })

  it('falls back to the message seq when anchorSeq is absent', () => {
    const chat: CandidateChat = {
      order: ['u0'],
      nodes: new Map([['u0', { kind: 'user', data: { seq: 7, time: 1, content: [] } }]]),
    }
    // Hidden by the seq fallback even though no anchorSeq is declared.
    expect(rewindCandidatesOf(chat, new Set([7]))).toEqual([])
    expect(rewindCandidatesOf(chat, new Set())).toHaveLength(1)
  })
})

describe('messagePreviewOf', () => {
  it('joins text blocks and collapses whitespace', () => {
    expect(messagePreviewOf({ content: [{ type: 'text', text: '  hello ' }, { type: 'text', text: 'world\n' }] })).toBe('hello world')
  })

  it('ignores non-text blocks', () => {
    expect(messagePreviewOf({ content: [{ type: 'image' }, { type: 'text', text: 'ok' }] })).toBe('ok')
  })

  it('truncates long previews with an ellipsis', () => {
    const preview = messagePreviewOf({ content: [{ type: 'text', text: 'x'.repeat(100) }] })
    expect(preview).toHaveLength(80)
    expect(preview.endsWith('…')).toBe(true)
    expect(preview.slice(0, 79)).toBe('x'.repeat(79))
  })
})

describe('formatCandidateTime', () => {
  it('renders HH:MM with zero padding', () => {
    const d = new Date(2026, 7, 21, 9, 5)
    expect(formatCandidateTime(d.getTime())).toBe('09:05')
    expect(formatCandidateTime(new Date(2026, 7, 21, 23, 59).getTime())).toBe('23:59')
  })
})

describe('rewindOptionsOf', () => {
  it('maps candidates to popupSelect rows (id = seq, label = index · time)', () => {
    const chat = snap([
      userNode('u0', 0, new Date(2026, 7, 21, 9, 5).getTime(), 'first'),
      userNode('u1', 1, new Date(2026, 7, 21, 10, 30).getTime(), 'second'),
    ])
    expect(rewindOptionsOf(chat, t)).toEqual([
      { id: '1', label: '1. 10:30', detail: 'second' },
      { id: '0', label: '2. 09:05', detail: 'first' },
    ])
  })

  it('uses the no-text fallback for empty previews', () => {
    const chat = snap([userNode('u0', 0, new Date(2026, 7, 21, 8, 0).getTime(), '   ')])
    expect(rewindOptionsOf(chat, t)).toEqual([
      { id: '0', label: '1. 08:00', detail: 'popover.noText' },
    ])
  })
})
