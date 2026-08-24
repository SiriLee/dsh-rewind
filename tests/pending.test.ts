/**
 * Unit tests for the pending-message matching contract
 * (src/client/pending.ts): pairing the rendered pending-steering bubble rows
 * with the session queue mirror's `placement === 'steering'` items, with the
 * safe-degradation guarantees the retract button relies on.
 */
import { describe, expect, it } from 'vitest'
import { matchPendingRows, type PendingRow, type PendingSteeringItem } from '../src/client/pending.ts'

/** A steering queue item fixture. */
function item(id: string, text: string | null): PendingSteeringItem {
  return { id, text }
}

/** A rendered bubble row fixture. */
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

  it('returns all-null when only steering items exist (rows not yet rendered)', () => {
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

  it('skips the whole batch when row count and item count differ', () => {
    const rows = [row('a'), row('b')]
    const steering = [item('x', 'a')]
    expect(matchPendingRows(rows, steering)).toEqual([null, null])
  })

  it('skips the whole batch when any text mismatches (alignment broke)', () => {
    const rows = [row('a'), row('c')]
    const steering = [item('x', 'a'), item('y', 'b')]
    expect(matchPendingRows(rows, steering)).toEqual([null, null])
  })

  it('treats a null item text as empty (image-only steering)', () => {
    expect(matchPendingRows([row('')], [item('img', null)])).toEqual(['img'])
  })

  it('mismatches when an image-only row renders text (alt content)', () => {
    expect(matchPendingRows([row('[image]')], [item('img', null)])).toEqual([null])
  })
})
