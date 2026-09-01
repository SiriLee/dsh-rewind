/**
 * Snapshot cleanup policy: the persisted config file, its validation, the
 * `/snapshot-auto-cleanup` command's argument grammar, and the auto-sweep
 * throttle. Kept free of host wiring so the policy and the parser are
 * unit-testable in isolation; `src/index.ts` is the only consumer.
 *
 * Semantics (the "cleanup" vocabulary deliberately avoids "retention"):
 * - `enabled` toggles the AUTOMATIC (24h) sweep. `false` (the default) keeps
 *   every snapshot — the pre-feature behavior — and never writes a file.
 * - `maxAgeDays` is the only "keep" knob: a finished session dir whose newest
 *   member stamp is older than this many days of idle is removed by a sweep.
 *   `0`/negative/non-integer are rejected, so a broken file can never steer
 *   the sweep into deleting everything.
 * - The config file is created ONLY by an explicit `/snapshot-auto-cleanup`
 *   write. An absent file reads as the safe default (off); an unreadable or
 *   invalid file reports `ok:false` so a sweep fail-closes (deletes nothing)
 *   instead of guessing.
 *
 * @module dsh-rewind/snapshot-cleanup
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import z from '@deepseek-ai/schemastery'

/** The cleanup policy, as persisted under `~/.dsh/snapshot-cleanup.json`. */
export interface CleanupConfig {
  readonly enabled: boolean
  readonly maxAgeDays: number
}

export const CLEANUP_CONFIG_FILENAME = 'snapshot-cleanup.json'

/** The default keep threshold: finished sessions idle > 30 days are pruned. */
export const DEFAULT_MAX_AGE_DAYS = 30

/** The safe default policy (off) — a missing/corrupt file behaves like this. */
export const DEFAULT_CLEANUP_CONFIG: CleanupConfig = { enabled: false, maxAgeDays: DEFAULT_MAX_AGE_DAYS }

/**
 * The dsh-settings namespace that backs the cleanup policy after migration.
 * Namespaces must match the settings provider's `^[a-z][a-z0-9-]*$` grammar (no
 * dots), so this is hyphenated, not dotted.
 */
export const CLEANUP_SETTINGS_NAMESPACE = 'dsh-rewind-snapshot-cleanup'

/**
 * The schemastery schema that persists + validates the cleanup policy in the
 * dsh-settings document. This is the SINGLE storage validator: the `maxAgeDays`
 * rule is enforced by `.step(1).min(1)` (positive integer) and the defaults by
 * `.default(...)`, so the resolved value is always a valid {@link CleanupConfig}
 * and a bad stored/user value cannot steer the sweep into deleting everything.
 */
export const CleanupConfigSchema: z<CleanupConfig> = z.object({
  enabled: z.boolean().default(DEFAULT_CLEANUP_CONFIG.enabled),
  maxAgeDays: z.number().step(1).min(1).default(DEFAULT_CLEANUP_CONFIG.maxAgeDays),
})

/**
 * Structural face of the settings scope the host needs for the policy: a
 * resolved read and a validated write. Kept local (never imports the settings
 * contract) so the host bundle links on both rc.2 and alpha — the settings
 * API drift (alpha adds `mutate`, rd2 does not) is confined to the seam the
 * host passes in, never to this module.
 */
export interface CleanupSettingsScope {
  /** The resolved policy: schema defaults, then base, then the user layer. */
  get(): CleanupConfig
  /** Merge a partial patch into the user layer (validated by the schema). */
  update(patch: { enabled?: boolean; maxAgeDays?: number }): Promise<void>
}

/** A validated policy read/write port the command + auto-sweep use. */
export interface CleanupConfigStore {
  /** The resolved policy (always schema-valid, fail-closes when unavailable). */
  load(): CleanupConfig
  /** Persist a validated policy, throwing when invalid or unavailable. */
  save(next: CleanupConfig): Promise<void>
}

/**
 * Adapter that turns a {@link CleanupSettingsScope} into a
 * {@link CleanupConfigStore}. Reads come straight from the resolved scope; a
 * write validates via `parseCleanupConfig` before touching the scope, so a bad
 * value can never reach the document (defense-in-depth below the schema).
 */
export function settingsCleanupStore(scope: CleanupSettingsScope): CleanupConfigStore {
  return {
    load: () => scope.get(),
    save: async (next) => {
      const parsed = parseCleanupConfig({ enabled: next.enabled, maxAgeDays: next.maxAgeDays })
      if (!parsed.ok) throw new RangeError(parsed.error)
      await scope.update({ enabled: parsed.config.enabled, maxAgeDays: parsed.config.maxAgeDays })
    },
  }
}

/**
 * One-time migration of the pre-GUI cleanup policy file into the settings
 * document. Idempotent and cheap: it is called on every startup but only does
 * work once — a present-and-parsed legacy file is written into the scope and
 * then deleted, after which the read is an ENOENT no-op. A missing file is a
 * no-op; an invalid file writes the safe default (deleting nothing) and logs.
 * This is the ONLY consumption of {@link loadCleanupConfig} after migration.
 * @returns whether a legacy file was actually migrated.
 */
export async function migrateLegacyCleanupConfig(
  legacyPath: string,
  scope: CleanupSettingsScope,
  log: (msg: string) => void,
): Promise<boolean> {
  const loaded = await loadCleanupConfig(legacyPath)
  if (!loaded.ok) {
    // A structurally invalid legacy file: write the safe default (so the sweep
    // never guesses from a broken file) and drop it. Never deletes data.
    log(`[dsh-rewind] legacy snapshot-cleanup config invalid, migrating defaults and removing: ${loaded.error}`)
    await scope.update({ enabled: false, maxAgeDays: DEFAULT_MAX_AGE_DAYS })
    await unlink(legacyPath).catch(() => undefined)
    return true
  }
  if (!loaded.fromFile) return false
  if (
    loaded.config.enabled === DEFAULT_CLEANUP_CONFIG.enabled
    && loaded.config.maxAgeDays === DEFAULT_CLEANUP_CONFIG.maxAgeDays
  ) {
    // File equals the defaults — nothing worth persisting; just drop it.
    await unlink(legacyPath).catch(() => undefined)
    return true
  }
  await scope.update({ enabled: loaded.config.enabled, maxAgeDays: loaded.config.maxAgeDays })
  await unlink(legacyPath).catch(() => undefined)
  log(`[dsh-rewind] migrated legacy snapshot-cleanup config (enabled=${String(loaded.config.enabled)}, maxAgeDays=${String(loaded.config.maxAgeDays)})`)
  return true
}

/** Auto-sweep cadence (the user's hardcoded 24h rhythm — not user-set). */
export const AUTO_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000

/**
 * Resolve the LEGACY pre-migration config file path (the only remaining use of
 * the file store): `<harness home>/snapshot-cleanup.json`, derived from
 * `dshHome` (config.dshHome > `$DSH_HOME` > `~/.dsh`) so the migration follows
 * the harness home instead of hardcoding `~/.dsh`. The `DSH_SNAPSHOT_CLEANUP_CONFIG`
 * env override was removed when the policy moved into the dsh-settings document.
 */
export function resolveCleanupConfigPath(dshHome?: string): string {
  return join(resolveDshHome(dshHome), CLEANUP_CONFIG_FILENAME)
}

/** The state file that records the last automatic-sweep wall-clock time. */
export const STATE_FILENAME = 'snapshot-cleanup-last-sweep.json'

/**
 * Resolve the last-sweep state path. It sits beside the config file so the
 * 24h cadence SURVIVES a host restart (a real deployment is rarely up 24/7,
 * so an in-memory timestamp would reset on every boot and re-sweep too often).
 */
export function resolveCleanupStatePath(dshHome?: string): string {
  return join(dirname(resolveCleanupConfigPath(dshHome)), STATE_FILENAME)
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
 * The one-shot auto-cleanup check. Loads the policy + persisted last-sweep time
 * and, only when enabled AND >=24h since the last sweep, runs the sweep and
 * re-anchors the window on disk. Dependencies (store, paths, logger) are
 * injected so the composition is unit-testable without a host. Never rejects:
 * a corrupt config fail-closes (no deletion) and logs, a prune failure logs.
 *
 * `sessionId` is the active session directory that must never be pruned.
 */
export async function runAutoCleanupCheck(
  deps: {
    pruner: AutoCleanupPruner
    readConfig: () => Promise<{ ok: true; config: CleanupConfig } | { ok: false; error: string }>
    statePath: string
    log: (msg: string) => void
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
    if (!shouldRunAutoSweep(await loadLastSweepAt(deps.statePath), Date.now())) return
    await deps.pruner.pruneStale({ keepActiveId: sessionId, maxAgeDays: loaded.config.maxAgeDays })
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

/**
 * Load and validate the config file. A missing file is NOT an error: it reads
 * as the safe default (off, `fromFile:false`). An unreadable, non-JSON, or
 * structurally-invalid file is `ok:false` so a sweep fail-closes.
 */
export async function loadCleanupConfig(
  path: string,
): Promise<{ ok: true; config: CleanupConfig; fromFile: boolean } | { ok: false; error: string }> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: true, config: { ...DEFAULT_CLEANUP_CONFIG }, fromFile: false }
    }
    return { ok: false, error: `config file unreadable: ${error instanceof Error ? error.message : String(error)}` }
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return { ok: false, error: `config file is not valid JSON: ${error instanceof Error ? error.message : String(error)}` }
  }
  const parsed = parseCleanupConfig(raw)
  if (!parsed.ok) return { ok: false, error: parsed.error }
  return { ok: true, config: parsed.config, fromFile: true }
}

/**
 * Persist a validated {@link CleanupConfig}, atomically (temp + rename). Any
 * invalid value throws before the file is touched, so the command can never
 * write a broken policy.
 */
export async function saveCleanupConfig(path: string, config: CleanupConfig): Promise<void> {
  if (typeof config.enabled !== 'boolean' || !Number.isInteger(config.maxAgeDays) || config.maxAgeDays <= 0) {
    throw new RangeError('invalid cleanup config: enabled must be a boolean and maxAgeDays a positive integer')
  }
  const tmp = `${path}.tmp`
  await mkdir(dirname(path), { recursive: true })
  await writeFile(tmp, JSON.stringify(config, null, 2), 'utf8')
  await rename(tmp, path)
}

/** The `/snapshot-auto-cleanup` sub-command the parser can resolve to. */
export type CleanupCommandAction = 'status' | 'on' | 'off' | 'max-age' | 'run'

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
