/**
 * Version-neutral settings-namespace reading for the host half.
 *
 * This is a "0.1.1-rc.2 ↔ 0.1.2-rc.1" dual channel. DSH 0.1.1-rc.2 exposes a
 * `settingsNamespace(value)` brand helper, and `settings.get` is typed to
 * require a branded `SettingsNamespace`. The 0.1.2 line (0.1.2-rc.1) removed
 * that helper (the `SettingsNamespace` *type* remains) and `settings.get`
 * accepts the raw namespace string. This module collapses both into one runtime
 * call: on 0.1.1-rc.2 the brand is a compile-time marker erased at runtime (so
 * `settingsNamespace(ns)` returns `ns`), on 0.1.2-rc.1 the brand helper is
 * absent and the raw `ns` string is used directly. That is what lets a single
 * compiled host bundle link and run on both harness generations.
 *
 * @module dsh-rewind/settings-locale
 */

/** Minimal structural face of the settings provider the host reads from. */
export interface SettingsProviderLike {
  /**
   * Read one registered settings section by namespace. Accepts whatever the
   * running DSH generation passes: a branded `SettingsNamespace` (0.1.1-rc.2,
   * brand erased) or the raw namespace string (0.1.2-rc.1).
   */
  get(ns: string): unknown
}

/** The `settingsNamespace(ns)` brand helper, or `undefined` when removed (0.1.2-rc.1). */
export type SettingsNamespaceBrand = ((value: string) => string) | undefined

/**
 * Read one settings section keyed by `ns`, tolerant of the settings-namespace
 * brand across DSH generations. Pass the brand helper when available (the
 * 0.1.1-rc.2 path); it is `undefined` on 0.1.2-rc.1, where the raw `ns` string
 * is used directly. Never throws: an absent section simply returns `undefined`.
 */
export function readSettingsSection(
  provider: SettingsProviderLike,
  ns: string,
  brand: SettingsNamespaceBrand,
): unknown {
  const key = brand?.(ns) ?? ns
  return provider.get(key)
}
