/**
 * Unit tests for the pending-message matching contract
 * (src/client/pending.ts): pairing the rendered pending-steering bubble rows
 * with the session's `next-step` inbox rows (the alpha.2 replacement for the
 * removed `queue` mirror), with per-row safe degradation — one bad row never
 * takes down the others — plus the inbox-row derivation the retract path reads.
 */
import { describe, expect, it } from 'vitest'
import {
  matchPendingRows,
  retractSpan,
  steeringItemsOf,
  type InboxMessageLike,
  type PendingRow,
  type PendingSteeringItem,
} from '../src/client/pending.ts'

/** A steering item fixture (as `steeringItemsOf` would derive it). */
function item(id: string, text: string | null): PendingSteeringItem {
  return { id, text, preview: text ?? '' }
}

/** A rendered bubble row fixture (text = bubble text, actions excluded). */
function row(text: string): PendingRow {
  return { text }
}

describe('matchPendingRows', () => {
  it('returns no ids when there is nothing to match', () => {
    expect(matchPendingRows([], [])).toEqual([])
  })

  it('returns all-null when only rows exist (mirror not yet populated)', () => {
    expect(matchPendingRows([row('hello')], [])).toEqual([null])
  })

  it('returns empty when only steering items exist (rows not yet rendered)', () => {
    expect(matchPendingRows([], [item('a', 'hello')])).toEqual([])
  })

  it('pairs a single row to the matching steering item by index', () => {
    expect(matchPendingRows([row('hello')], [item('a', 'hello')])).toEqual(['a'])
  })

  it('pairs multiple rows in order, including identical texts', () => {
    const rows = [row('hi'), row('hi')]
    const steering = [item('a', 'hi'), item('b', 'hi')]
    expect(matchPendingRows(rows, steering)).toEqual(['a', 'b'])
  })

  it('skips only the surplus row when rows outnumber steering items', () => {
    const rows = [row('a'), row('b')]
    const steering = [item('x', 'a')]
    expect(matchPendingRows(rows, steering)).toEqual(['x', null])
  })

  it('pairs only the rows that have a counterpart when rows are fewer', () => {
    const rows = [row('a')]
    const steering = [item('x', 'a'), item('y', 'b')]
    expect(matchPendingRows(rows, steering)).toEqual(['x'])
  })

  it('skips only the mismatching row, keeping the others', () => {
    // Row 1 polluted by hover-mounted tooltip text (Copy/Copied) — row 0 must
    // keep its button.
    const rows = [row('甲'), row('乙Copy')]
    const steering = [item('a', '甲'), item('b', '乙')]
    expect(matchPendingRows(rows, steering)).toEqual(['a', null])
  })

  it('keeps other rows when the polluted row is first', () => {
    const rows = [row('甲复制'), row('乙')]
    const steering = [item('a', '甲'), item('b', '乙')]
    expect(matchPendingRows(rows, steering)).toEqual([null, 'b'])
  })

  it('treats a null item text as empty (image-only steering)', () => {
    expect(matchPendingRows([row('')], [item('img', null)])).toEqual(['img'])
  })

  it('mismatches only the row when an image-only row renders text (alt content)', () => {
    expect(matchPendingRows([row('[image]'), row('text')], [item('img', null), item('t', 'text')]))
      .toEqual([null, 't'])
  })
})

describe('retractSpan', () => {
  const steering = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]

  it('returns the target and everything after it (rewind-to-B drops C)', () => {
    expect(retractSpan(steering, 'b')).toEqual(['b', 'c'])
  })

  it('returns every later message when rewinding the earliest pending message', () => {
    expect(retractSpan(steering, 'a')).toEqual(['a', 'b', 'c'])
  })

  it('returns only the target when it is the last pending message', () => {
    expect(retractSpan(steering, 'c')).toEqual(['c'])
  })

  it('returns an empty span when the target is no longer pending', () => {
    expect(retractSpan(steering, 'zzz')).toEqual([])
  })
})

describe('steeringItemsOf (inbox next-step derivation)', () => {
  /** One USER-sourced inbox row with text content. */
  const textRow = (id: string, ...texts: string[]): InboxMessageLike =>
    ({ id, source: { kind: 'user' }, content: texts.map(text => ({ type: 'text', text })) })

  /** One injected (non-user) inbox row, e.g. a plugin or command delivery. */
  const injectedRow = (id: string, kind: string, text: string): InboxMessageLike =>
    ({ id, source: { kind }, content: [{ type: 'text', text }] })

  it('returns nothing for an absent projection (no fold state yet)', () => {
    expect(steeringItemsOf(undefined)).toEqual([])
    expect(steeringItemsOf([])).toEqual([])
  })

  it('joins every text block into the editable text and the preview', () => {
    expect(steeringItemsOf([textRow('a', 'hello ', 'world')]))
      .toEqual([{ id: 'a', text: 'hello world', preview: 'hello world' }])
  })

  it('drops injected (non-user) rows — the host called those context, not steering', () => {
    expect(steeringItemsOf([injectedRow('p', 'plugin', 'from a plugin')])).toEqual([])
    expect(steeringItemsOf([injectedRow('c', 'command', '/x')])).toEqual([])
    expect(steeringItemsOf([{ id: 'x', content: [{ type: 'text', text: 'no origin' }] }])).toEqual([])
  })

  it('keeps only the user rows, in host order, around injected rows', () => {
    const items = steeringItemsOf([
      injectedRow('p1', 'plugin', 'injected'),
      textRow('u1', 'first'),
      injectedRow('p2', 'subagent', 'injected again'),
      textRow('u2', 'second'),
    ])
    expect(items.map(item => item.id)).toEqual(['u1', 'u2'])
  })

  it('reports null text and excludes image/file blocks from the preview', () => {
    const image: InboxMessageLike = { id: 'img', source: { kind: 'user' }, content: [{ type: 'image' }] }
    expect(steeringItemsOf([image])).toEqual([{ id: 'img', text: null, preview: '' }])
    const mixed: InboxMessageLike = {
      id: 'mixed',
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'look' }, { type: 'image' }, { type: 'file' }],
    }
    expect(steeringItemsOf([mixed])).toEqual([{ id: 'mixed', text: null, preview: 'look' }])
  })

  it('collapses whitespace in the preview', () => {
    const row: InboxMessageLike = { id: 'ws', source: { kind: 'user' }, content: [{ type: 'text', text: '  a\n\n b   c ' }] }
    expect(steeringItemsOf([row])).toEqual([{ id: 'ws', text: '  a\n\n b   c ', preview: 'a b c' }])
  })

  it('truncates the preview at 200 code points, counting code points not units', () => {
    const long = '🙂'.repeat(201)
    const [item] = steeringItemsOf([textRow('long', long)])
    expect(Array.from(item!.preview)).toHaveLength(201) // 200 + the ellipsis
    expect(item!.preview.endsWith('…')).toBe(true)
    expect(item!.preview.startsWith('🙂'.repeat(200))).toBe(true)
  })

  it('marks a non-text block by its type in the preview', () => {
    const row: InboxMessageLike = { id: 'tool', source: { kind: 'user' }, content: [{ type: 'tool-call' }] }
    expect(steeringItemsOf([row])).toEqual([{ id: 'tool', text: null, preview: '[tool-call]' }])
  })
})
