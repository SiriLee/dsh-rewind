/**
 * dsh-rewind client logger: a single, namespaced, level-filtered logging
 * channel for every browser-side diagnostic in this plugin.
 *
 * Design (industry-normal layering, kept dependency-free):
 * - `error` / `warn` are ALWAYS emitted (they are the anomaly guard: rare,
 *   cheap, and must surface even for a user who never touched the switch).
 * - `info` / `debug` are gated by a DEBUG switch and further filtered by
 *   namespace, so verbose detail never floods a normal user's console.
 *
 * The DEBUG switch is a runtime, per-origin knob read from
 * `localStorage['dsh-rewind.debug']` — the convention-debug-scan pattern
 * (namespace match, comma-separated, `*` wildcard), scoped to an
 * exclusively-own key so it can never enable any other plugin/feature and no
 * other feature can wake this one. Because it is read on every call (never
 * cached), flipping it and reloading takes effect on any published build
 * without a plugin rebuild.
 *
 * Values accepted by the switch (empty/unset = off):
 * - `dsh-rewind*`  — every dsh-rewind namespace.
 * - `dsh-rewind:refill` — just one subsystem (exact match).
 * - `dsh-rewind:refill,dsh-rewind:hiding` — several (comma-separated).
 *
 * @module dsh-rewind/client/log
 */

/** Stable logger namespace prefix (mirrors the plugin's `name`). */
const NS = 'dsh-rewind'

/** The exclusively-own localStorage key controlling verbose output. */
const DEBUG_KEY = 'dsh-rewind.debug'

export type LogLevel = 'error' | 'warn' | 'info' | 'debug'

/** Levels that are emitted unconditionally (the anomaly guard). */
const ALWAYS_ON: ReadonlySet<LogLevel> = new Set(['error', 'warn'])

/**
 * Read the DEBUG switch value (null/'' = off). Never throws: localStorage can
 * be unavailable or throw under certain privacy/teardown windows, and logging
 * must never break the plugin.
 */
function switchValue(): string {
  try {
    return window.localStorage.getItem(DEBUG_KEY) ?? ''
  } catch {
    return ''
  }
}

/**
 * Whether namespace `ns` is selected by `value` (the `debug`-packag convention):
 * comma-separated entries, each an exact `dsh-rewind:scope` or a `*`-suffixed
 * prefix; `*` and `dsh-rewind*` select everything.
 */
function matches(value: string, ns: string): boolean {
  for (const entry of value.split(',')) {
    const part = entry.trim()
    if (part === '') continue
    if (part === '*' || part === `${NS}*`) return true
    if (part.endsWith('*')) {
      if (ns.startsWith(part.slice(0, -1))) return true
    } else if (ns === part) {
      return true
    }
  }
  return false
}

/** The tag line every entry starts with, e.g. `[dsh-rewind:refill]`. */
function tag(scope: string): string {
  return `[${NS}:${scope}]`
}

/**
 * Emit one diagnostic line. `error`/`warn` always print; `info`/`debug` print
 * only when the DEBUG switch selects the namespace. Both gated levels are
 * routed to the always-visible `console.info` rather than `console.debug`,
 * whose "Verbose" level Chrome filters out by default — otherwise a reporter
 * who turns the switch on still would not see the line without also changing
 * the DevTools level filter (mapped to `console.debug`). `data` is spread last
 * so DevTools' structured view keeps it inspectable (never stringified).
 */
export function log(level: LogLevel, scope: string, message: string, data?: unknown): void {
  if (ALWAYS_ON.has(level)) {
    console[level](tag(scope), message, data)
    return
  }
  if (!matches(switchValue(), `${NS}:${scope}`)) return
  console.info(tag(scope), message, data)
}

/** Convenience shorthands (typed so call sites read cleanly). */
export const rewindLog = {
  error: (scope: string, message: string, data?: unknown): void => log('error', scope, message, data),
  warn: (scope: string, message: string, data?: unknown): void => log('warn', scope, message, data),
  info: (scope: string, message: string, data?: unknown): void => log('info', scope, message, data),
  debug: (scope: string, message: string, data?: unknown): void => log('debug', scope, message, data),
} as const
