/**
 * Unit tests for the host-side locale registry (src/locales.ts): key and
 * placeholder parity across every shipped dictionary, template interpolation,
 * and preference resolution. Every assertion derives from `HOST_DICTS`, so
 * shipping another language needs no edit here.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_HOST_LOCALE,
  HOST_DICTS,
  preferredLocale,
  translate,
  type HostKey,
  type HostLocaleId,
} from '../src/locales.ts'

const canonical = HOST_DICTS[DEFAULT_HOST_LOCALE]
const languages = Object.keys(HOST_DICTS) as HostLocaleId[]
const keys = Object.keys(canonical) as HostKey[]

/** The `{name}` placeholders in a template, sorted for order-independent comparison. */
function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]!).sort()
}

describe('host locale dictionaries', () => {
  it.each(languages)('%s carries exactly the canonical key set', (lang) => {
    expect(Object.keys(HOST_DICTS[lang]).sort()).toEqual([...keys].sort())
  })

  it.each(languages)('%s preserves every canonical placeholder', (lang) => {
    for (const key of keys) {
      expect(placeholders(HOST_DICTS[lang][key]), `${lang}: ${key}`).toEqual(placeholders(canonical[key]))
      expect(HOST_DICTS[lang][key].trim(), `${lang}: ${key} is empty`).not.toBe('')
    }
  })

  it.each(languages)('%s is reachable through translate', (lang) => {
    expect(translate(lang, 'command.description')).toBe(HOST_DICTS[lang]['command.description'])
  })

  it('interpolates named params', () => {
    expect(translate(DEFAULT_HOST_LOCALE, 'success', { targetSeq: 5, restore: '' }))
      .toContain('seq 5')
  })

  it('falls back to the raw key for an unknown key', () => {
    // @ts-expect-error deliberately unknown key
    expect(translate(DEFAULT_HOST_LOCALE, 'no.such.key')).toBe('no.such.key')
  })

  it('interpolates all params and leaves unknown placeholders untouched', () => {
    const rendered = translate(DEFAULT_HOST_LOCALE, 'failures.item', { path: 'a.ts', message: 'boom' })
    expect(rendered).toBe('a.ts (boom)')
    // An unknown param name is ignored; an unprovided placeholder stays.
    const restored = translate(DEFAULT_HOST_LOCALE, 'success', { targetSeq: 9, restore: '' })
    expect(restored).toContain('Withdrawn seq 9')
  })
})

describe('preferredLocale', () => {
  it.each(languages)('resolves %s case-insensitively, regional tags included', (lang) => {
    expect(preferredLocale(lang)).toBe(lang)
    expect(preferredLocale(lang.toUpperCase())).toBe(lang)
    if (!lang.includes('-')) expect(preferredLocale(`${lang}-ZZ`)).toBe(lang)
  })

  it('falls back to the neutral default for an unsupported language', () => {
    // Derive the probe tag from the registry so adding a language cannot make
    // this assertion stale.
    const unsupported = ['zz', 'xx', 'und'].find(tag => !Object.hasOwn(HOST_DICTS, tag))!
    expect(preferredLocale(unsupported)).toBe(DEFAULT_HOST_LOCALE)
    expect(preferredLocale(`${unsupported}-ZZ`)).toBe(DEFAULT_HOST_LOCALE)
    expect(preferredLocale('')).toBe(DEFAULT_HOST_LOCALE)
  })

  it('falls back to the neutral default for a missing or non-string preference', () => {
    // An unset preference, and the redacted-descriptor shapes a settings read
    // can hand back, must never reach the dictionary lookup as a locale id.
    expect(preferredLocale(undefined)).toBe(DEFAULT_HOST_LOCALE)
    expect(preferredLocale(null)).toBe(DEFAULT_HOST_LOCALE)
    expect(preferredLocale(42)).toBe(DEFAULT_HOST_LOCALE)
    expect(preferredLocale({ preference: 'zh' })).toBe(DEFAULT_HOST_LOCALE)
  })
})
