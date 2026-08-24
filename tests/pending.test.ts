/**
 * Unit tests for the pending-message matching contract
 * (src/client/pending.ts): pairing the rendered pending-steering bubble rows
 * with the session queue mirror's `placement === 'steering'` items, with
 * per-row safe degradation — one bad row never takes down the others.
 */
import { describe, expect, it } from 'vitest'
import { matchPendingRows, retractSpan, type PendingRow, type PendingSteeringItem } from '../src/client/pending.ts'

/** A steering queue item fixture. */
function item(id: string, text: string | null): PendingSteeringItem {
  return { id, text }
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

  it('never includes queued (next-turn) messages — they are not in the steering list', () => {
    expect(retractSpan([{ id: 'b' }], 'b')).toEqual(['b'])
  })
})
