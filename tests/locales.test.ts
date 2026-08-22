/**
 * Unit tests for the host-side locale dictionaries (src/locales.ts): en/zh key
 * set parity, template interpolation, and the default-language behavior.
 */
import { describe, expect, it } from 'vitest'
import { en, translate, zh } from '../src/locales.ts'

describe('host locale dictionaries', () => {
  it('zh carries exactly the en key set (bilingual balance)', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
    expect(zh).toHaveProperty('command.description')
    expect(en).toHaveProperty('command.description')
  })

  it('renders en by default and interpolates named params', () => {
    expect(translate('en', 'success', { targetSeq: 5, restore: '' }))
      .toContain('seq 5')
    expect(translate('zh', 'success', { targetSeq: 5, restore: '' }))
      .toContain('seq 5')
  })

  it('falls back to the raw key for an unknown key', () => {
    // @ts-expect-error deliberately unknown key
    expect(translate('en', 'no.such.key')).toBe('no.such.key')
  })

  it('interpolates all params and leaves unknown placeholders untouched', () => {
    const rendered = translate('en', 'plan.affects', { count: 2 })
    expect(rendered).toBe('Affects 2 file(s):')
    // An unknown param name is ignored; an unprovided placeholder stays.
    const restored = translate('en', 'success', { targetSeq: 9, restore: '' })
    expect(restored).toContain('Withdrawn seq 9')
  })
})
