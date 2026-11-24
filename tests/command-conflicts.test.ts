/**
 * Host ownership state: optimistic until a read completes, and a failed or
 * superseded read never replaces the previous snapshot.
 */
import { describe, expect, it, vi } from 'vitest'
import { CommandConflicts } from '../src/client/command-conflicts.ts'
import { REWIND, UNDO } from '../src/client/command-names.ts'

describe('CommandConflicts', () => {
  it('starts optimistic', () => {
    const conflicts = new CommandConflicts(async () => [])
    expect(conflicts.allows(REWIND)).toBe(true)
    expect(conflicts.allows(UNDO)).toBe(true)
  })

  it('owns only the names in the read catalog', async () => {
    const conflicts = new CommandConflicts(async () => [REWIND])
    await conflicts.check('s1')
    expect(conflicts.allows(REWIND)).toBe(false)
    expect(conflicts.allows(UNDO)).toBe(true)
  })

  it('keeps the previous snapshot when the read fails', async () => {
    const read = vi.fn()
      .mockResolvedValueOnce([REWIND])
      .mockRejectedValueOnce(new Error('unavailable'))
    const conflicts = new CommandConflicts(read)
    await conflicts.check('s1')
    await conflicts.check('s1')
    expect(conflicts.allows(REWIND)).toBe(false)
  })

  it('ignores a read superseded by a newer check', async () => {
    let resolveFirst!: (names: readonly string[]) => void
    const read = vi.fn()
      .mockImplementationOnce(() => new Promise<readonly string[] | undefined>((resolve) => { resolveFirst = resolve }))
      .mockResolvedValueOnce([])
    const conflicts = new CommandConflicts(read)
    const first = conflicts.check('s1')
    const second = conflicts.check('s2')
    resolveFirst([REWIND])
    await Promise.all([first, second])
    expect(conflicts.allows(REWIND)).toBe(true)
  })
})
