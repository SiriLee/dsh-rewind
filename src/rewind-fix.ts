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
 * {@link runRewindFix} is the DOMAIN core: it returns structured data (not a
 * rendered string) over a narrow deps interface, so it is unit-testable without a
 * real cordis `Context` and stays locale-agnostic. `renderRewindFixReport`
 * renders that data through the plugin's locale translator `t`, and
 * `registerRewindFix` adapts a real `Context` + `SnapshotStore` + renderer and
 * registers the command.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { copyFile, rename, unlink, writeFile, open } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import { repairRewindMarkers, isLegacyRewindMarker, type RepairOutput } from './rewind-marker-repair.ts'
import { decodeEventBody, encodeSessionLog, splitSession } from './session-log-io.ts'

/** A locale renderer: dictionary key + optional `{name}` params → text. */
export type RenderFn = (key: string, params?: Record<string, string | number>) => string

/** Structural view of the harness `sessionPersistence` service (never type-coupled to the host bundle). */
interface PersistenceFace {
  listSnapshots(signal?: AbortSignal): Promise<Array<{ header: SessionHeader }>>
  readRaw(id: SessionId, signal?: AbortSignal): Promise<{ content: string; meta?: SessionHeader } | undefined>
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

/** Why a session was skipped or failed (drives the localized label). */
export type OutcomeReason =
  | 'loaded' | 'no-markers' | 'no-artifact' | 'loaded-between'
  | 'unreadable' | 'repair' | 'locked'

/** One per-session outcome, carried into the report. */
export interface SessionOutcome {
  readonly id: string
  readonly status: 'repaired' | 'skipped' | 'failed'
  readonly a: number
  readonly b: number
  readonly c: number
  readonly reason?: OutcomeReason
  readonly error?: string
}

/** Structured result of {@link runRewindFix} (locale-agnostic, unit-testable). */
export interface RewindFixResult {
  readonly launcherHasMarkers: boolean
  readonly cancelled: boolean
  readonly scanned: number
  readonly durationMs: number
  readonly apply: boolean
  readonly sessions: SessionOutcome[]
}

/** Parse the command input: `--apply` performs the repair; anything else is a dry-run. */
function isApplyInput(raw: string): boolean {
  return raw.trim() === '--apply'
}

/**
 * Register the `/dsh-rewind-fix` host command. `store` must be the plugin's
 * `SnapshotStore` so repaired sessions get their snapshots cleared; `render` is
 * the plugin's locale translator.
 */
export function registerRewindFix(ctx: Context, store: SnapshotStoreLike, render: RenderFn): void {
  let persistence: PersistenceFace | undefined
  ctx.inject(['sessionPersistence'], (scope) => {
    persistence = (scope as unknown as { sessionPersistence: unknown }).sessionPersistence as unknown as PersistenceFace
  })

  ctx.effect(function* () {
    yield ctx.commands.register({
      name: 'dsh-rewind-fix',
      description: render('rewindfix.description'),
      input: { hint: render('rewindfix.inputHint') },
      handler: (invocation: CommandInvocation): Promise<CommandResult> =>
        handleRewindFix(ctx, store, persistence, invocation, render),
    })
  }, 'dsh-rewind-fix command')
}

async function handleRewindFix(
  ctx: Context,
  store: SnapshotStoreLike,
  persistence: PersistenceFace | undefined,
  invocation: CommandInvocation,
  render: RenderFn,
): Promise<CommandResult> {
  if (persistence === undefined) {
    return { kind: 'error', text: render('rewindfix.persistenceUnavailable') }
  }
  // `ctx.sessions` is a cordis property that requires the service in this
  // plugin's inject list; reading it via `ctx.get` has no such requirement. The
  // SessionStore is a core harness service, always present.
  const sessionStore = ctx.get('sessions')
  if (sessionStore === undefined) {
    return { kind: 'error', text: render('rewindfix.sessionStoreUnavailable') }
  }
  const launcher = invocation.agent?.session
  const deps: RewindFixDeps = {
    listSnapshots: signal => persistence.listSnapshots(signal),
    readRaw: (id, signal) => persistence.readRaw(id, signal),
    locate: header => persistence.locate(header),
    isSessionLoaded: id => sessionStore.get(id) !== undefined,
    clearSession: id => store.clearSession(id),
  }
  const result = await runRewindFix(deps, {
    apply: isApplyInput(invocation.rawInput),
    launcherHasMarkers: (launcher?.snapshotEvents() ?? []).some(isLegacyRewindMarker),
    signal: invocation.signal,
  })
  return { kind: 'success', text: renderRewindFixReport(result, render) }
}

/**
 * The domain core. Enumerates all persisted sessions, applies the safety rules,
 * repairs each marker-bearing CLOSED session, and returns structured outcome
 * data. It never throws: every per-session failure is recorded and the run
 * continues (idempotent; a rollback restores the original artifact).
 */
export async function runRewindFix(deps: RewindFixDeps, opts: RewindFixOptions): Promise<RewindFixResult> {
  const snapshots = await deps.listSnapshots(opts.signal)
  const sessions: SessionOutcome[] = []
  const started = Date.now()

  for (let i = 0; i < snapshots.length; i += 1) {
    if (opts.signal?.aborted) return finish(sessions, snapshots.length, opts, started, true)
    const header = snapshots[i]!.header
    const id = header.id as string

    // Safety rule 1: never touch a session the harness has loaded.
    if (deps.isSessionLoaded(header.id)) {
      sessions.push({ id, status: 'skipped', a: 0, b: 0, c: 0, reason: 'loaded' })
      continue
    }

    let decoded: Awaited<ReturnType<typeof readEvents>>
    try {
      decoded = await readEvents(deps, header.id, opts.signal)
    } catch (error) {
      sessions.push({ id, status: 'failed', a: 0, b: 0, c: 0, reason: 'unreadable', error: textOf(error) })
      continue
    }
    if (decoded === undefined) {
      sessions.push({ id, status: 'skipped', a: 0, b: 0, c: 0, reason: 'no-artifact' })
      continue
    }

    let repair: RepairOutput
    try {
      repair = repairRewindMarkers(decoded.events)
    } catch (error) {
      sessions.push({ id, status: 'failed', a: 0, b: 0, c: 0, reason: 'repair', error: textOf(error) })
      continue
    }

    const hasMarkers = repair.stats.a + repair.stats.b > 0
    if (!hasMarkers) {
      sessions.push({ id, status: 'skipped', a: 0, b: 0, c: 0, reason: 'no-markers' })
      continue
    }

    if (!opts.apply) {
      // Dry-run: record as "will be repaired" so the headline counts it.
      sessions.push({ id, status: 'repaired', a: repair.stats.a, b: repair.stats.b, c: repair.stats.a + repair.stats.b + repair.stats.c })
      continue
    }

    sessions.push(await executeSession(deps, header, decoded.headerLine, repair))
  }

  return finish(sessions, snapshots.length, opts, started, false)
}

/** Assemble the structured result. */
function finish(sessions: SessionOutcome[], scanned: number, opts: RewindFixOptions, started: number, cancelled: boolean): RewindFixResult {
  return {
    launcherHasMarkers: opts.launcherHasMarkers,
    cancelled,
    scanned,
    durationMs: Date.now() - started,
    apply: opts.apply,
    sessions,
  }
}

/** Execute the repair for ONE closed session: recheck lock, backup, write, verify, clear snapshots. */
async function executeSession(
  deps: RewindFixDeps,
  header: SessionHeader,
  headerLine: string,
  repair: RepairOutput,
): Promise<SessionOutcome> {
  const base = {
    id: header.id as string,
    a: repair.stats.a,
    b: repair.stats.b,
    c: repair.stats.a + repair.stats.b + repair.stats.c,
  }

  // Safety rule (re-check right before touching disk): the user may have opened it.
  if (deps.isSessionLoaded(header.id)) {
    return { ...base, status: 'skipped', reason: 'loaded-between', error: 'loaded between scan and write' }
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
    return { ...base, status: 'failed', reason: 'locked', error: textOf(error) }
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
    await deps.clearSession(idOf(header))
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

/** Read + decode one session's event body (throw = unreadable, undefined = no artifact). */
async function readEvents(
  deps: RewindFixDeps,
  id: SessionId,
  signal?: AbortSignal,
): Promise<{ events: RepairOutput['events']; headerLine: string } | undefined> {
  const raw = await deps.readRaw(id, signal)
  if (raw === undefined) return undefined
  const { headerLine, body } = splitSession(raw.content)
  return { events: decodeEventBody(body), headerLine }
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

function idOf(header: SessionHeader): string {
  return header.id as string
}

// --- report rendering -------------------------------------------------------

/**
 * Render a {@link RewindFixResult} through the locale translator. The RESULT
 * headline is the FIRST line (so the client card's single-line collapsed
 * summary shows it), followed by the per-session detail lines (shown when the
 * card is expanded).
 */
export function renderRewindFixReport(result: RewindFixResult, render: RenderFn): string {
  const parts: string[] = []
  if (result.launcherHasMarkers) parts.push(render('rewindfix.launcherGuard'))
  parts.push(headline(result, render))
  result.sessions.forEach((outcome, i) => parts.push(...sessionLines(outcome, i + 1, result.scanned, result.apply, render)))
  return parts.join('\n')
}

function headline(result: RewindFixResult, render: RenderFn): string {
  if (result.cancelled) return render('rewindfix.cancelled')
  const repaired = result.sessions.filter(o => o.status === 'repaired').length
  const skipped = result.sessions.filter(o => o.status === 'skipped').length
  const failed = result.sessions.filter(o => o.status === 'failed').length
  const secs = (result.durationMs / 1000).toFixed(1)
  if (!result.apply) {
    return render('rewindfix.dryRun', { scan: result.scanned, will: repaired, skip: skipped, fail: failed, secs })
  }
  return render('rewindfix.done', { repair: repaired, skip: skipped, fail: failed, secs })
}

function sessionLines(outcome: SessionOutcome, index: number, total: number, apply: boolean, render: RenderFn): string[] {
  const head = `[${index}/${total}] ${outcome.id}`
  if (outcome.status === 'repaired') {
    const counts = render('rewindfix.counts', { a: outcome.a, b: outcome.b, c: outcome.c })
    if (!apply) return [`${head}  ${counts}`]
    return [`${head}  ${counts}`, `  ${render('rewindfix.writeOk')}`]
  }
  if (outcome.status === 'skipped') {
    return [`${head}  ${skipLabel(outcome, render)}`]
  }
  return [`${head}  ${failLabel(outcome, render)}`]
}

function skipLabel(outcome: SessionOutcome, render: RenderFn): string {
  switch (outcome.reason) {
    case 'no-markers': return render('rewindfix.skip.noMarkers')
    case 'no-artifact': return render('rewindfix.skip.noArtifact')
    case 'loaded-between': {
      const label = render('rewindfix.skip.loadedNow')
      return outcome.error ? `${label} ${outcome.error}` : label
    }
    case 'loaded':
    default: return render('rewindfix.skip.loaded')
  }
}

function failLabel(outcome: SessionOutcome, render: RenderFn): string {
  switch (outcome.reason) {
    case 'unreadable': return render('rewindfix.fail.unreadable', { error: outcome.error ?? '' })
    case 'repair': return render('rewindfix.fail.repair', { error: outcome.error ?? '' })
    case 'locked': return render('rewindfix.fail.locked', {
      error: `${render('rewindfix.locked')}${outcome.error ? ` (${outcome.error})` : ''}`,
    })
    default: return render('rewindfix.fail.generic', { error: outcome.error ?? '' })
  }
}
