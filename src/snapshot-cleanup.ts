/**
 * Snapshot cleanup policy: the config-backed policy, its validation, the
 * `/snapshot-auto-cleanup` command's argument grammar, and the auto-sweep
 * throttle. Kept free of host wiring so the policy and the parser are
 * unit-testable in isolation; `src/index.ts` is the only consumer.
 *
 * Semantics (the "cleanup" vocabulary deliberately avoids "retention"):
 * - `enabled` toggles the AUTOMATIC (24h) sweep. `false` (the default) keeps
 *   every snapshot — the pre-feature behavior — and never persists a policy.
 * - `maxAgeDays` is the only "keep" knob: a finished session dir whose newest
 *   member stamp is older than this many days of idle is removed by a sweep.
 *   `0`/negative/non-integer are rejected, so a broken value can never steer
 *   the sweep into deleting everything.
 * - The policy is this plugin entry's live configuration (`enabled` /
 *   `maxAgeDays`); an absent value is the safe default (off), and an invalid
 *   one fail-closes a sweep (deletes nothing) instead of guessing.
 *
 * @module dsh-rewind/snapshot-cleanup
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Volatile } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** The cleanup policy, as resolved from this plugin entry's configuration. */
export interface CleanupConfig {
  readonly enabled: boolean
  readonly maxAgeDays: number
}

/** The default keep threshold: finished sessions idle > 30 days are pruned. */
export const DEFAULT_MAX_AGE_DAYS = 30

/** The safe default policy (off) — a missing/corrupt value behaves like this. */
export const DEFAULT_CLEANUP_CONFIG: CleanupConfig = { enabled: false, maxAgeDays: DEFAULT_MAX_AGE_DAYS }

/**
 * The live configuration slice the cleanup policy reads: the two schema fields
 * the host resolves into stable references before `apply` runs. The host's
 * `Config` schema (see `src/index.ts`) declares both as `.volatile()`, which is
 * what makes them user-editable in the Plugins page and live-updated without a
 * restart.
 */
export interface CleanupSettings {
  readonly enabled: Volatile<boolean>
  readonly maxAgeDays: Volatile<number>
}

/**
 * The host settings service's entry write port. A write is a revision-fenced
 * document mutation, so clearing a field is what lets it re-inherit the schema
 * default instead of pinning a copy of it.
 */
export interface CleanupConfigWriter {
  /** Entry id the write addresses (this plugin's profile entry). */
  readonly entryId: string
  /** Merge field values into the entry's user layer. */
  update(entryId: string, patch: { enabled?: boolean; maxAgeDays?: number }): Promise<void>
  /** Remove fields from the entry's user layer, restoring the inherited value. */
  clear(entryId: string, fields: readonly string[]): Promise<void>
}

/** A validated policy read/write port the command + auto-sweep use. */
export interface CleanupConfigStore {
  /** The resolved policy (always schema-valid, fail-closes when unavailable). */
  load(): CleanupConfig
  /** Persist a validated policy, throwing when invalid or unavailable. */
  save(next: CleanupConfig): Promise<void>
}

/**
 * Adapter over the live {@link CleanupSettings} references and the host's entry
 * write port. Reads re-read the references, so a settings write is visible
 * without a remount; writes validate via `parseCleanupConfig` first, so a bad
 * value can never reach the document (defense-in-depth below the schema), and a
 * defaulted field is cleared rather than pinned.
 */
export function volatileCleanupStore(
  settings: CleanupSettings,
  writer: CleanupConfigWriter,
): CleanupConfigStore {
  return {
    load: () => ({
      enabled: settings.enabled.get() ?? DEFAULT_CLEANUP_CONFIG.enabled,
      maxAgeDays: settings.maxAgeDays.get() ?? DEFAULT_CLEANUP_CONFIG.maxAgeDays,
    }),
    save: async (next) => {
      const parsed = parseCleanupConfig({ enabled: next.enabled, maxAgeDays: next.maxAgeDays })
      if (!parsed.ok) throw new RangeError(parsed.error)
      const clears = (['enabled', 'maxAgeDays'] as const)
        .filter(field => parsed.config[field] === DEFAULT_CLEANUP_CONFIG[field])
      if (clears.length > 0) await writer.clear(writer.entryId, clears)
      const patch: { enabled?: boolean; maxAgeDays?: number } = {}
      if (!clears.includes('enabled')) patch.enabled = parsed.config.enabled
      if (!clears.includes('maxAgeDays')) patch.maxAgeDays = parsed.config.maxAgeDays
      if (Object.keys(patch).length > 0) await writer.update(writer.entryId, patch)
    },
  }
}

/** Auto-sweep cadence (the user's hardcoded 24h rhythm — not user-set). */
export const AUTO_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000

/** The state file that records the last automatic-sweep wall-clock time. */
export const STATE_FILENAME = 'snapshot-cleanup-last-sweep.json'

/**
 * Resolve the last-sweep state path. It sits under the harness home so the
 * 24h cadence SURVIVES a host restart (a real deployment is rarely up 24/7,
 * so an in-memory timestamp would reset on every boot and re-sweep too often).
 */
export function resolveCleanupStatePath(dshHome?: string): string {
  return join(resolveDshHome(dshHome), STATE_FILENAME)
}

/**
 * Read the persisted last-sweep time (epoch ms). A missing or corrupt file
 * reads as `0` ("never swept"), so the next activity runs the sweep — which is
 * safe because the sweep is idempotent and never deletes the active session.
 */
export async function loadLastSweepAt(path: string): Promise<number> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as { lastSweepAt?: unknown }
    const value = raw['lastSweepAt']
    return typeof value === 'number' && Number.isFinite(value) ? value : 0
  } catch {
    return 0 // missing / unreadable / corrupt: treat as never swept
  }
}

/** Persist the last-sweep time, atomically (temp + rename). */
export async function saveLastSweepAt(path: string, ms: number): Promise<void> {
  const tmp = `${path}.tmp`
  await mkdir(dirname(path), { recursive: true })
  await writeFile(tmp, JSON.stringify({ lastSweepAt: ms }), 'utf8')
  await rename(tmp, path)
}

/** The slice of a store `runAutoCleanupCheck` needs (pruneStale). */
export interface AutoCleanupPruner {
  pruneStale(opts: { keepActiveId?: string; maxAgeDays: number; dryRun?: boolean }): Promise<unknown>
}

/**
 * Whether the caller's mount has been aborted. A call, not an inline
 * comparison: the flag flips between awaits, and TypeScript narrows an inlined
 * check to a constant after the first one.
 * @param signal - the mount lifecycle signal, when the caller has one.
 * @returns whether the mount has been aborted.
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

/**
 * The one-shot auto-cleanup check. Loads the policy + persisted last-sweep time
 * and, only when enabled AND >=24h since the last sweep, runs the sweep and
 * re-anchors the window on disk. Dependencies (store, paths, logger) are
 * injected so the composition is unit-testable without a host. Never rejects:
 * a corrupt config fail-closes (no deletion) and logs, a prune failure logs.
 *
 * `sessionId` is the active session directory that must never be pruned.
 * `signal` is the caller's mount lifecycle: an abort before the prune or before
 * the re-anchor stops the sweep (a live plugin unload must not keep deleting
 * under a disposed owner).
 */
export async function runAutoCleanupCheck(
  deps: {
    pruner: AutoCleanupPruner
    readConfig: () => Promise<{ ok: true; config: CleanupConfig } | { ok: false; error: string }>
    statePath: string
    log: (msg: string) => void
    /** Optional mount lifecycle signal; absent means "never cancelled". */
    signal?: AbortSignal
  },
  sessionId: string | undefined,
): Promise<void> {
  try {
    const loaded = await deps.readConfig()
    if (!loaded.ok) {
      deps.log(`[dsh-rewind] snapshot cleanup config invalid; auto-cleanup skipped: ${loaded.error}`)
      return
    }
    if (!loaded.config.enabled) return
    if (isAborted(deps.signal)) return
    if (!shouldRunAutoSweep(await loadLastSweepAt(deps.statePath), Date.now())) return
    if (isAborted(deps.signal)) return
    await deps.pruner.pruneStale({ keepActiveId: sessionId, maxAgeDays: loaded.config.maxAgeDays })
    // Re-anchoring after an unload would claim a sweep that a fresh mount then
    // skips for 24h, so the window only moves while the mount is alive.
    if (isAborted(deps.signal)) return
    await saveLastSweepAt(deps.statePath, Date.now())
  } catch (error) {
    deps.log(`[dsh-rewind] snapshot auto-cleanup failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Validate one parsed JSON value into a {@link CleanupConfig}. Tolerates
 * unknown extra keys; rejects a present-but-wrong-typed known key. Missing
 * known keys fall back to the safe default.
 */
export function parseCleanupConfig(raw: unknown): { ok: true; config: CleanupConfig } | { ok: false; error: string } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'config must be a JSON object' }
  }
  const record = raw as Record<string, unknown>
  let enabled = DEFAULT_CLEANUP_CONFIG.enabled
  let maxAgeDays = DEFAULT_CLEANUP_CONFIG.maxAgeDays
  if (record['enabled'] !== undefined) {
    if (typeof record['enabled'] !== 'boolean') return { ok: false, error: '"enabled" must be a boolean' }
    enabled = record['enabled']
  }
  if (record['maxAgeDays'] !== undefined) {
    const value = record['maxAgeDays']
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
      return { ok: false, error: '"maxAgeDays" must be a positive integer' }
    }
    maxAgeDays = value
  }
  return { ok: true, config: { enabled, maxAgeDays } }
}

/** A parsed `/snapshot-auto-cleanup` command (excludes the error branch). */
export type CleanupCommand =
  | { action: 'status' | 'on' | 'off' }
  | { action: 'max-age'; value: number }
  | { action: 'run'; target: 'rules' | 'current'; apply: boolean }

/**
 * Parse the free-form text after `/snapshot-auto-cleanup`. Pure so it is
 * unit-testable; `src/index.ts` maps the resolved action onto the store / the
 * config file. `max-age` returns the validated positive day count.
 *
 * The `run` verb is the single manual-cleanup action. `--apply` is the ONLY
 * execute-vs-dry-run switch (position-independent): without it the action is a
 * dry-run preview. `--current` re-targets the action to the ACTIVE session's
 * snapshots (the manual "clear this session now"); without it, `run` keeps its
 * age-based stale-session sweep semantics. The old `run-apply` abbreviation is
 * gone — use `run --apply`.
 */
export function parseCleanupCommand(rawInput: string): CleanupCommand | { error: string } {
  const parts = rawInput.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return { action: 'status' }
  switch (parts[0]) {
    case 'status':
      return parts.length === 1 ? { action: 'status' } : { error: 'usage: /snapshot-auto-cleanup status' }
    case 'on':
      return parts.length === 1 ? { action: 'on' } : { error: 'usage: /snapshot-auto-cleanup on' }
    case 'off':
      return parts.length === 1 ? { action: 'off' } : { error: 'usage: /snapshot-auto-cleanup off' }
    case 'max-age': {
      if (parts.length !== 2) return { error: 'usage: /snapshot-auto-cleanup max-age <days>' }
      const days = Number(parts[1])
      if (!Number.isInteger(days) || days <= 0) return { error: '"max-age" must be a positive integer (days)' }
      return { action: 'max-age', value: days }
    }
    case 'run-apply':
      return { error: 'the "run-apply" abbreviation was removed; use "run --apply"' }
    case 'run': {
      let apply = false
      let current = false
      for (const rawFlag of parts.slice(1)) {
        if (rawFlag === '--apply') {
          apply = true
        } else if (rawFlag === '--current') {
          current = true
        } else {
          return { error: `unknown /snapshot-auto-cleanup run flag "${rawFlag}"` }
        }
      }
      return { action: 'run', target: current ? 'current' : 'rules', apply }
    }
    default:
      return { error: `unknown /snapshot-auto-cleanup subcommand "${parts[0]}"` }
  }
}

/**
 * The 24h auto-sweep throttle. `lastAtMs` of `0` means "never ran" (a fresh
 * process), so the first call always sweeps; after that a call within 24h is
 * a no-op, matching the "every machine at most once per day" model.
 */
export function shouldRunAutoSweep(lastAtMs: number, nowMs: number): boolean {
  return nowMs - lastAtMs >= AUTO_SWEEP_INTERVAL_MS
}
