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
  rewindCandidatesFromHostText,
  rewindCandidatesOf,
  rewindOptionsFromCandidates,
  rewindOptionsFromHostText,
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
  it('lists surface user messages newest first (top row = default highlight)', () => {
    const chat = snap([
      userNode('u0', 0, 1000, 'first'),
      userNode('u1', 1, 2000, 'second'),
      userNode('u2', 2, 3000, 'third'),
    ])
    expect(rewindCandidatesOf(chat, new Set())).toEqual([
      { seq: 2, time: 3000, preview: 'third' },
      { seq: 1, time: 2000, preview: 'second' },
      { seq: 0, time: 1000, preview: 'first' },
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

  it('keeps the newest DEFAULT_CANDIDATE_LIMIT (50) by default', () => {
    const nodes = Array.from({ length: 55 }, (_, i) => userNode(`u${i}`, i, i, `msg ${i}`))
    const candidates = rewindCandidatesOf(snap(nodes), new Set())
    expect(candidates).toHaveLength(50)
    expect(candidates[0]!.seq).toBe(54)
    expect(candidates[49]!.seq).toBe(5)
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
  it('maps candidates to popupSelect rows (label = text, detail = time, no numbers)', () => {
    const chat = snap([
      userNode('u0', 0, new Date(2026, 7, 21, 9, 5).getTime(), 'first'),
      userNode('u1', 1, new Date(2026, 7, 21, 10, 30).getTime(), 'second'),
    ])
    expect(rewindOptionsOf(chat, t)).toEqual([
      { id: '1', label: 'second', detail: '10:30' },
      { id: '0', label: 'first', detail: '09:05' },
    ])
  })

  it('uses the no-text fallback for the label of empty previews', () => {
    const chat = snap([userNode('u0', 0, new Date(2026, 7, 21, 8, 0).getTime(), '   ')])
    expect(rewindOptionsOf(chat, t)).toEqual([
      { id: '0', label: 'popover.noText', detail: '08:00' },
    ])
  })
})

describe('rewindCandidatesFromHostText', () => {
  it('parses a host candidate list into typed candidates', () => {
    const text = 'candidates=2\n4\t240000\tthird question\n0\t0\tfirst question'
    expect(rewindCandidatesFromHostText(text)).toEqual([
      { seq: 4, time: 240000, preview: 'third question' },
      { seq: 0, time: 0, preview: 'first question' },
    ])
  })

  it('returns an empty list for candidates=0', () => {
    expect(rewindCandidatesFromHostText('candidates=0')).toEqual([])
  })

  it('returns an empty list when the header is missing or malformed', () => {
    expect(rewindCandidatesFromHostText('nope')).toEqual([])
    expect(rewindCandidatesFromHostText('candidates=')).toEqual([])
  })

  it('skips malformed lines but keeps valid ones', () => {
    const text = 'candidates=3\n4\t240000\tok\nbad-line\n5\tnot-a-number\tno'
    expect(rewindCandidatesFromHostText(text).map(c => c.seq)).toEqual([4])
  })
})

describe('rewindOptionsFromHostText', () => {
  it('maps host candidates to popupSelect rows (label/detail/time)', () => {
    const time = new Date(2026, 7, 21, 4, 0).getTime()
    const text = `candidates=1\n4\t${time}\tthird question`
    expect(rewindOptionsFromHostText(text, t)).toEqual([
      { id: '4', label: 'third question', detail: '04:00' },
    ])
  })

  it('falls back to noText for an empty preview', () => {
    const time = new Date(2026, 7, 21, 8, 0).getTime()
    expect(rewindOptionsFromHostText(`candidates=1\n4\t${time}\t`, t)).toEqual([
      { id: '4', label: 'popover.noText', detail: '08:00' },
    ])
  })
})

describe('rewindOptionsFromCandidates', () => {
  it('maps typed candidates to rows (shared host path)', () => {
    const time = new Date(2026, 7, 21, 4, 0).getTime()
    expect(rewindOptionsFromCandidates([{ seq: 4, time, preview: 'x' }], t)).toEqual([
      { id: '4', label: 'x', detail: '04:00' },
    ])
  })
})
