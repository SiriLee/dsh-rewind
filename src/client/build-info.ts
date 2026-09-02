/**
 * dsh-rewind client build identity.
 *
 * Two constants are injected by `scripts/build.mjs` at esbuild time (see the
 * `define` block there) and are NOT present in the source. They answer the
 * "am I even running the fixed bundle?" question — the most common, cheapest
 * root cause to rule in/out when a report lands:
 *   - `__DSH_REWIND_VERSION__` — the plugin version from `package.json`.
 *   - `__DSH_REWIND_BUILD__`   — a short content hash of the client source.
 *
 * They are read once at module load and surfaced (behind the existing
 * `dsh-rewind.debug` switch, never a new key) by `apply` in `index.ts`.
 *
 * @module dsh-rewind/client/build-info
 */

// Build-time globals, replaced by esbuild's `define` (see `scripts/build.mjs`);
// the declarations exist so the client typecheck passes (the names are
// undefined in the TS source). Reads are `typeof`-guarded so importing this
// module directly under the test runner (which has no `define`) resolves to a
// placeholder instead of a ReferenceError — `typeof` on an undeclared
// identifier never raises.
declare const __DSH_REWIND_VERSION__: string
declare const __DSH_REWIND_BUILD__: string

/** Plugin version baked in at build time (from `package.json`). */
export const PLUGIN_VERSION: string =
  typeof __DSH_REWIND_VERSION__ === 'string' ? __DSH_REWIND_VERSION__ : 'dev'

/** Short content hash of the client source, for stale-bundle detection. */
export const BUILD_HASH: string =
  typeof __DSH_REWIND_BUILD__ === 'string' ? __DSH_REWIND_BUILD__ : 'dev'
