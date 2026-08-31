/**
 * Unit tests for readSettingsSection (src/settings-locale.ts): the version-neutral
 * settings-namespace read that lets the host bundle link and run on BOTH DSH rc.2
 * (which exports the `settingsNamespace` brand helper) and 0.1.2-alpha.2 (which
 * removed it).
 *
 * Regression guard: if someone reverts the host back to a static
 * `settings.get(settingsNamespace('locale'))`, the bundle would fail to link on
 * alpha.2 (the helper is gone). These tests pin the dual-version behavior of the
 * read, and scripts/build.mjs separately guards the artifact (no static named
 * import of `settingsNamespace`).
 */
import { describe, expect, it } from 'vitest'
import {
  readSettingsSection,
  type SettingsNamespaceBrand,
  type SettingsProviderLike,
} from '../src/settings-locale.ts'

describe('readSettingsSection', () => {
  it('reads the section through the rc.2 brand helper', () => {
    const provider: SettingsProviderLike = {
      get: ns => (ns === 'locale' ? { preference: 'zh' } : undefined),
    }
    // rc.2 `settingsNamespace(ns)` returns `ns` at runtime (the brand is erased).
    const brand: SettingsNamespaceBrand = v => v
    expect(readSettingsSection(provider, 'locale', brand)).toEqual({ preference: 'zh' })
  })

  it('reads the section by raw namespace when the helper is absent (0.1.2-alpha.2)', () => {
    const provider: SettingsProviderLike = {
      get: ns => (ns === 'locale' ? { preference: 'en' } : undefined),
    }
    // alpha.2 removed the brand helper, so the caller passes undefined.
    const brand: SettingsNamespaceBrand = undefined
    expect(readSettingsSection(provider, 'locale', brand)).toEqual({ preference: 'en' })
  })

  it('passes the key returned by the brand helper to get()', () => {
    const received: string[] = []
    const provider: SettingsProviderLike = {
      get: ns => { received.push(ns); return undefined },
    }
    readSettingsSection(provider, 'locale', v => v)
    expect(received).toEqual(['locale'])
  })

  it('returns undefined for an unregistered section (never throws)', () => {
    const provider: SettingsProviderLike = { get: () => undefined }
    expect(readSettingsSection(provider, 'locale', v => v)).toBeUndefined()
  })

  it('is keyed by the raw namespace, not by the brand, so both generations agree', () => {
    const received: string[] = []
    const provider: SettingsProviderLike = {
      get: ns => { received.push(ns); return undefined },
    }
    // The brand helper returns the same string it was given (brand erased at runtime).
    readSettingsSection(provider, 'locale', v => v)
    expect(received).toEqual(['locale'])
  })
})
