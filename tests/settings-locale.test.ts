/**
 * Unit tests for readSettingsSection (src/settings-locale.ts): the version-neutral
 * settings-namespace read that lets the host bundle link and run on BOTH DSH rc.2
 * (which exports the `settingsNamespace` brand helper) and 0.1.2-alpha.2 (which
 * removed it).
 *
 * Regression guard: if someone reverts the host back to a static
 * `settings.get(settingsNamespace('locale'))`, the bundle would fail to link on
 * alpha.2 (the helper is gone). These tests pin the dual-version behavior of the
 * read and, crucially, that the *brand's return value* (not the raw namespace) is
 * what gets forwarded to `settings.get` — so the tests fail if the brand is ever
 * dropped. scripts/build.mjs separately guards the artifact (no static named
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
    // rc.2 `settingsNamespace('locale')` returns `'locale'` (the brand is erased
    // at runtime), so the presence of the helper must not change the read.
    const brand: SettingsNamespaceBrand = v => v
    expect(readSettingsSection(provider, 'locale', brand)).toEqual({ preference: 'zh' })
  })

  it('reads the section by raw namespace when the helper is absent (0.1.2-alpha.2)', () => {
    const provider: SettingsProviderLike = {
      get: ns => (ns === 'locale' ? { preference: 'en' } : undefined),
    }
    // alpha.2 removed the brand helper, so the caller passes undefined and the
    // raw namespace string is used directly.
    const brand: SettingsNamespaceBrand = undefined
    expect(readSettingsSection(provider, 'locale', brand)).toEqual({ preference: 'en' })
  })

  it("forwards the brand helper's return value, not the raw namespace", () => {
    const received: string[] = []
    const provider: SettingsProviderLike = {
      get: ns => { received.push(ns); return undefined },
    }
    // A transforming brand proves the resolved key comes from the brand's output
    // (`brand(ns) ?? ns`), not from `ns` directly. A regression that drops the
    // brand and reads `provider.get(ns)` would fail this assertion.
    readSettingsSection(provider, 'locale', ns => `branded:${ns}`)
    expect(received).toEqual(['branded:locale'])
  })

  it('returns undefined for an unregistered section (never throws)', () => {
    const provider: SettingsProviderLike = { get: () => undefined }
    expect(readSettingsSection(provider, 'locale', v => v)).toBeUndefined()
  })
})
