/**
 * Client-side locale registry invariants: every shipped `rewind` dictionary
 * covers the canonical key set and preserves its `{name}` placeholders. The
 * assertions are registry-driven, so shipping another language needs no edit
 * here.
 */
import { describe, expect, it } from 'vitest'
import { CLIENT_DICTS, type RewindKey } from '../src/client/locales.ts'

const canonical = CLIENT_DICTS.en
const languages = Object.keys(CLIENT_DICTS) as (keyof typeof CLIENT_DICTS)[]
const keys = Object.keys(canonical) as RewindKey[]

/** The `{name}` placeholders in a template, sorted for order-independent comparison. */
function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]!).sort()
}

describe('client locale dictionaries', () => {
  it.each(languages)('%s carries exactly the canonical key set', (lang) => {
    expect(Object.keys(CLIENT_DICTS[lang]).sort()).toEqual([...keys].sort())
  })

  it.each(languages)('%s preserves every canonical placeholder', (lang) => {
    for (const key of keys) {
      expect(placeholders(CLIENT_DICTS[lang][key]), `${lang}: ${key}`)
        .toEqual(placeholders(canonical[key]))
      expect(CLIENT_DICTS[lang][key].trim(), `${lang}: ${key} is empty`).not.toBe('')
    }
  })
})
