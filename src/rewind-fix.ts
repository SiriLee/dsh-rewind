/**
 * `/dsh-rewind-fix` — orchestration layer.
 *
 * This module owns the COMMAND semantics and the per-session repair pipeline. It
 * intentionally does NOT re-implement the physical codec (`./session-log-io.ts`)
 * or the A/B→C transform (`./rewind-marker-repair.ts`); it wires those against
 * the harness's own session services (read path = `sessionPersistence` +
 * `ctx.sessions`; write path = self-contained 2-frame zstd rewrite + atomic
 * tmp+rename, because the persistence layer is append-only & repairing a log
 * must rewrite non-tail events).
 *
 * Safety model (settled in the design):
 *   - Only NON-loaded (closed) sessions are repaired. "Loaded" = the harness has
 *     the session's in-memory `this.log`, which is the seq authority — rewriting
 *     that session's file would fork it.
 *   - Per-session `.lock` (O_EXCL) guards against two tabs/processes fixing the
 *     same closed session concurrently.
 *   - Each repair is backed up and rolled back on write/verify failure; an
 *     interrupted run is idempotent (already-C / marker-free sessions are no-ops).
 *   - Repaired sessions have their snapshots cleared via `store.clearSession`.
 *
 * There is no streaming progress channel (`CommandResult` returns once), so the
 * command is "dry wait" like `/compact`: the client is told it takes minutes and
 * a single final summary is returned via `command/done`.
 *
 * {@link runRewindFix} is the DOMAIN core: it takes a narrow deps interface
 * (enumeration/read/locate/load-check/clear) so it can be exercised by unit tests
 * without wiring a real cordis `Context`. `registerRewindFix` adapts a real
 * `Context` + `SnapshotStore` into that interface and registers the command.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { copyFile, rename, unlink, writeFile, open } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import { repairRewindMarkers, isLegacyRewindMarker, type RepairOutput } from './rewind-marker-repair.ts'
import { decodeEventBody, encodeSessionLog, splitSession } from './session-log-io.ts'

/** Structural view of the harness `sessionPersistence` service (never type-coupled to the host bundle). */
interface PersistenceFace {
  listSnapshots(signal?: AbortSignal): Promise<Array<{ header: SessionHeader }>>
  readRaw(id: SessionId, signal?: AbortSignal): Promise<{ content: string } | undefined>
  locate(meta: SessionHeader): { kind: string; path: string } | undefined
}

/** Structural view of the snapshot store the repair needs (`clearSession` only). */
interface SnapshotStoreLike {
  clearSession(sessionId: string): Promise<unknown>
}

/** The narrow dependency set {@link runRewindFix} needs (injected; unit-testable). */
export interface RewindFixDeps {
  listSnapshots(signal?: AbortSignal): Promise<Array<{ header: SessionHeader }>>
  readRaw(id: SessionId, signal?: AbortSignal): Promise<{ content: string } | undefined>
  locate(header: SessionHeader): { path: string } | undefined
  isSessionLoaded(id: SessionId): boolean
  clearSession(id: string): Promise<unknown>
}

export interface RewindFixOptions {
  /** `--apply` executes the repair; otherwise dry run (no writes). */
  apply: boolean
  /** The launcher session itself needs repair (guard warning). */
  launcherHasMarkers: boolean
  signal?: AbortSignal
}

/** One per-session outcome, carried into the final summary. */
interface SessionOutcome {
  id: string
  status: 'repaired' | 'skipped' | 'failed'
  a: number
  b: number
  c: number
  error?: string
}

/** Parse the command input: `--apply` performs the repair; anything else is a dry-run. */
function isApplyInput(raw: string): boolean {
  return raw.trim() === '--apply'
}

const LAUNCHER_GUARD =
  '! This is a session that itself needs repair; it is open and cannot be modified in place.\n'
  + '  Start a NEW session (or close this one) — a closed session is repaired when no window holds it.'

/**
 * Register the `/dsh-rewind-fix` host command. `store` must be the plugin's
 * `SnapshotStore` so repaired sessions get their snapshots cleared.
 */
export function registerRewindFix(ctx: Context, store: SnapshotStoreLike): void {
  let persistence: PersistenceFace | undefined
  ctx.inject(['sessionPersistence'], (scope) => {
    persistence = (scope as unknown as { sessionPersistence: unknown }).sessionPersistence as unknown as PersistenceFace
  })

  ctx.effect(function* () {
    yield ctx.commands.register({
      name: 'dsh-rewind-fix',
      description: 'Rewrite legacy rewind markers (A/B) in closed sessions to the current form-C shape.',
      input: { hint: 'no args = dry-run preview; --apply = execute (takes minutes)' },
      handler: (invocation: CommandInvocation): Promise<CommandResult> =>
        handleRewindFix(ctx, store, persistence, invocation),
    })
  }, 'dsh-rewind-fix command')
}

async function handleRewindFix(
  ctx: Context,
  store: SnapshotStoreLike,
  persistence: PersistenceFace | undefined,
  invocation: CommandInvocation,
): Promise<CommandResult> {
  if (persistence === undefined) {
    return { kind: 'error', text: 'Session persistence is unavailable; cannot run the rewind-fix command.' }
  }
  // `ctx.sessions` is a cordis property that requires the service to be in this
  // plugin's inject list; reading it via `ctx.get` has no such requirement. The
  // SessionStore is a core harness service, always present.
  const sessions = ctx.get('sessions')
  if (sessions === undefined) {
    return { kind: 'error', text: 'The session store is unavailable; cannot run the rewind-fix command.' }
  }
  const launcher = invocation.agent?.session
  const deps: RewindFixDeps = {
    listSnapshots: signal => persistence.listSnapshots(signal),
    readRaw: (id, signal) => persistence.readRaw(id, signal),
    locate: header => persistence.locate(header),
    isSessionLoaded: id => sessions.get(id) !== undefined,
    clearSession: id => store.clearSession(id),
  }
  const text = await runRewindFix(deps, {
    apply: isApplyInput(invocation.rawInput),
    launcherHasMarkers: (launcher?.snapshotEvents() ?? []).some(isLegacyRewindMarker),
    signal: invocation.signal,
  })
  return { kind: 'success', text }
}

/**
 * The domain core. Enumerates all persisted sessions, applies the safety rules,
 * repairs each marker-bearing CLOSED session, and returns the report text.
 * Throws on nothing — every per-session failure is recorded and the run
 * continues (idempotent; a rollback restores the original artifact).
 */
export async function runRewindFix(deps: RewindFixDeps, opts: RewindFixOptions): Promise<string> {
  const snapshots = await deps.listSnapshots(opts.signal)
  const report: string[] = []
  if (opts.launcherHasMarkers) report.push(LAUNCHER_GUARD)

  const outcomes: SessionOutcome[] = []
  const started = Date.now()

  for (let i = 0; i < snapshots.length; i += 1) {
    if (opts.signal?.aborted) return `${report.join('\n')}\n=== cancelled ===`
    const header = snapshots[i]!.header
    const id = header.id as string
    const label = i + 1

    // Safety rule 1: never touch a session the harness has loaded.
    if (deps.isSessionLoaded(header.id)) {
      outcomes.push({ id, status: 'skipped', a: 0, b: 0, c: 0 })
      report.push(`[${label}/${snapshots.length}] ${id}  SKIP (loaded)`)
      continue
    }

    let decoded: Awaited<ReturnType<typeof readEvents>>
    try {
      decoded = await readEvents(deps, header.id, opts.signal)
    } catch (error) {
      outcomes.push({ id, status: 'failed', a: 0, b: 0, c: 0, error: textOf(error) })
      report.push(`[${label}/${snapshots.length}] ${id}  FAIL (unreadable) ${textOf(error)}`)
      continue
    }
    if (decoded === undefined) {
      outcomes.push({ id, status: 'skipped', a: 0, b: 0, c: 0 })
      report.push(`[${label}/${snapshots.length}] ${id}  SKIP (no artifact)`)
      continue
    }

    let repair: RepairOutput
    try {
      repair = repairRewindMarkers(decoded.events)
    } catch (error) {
      outcomes.push({ id, status: 'failed', a: 0, b: 0, c: 0, error: textOf(error) })
      report.push(`[${label}/${snapshots.length}] ${id}  FAIL (repair) ${textOf(error)}`)
      continue
    }

    const hasMarkers = repair.stats.a + repair.stats.b > 0
    if (!hasMarkers) {
      outcomes.push({ id, status: 'skipped', a: 0, b: 0, c: 0 })
      report.push(`[${label}/${snapshots.length}] ${id}  SKIP (no markers)`)
      continue
    }

    report.push(`[${label}/${snapshots.length}] ${id}  A=${repair.stats.a} B=${repair.stats.b} → C=${repair.stats.a + repair.stats.b + repair.stats.c}`)
    if (!opts.apply) {
      // Dry-run: record this session as "will be repaired" so the summary counts it.
      outcomes.push({ id, status: 'repaired', a: repair.stats.a, b: repair.stats.b, c: repair.stats.a + repair.stats.b + repair.stats.c })
      continue
    }

    const outcome = await executeSession(deps, header, decoded.headerLine, repair)
    outcomes.push(outcome)
    if (outcome.status === 'repaired') report.push(`  ↳ snapCleared ✓ written ✓`)
    else if (outcome.status === 'failed') report.push(`  ↳ FAIL ${outcome.error ?? ''}`)
    else report.push(`  ↳ SKIP (loaded now)` + (outcome.error ? ` ${outcome.error}` : ''))
  }

  const summary = summarize(outcomes, opts.apply, Date.now() - started)
  return report.length > 0 ? `${report.join('\n')}\n${summary}` : summary
}

function summarize(outcomes: SessionOutcome[], apply: boolean, ms: number): string {
  const repaired = outcomes.filter(o => o.status === 'repaired').length
  const skipped = outcomes.filter(o => o.status === 'skipped').length
  const failed = outcomes.filter(o => o.status === 'failed').length
  const secs = (ms / 1000).toFixed(1)
  if (!apply) {
    return `=== dry-run: ${outcomes.length} sessions scanned / ${repaired} will be repaired / ${skipped} skipped / ${failed} failed (${secs}s) ===`
  }
  return `=== done: ${repaired} repaired / ${skipped} skipped / ${failed} failed (${secs}s) ===`
}

/** Read + decode one session's event body (throw = unreadable, undefined = no artifact). */
async function readEvents(
  deps: RewindFixDeps,
  id: SessionId,
  signal?: AbortSignal,
): Promise<{ events: RepairOutput['events']; headerLine: string } | undefined> {
  const raw = await deps.readRaw(id, signal)
  if (raw === undefined) return undefined
  const { headerLine, body } = splitSession(raw.content)
  const events = decodeEventBody(body)
  return { events, headerLine }
}

/** Execute the repair for ONE closed session: recheck lock, backup, write, verify, clear snapshots. */
async function executeSession(
  deps: RewindFixDeps,
  header: SessionHeader,
  headerLine: string,
  repair: RepairOutput,
): Promise<SessionOutcome> {
  const id = header.id as string
  const base = { id, a: repair.stats.a, b: repair.stats.b, c: repair.stats.a + repair.stats.b + repair.stats.c }

  // Safety rule (re-check right before touching disk): the user may have opened it.
  if (deps.isSessionLoaded(header.id)) {
    return { ...base, status: 'skipped', error: 'loaded between scan and write' }
  }

  const location = deps.locate(header)
  if (location === undefined) return { ...base, status: 'failed', error: 'locate() returned no path' }
  const path = location.path
  const lockPath = `${path}.rewind-fix.lock`
  const tmpPath = `${path}.rewind-fix.tmp`
  const bakPath = `${path}.rewind-fix.bak`

  // Cross-process mutual exclusion on this ONE session (O_EXCL).
  let lock: Awaited<ReturnType<typeof open>> | undefined
  try {
    lock = await open(lockPath, 'wx')
  } catch (error) {
    return { ...base, status: 'failed', error: `locked by another process (${textOf(error)})` }
  }

  try {
    // Back up the original before touching it.
    await copyFile(path, bakPath)
    // Re-encode and atomically replace.
    const buffer = encodeSessionLog(headerLine, repair.events)
    await writeFile(tmpPath, buffer)
    await rename(tmpPath, path)

    // Post-write verification: decode the fresh artifact back and compare logically.
    const verification = await verifyWritten(deps, header.id)
    if (verification === undefined) throw new Error('written artifact could not be re-read')
    if (!isDeepStrictEqual(normalizeForVerify(verification), normalizeForVerify(repair.events))) {
      throw new Error('round-trip mismatch after write')
    }

    // Clear this session's snapshots (uniform, idempotent).
    await deps.clearSession(id)
    return { ...base, status: 'repaired' }
  } catch (error) {
    // Roll back from the backup; best-effort leftover cleanup.
    await unlink(tmpPath).catch(() => {})
    await rename(bakPath, path).catch(() => {})
    return { ...base, status: 'failed', error: textOf(error) }
  } finally {
    await lock.close().catch(() => {})
    await unlink(lockPath).catch(() => {})
    // On success the backup is consumed; on failure it was renamed back.
    await unlink(bakPath).catch(() => {})
  }
}

/** Re-read the just-written artifact and decode its events. */
async function verifyWritten(deps: RewindFixDeps, id: SessionId): Promise<SessionEvent[] | undefined> {
  const raw = await deps.readRaw(id)
  if (raw === undefined) return undefined
  return decodeEventBody(splitSession(raw.content).body)
}

/** Event-level logical key: {type, seq, data}. */
function normalizeForVerify(events: readonly SessionEvent[]): object[] {
  return events.map(e => ({ type: e.type, seq: e.seq, data: e.data }))
}

function textOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
