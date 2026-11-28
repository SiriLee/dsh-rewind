import { describe, expect, it } from 'vitest'
import { applyPatchPaths } from '../src/index.ts'

describe('applyPatchPaths', () => {
  it('collects add, update, delete, and move paths in patch order', () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: a.txt',
      '+a',
      '*** Update File: dir/b.txt',
      '*** Move to: dir/c.txt',
      '@@',
      '-b',
      '+c',
      '*** Delete File: d.txt',
      '*** End Patch',
    ].join('\n')
    expect(applyPatchPaths(patch)).toEqual(['a.txt', 'dir/b.txt', 'dir/c.txt', 'd.txt'])
  })

  it('keeps spaces, trims CRLF, and deduplicates', () => {
    const patch = '*** Begin Patch\r\n*** Update File: a b.txt\r\n*** Update File: a b.txt\r\n*** End Patch\r\n'
    expect(applyPatchPaths(patch)).toEqual(['a b.txt'])
  })

  it('returns no paths for empty or malformed input', () => {
    expect(applyPatchPaths('')).toEqual([])
    expect(applyPatchPaths('*** Begin Patch\n@@\n+only a hunk\n*** End Patch')).toEqual([])
  })
})
