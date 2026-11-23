/**
 * Unit tests for the client candidate row mapping (`src/client/candidates.ts`).
 */
import { describe, expect, it } from 'vitest'
import type { RewindKey } from '../src/client/locales.ts'
import { rewindOptionsFromCandidates } from '../src/client/candidates.ts'

/** A translate that returns the key, for option-label assertions. */
const t = (key: RewindKey): string => key

describe('rewindOptionsFromCandidates', () => {
  it('maps typed candidates to rows', () => {
    const time = new Date(2026, 7, 21, 4, 0).getTime()
    expect(rewindOptionsFromCandidates([{ seq: 4, time, preview: 'x' }], t)).toEqual([
      { id: '4', label: 'x', detail: '04:00' },
    ])
  })

  it('uses the no-text label for an empty preview', () => {
    expect(rewindOptionsFromCandidates([{ seq: 1, time: 0, preview: '' }], t)[0]?.label).toBe('popover.noText')
  })
})
