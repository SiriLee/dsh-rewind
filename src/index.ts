/**
 * dsh-rewind host half: the v1 engine routes, the `/snapshot-auto-cleanup`
 * command and the Claude-Code-style checkpoint store, composed as one dual-face
 * bundle row (the browser half, which carries the `/rewind` and `/undo`
 * commands, lives in `src/client/`).
 *
 * Rewind mechanism: planning is pure (`src/rewind.ts`); execution appends a
 * marker `user/message` whose `surfaceOp` replaces the target and every surface
 * node after it with itself, cutting only the model-visible surface
 * (`docs/architecture.md`).
 *
 * File restore (mode `both`) follows the checkpoint model: one dense
 * `path → FileState` manifest per user message is captured at
 * `agent/pre-step` after the step is admitted, before any model call or tool
 * runs. A file first touched by `write`/`edit` after that point gets a v1 row
 * in the current manifest at the `tools/execute` around-dispatch stage (after
 * approval, before the body), so the row always holds the pre-touch state and
 * a denied call records nothing. Versions live as shared raw byte files; a
 * rewind reconciles the target manifest against the live disk and applies
 * per-file atomic replaces/deletes. The store keeps the newest 100 manifests
 * per session and survives a host restart. See `src/snapshot.ts`.
 *
 * @module dsh-rewind
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { WorkingDirectoryService } from '@deepseek-ai/dsh-working-directory'
import type {} from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { preferredLocale, translate, type HostKey, type HostLocaleId } from './locales.ts'
import { listRewindCandidates } from './rewind.ts'
import {
  CONTRACT_VERSION,
  ensureStoreSession,
  RewindEngine,
  storeSessionOf,
  targetMessageIdOf,
  waitForAgentIdle,
  type FilesCommit,
} from './engine.ts'
import { DEFAULT_MAX_FILE_BYTES, SnapshotStore, type ClearSessionReport, type PruneStaleReport, type RestoreOutcome } from './snapshot.ts'
import {
  AUTO_SWEEP_INTERVAL_MS,
  DEFAULT_CLEANUP_CONFIG,
  parseCleanupCommand,
  resolveCleanupStatePath,
  runAutoCleanupCheck,
  saveLastSweepAt,
  volatileCleanupStore,
  type CleanupConfig,
  type CleanupConfigStore,
  type CleanupConfigWriter,
  type CleanupSettings,
} from './snapshot-cleanup.ts'

export { SnapshotStore } from './snapshot.ts'
export type { Checkpoint, ClearSessionReport, FileImpact, FileState, PruneStaleReport, RestoreOutcome, SkippedPath, StoreSession } from './snapshot.ts'

export const name = 'dsh-rewind'
export const inject = ['commands', 'tools', 'settings']

/** The public engine contract's exact routes, below Connection's `/api` channel. */
const CONTRACT_HEALTH_PATH = '/api/dsh-rewind/v1/health'
const CONTRACT_PREVIEW_PATH = '/api/dsh-rewind/v1/preview'
const CONTRACT_COMMIT_PATH = '/api/dsh-rewind/v1/commit'

/** The `/rewind` picker's internal candidate read. */
const REWIND_CANDIDATES_PATH = '/api/dsh-rewind/candidates'

/** Plugin config. */
export interface RewindConfig {
  /** Checkpoint store root (exact path; beats the harness-home default). */
  readonly snapshotDir?: string
  /** Harness home override (`config.dshHome` > `$DSH_HOME` > `~/.dsh`); feeds the default snapshot/cleanup paths. */
  readonly dshHome?: string
  /** Per-file checkpoint cap in bytes; `0` disables the cap. Default {@link DEFAULT_MAX_FILE_BYTES}. */
  readonly maxFileBytes?: number
  /** Automatic snapshot-sweep cadence in ms. Default {@link AUTO_SWEEP_INTERVAL_MS}. */
  readonly autoSweepIntervalMs?: number
}

/** Who owns the action interface while a takeover claim is present. */
export type UiOwner = 'auto' | 'self'

/** The default for {@link UiOwner}: respect a third-party claim. */
export const DEFAULT_UI_OWNER: UiOwner = 'auto'

/** The default for {@link FileCheckpointingSettings.fileCheckpointingEnabled}. */
export const DEFAULT_FILE_CHECKPOINTING_ENABLED = true

/**
 * The live file-checkpointing switch (Claude Code's
 * `fileCheckpointingEnabled`): whether NEW checkpoints may be recorded.
 */
export interface FileCheckpointingSettings {
  readonly fileCheckpointingEnabled: Volatile<boolean>
}

/**
 * The plugin's full configuration: store options plus the three user-editable
 * policy fields. `.volatile()` resolves them into live references for the
 * Plugins page; the names say what they gate, because a bare `enabled` would
 * read like the entry's own `disabled:` flag.
 */
export interface Config extends RewindConfig, CleanupSettings, FileCheckpointingSettings {
  /** `auto` respects `data-dsh-rewind-claim`; `self` always keeps the native UI. */
  readonly uiOwner?: Volatile<UiOwner>
}

/** The `Config` schema the host resolves and projects as this entry's form. */
export const Config = z.object({
  snapshotDir: z.string().required(false),
  dshHome: z.string().required(false),
  maxFileBytes: z.number().step(1).min(0).default(DEFAULT_MAX_FILE_BYTES),
  autoSweepIntervalMs: z.number().step(1).min(1).default(AUTO_SWEEP_INTERVAL_MS),
  uiOwner: z.union(['auto', 'self']).default(DEFAULT_UI_OWNER).volatile(),
  fileCheckpointingEnabled: z.boolean().default(DEFAULT_FILE_CHECKPOINTING_ENABLED).volatile(),
  autoCleanupEnabled: z.boolean().default(DEFAULT_CLEANUP_CONFIG.enabled).volatile(),
  autoCleanupMaxAgeDays: z.number().step(1).min(1).default(DEFAULT_CLEANUP_CONFIG.maxAgeDays).volatile(),
})

/** Whether new checkpoints may be recorded. Absent config keeps the default (on). */
function isFileCheckpointingEnabled(config: Config | undefined): boolean {
  return config?.fileCheckpointingEnabled?.get() !== false
}

/**
 * Tool names whose mutations the checkpoint tracker follows. `str_replace_editor`
 * is not tracked: it is an optional package, not a default tool.
 */
const TRACKED_TOOLS = new Set(['write', 'edit'])

/**
 * Whether a session is a subagent child: a direct-delegation session this
 * plugin neither tracks nor rewinds. THE single predicate for every skip site —
 * checkpoint creation, first-touch capture, the agent-created load, and the
 * lazy cleanup trigger. The Harness refuses every generic
 * Session RPC for such an identity (`session/agent-busy`, "use subagent
 * delivery for this child session"), so a checkpoint recorded under a child
 * session id could never be restored by ANY rewind — parent or child — and
 * `/rewind` cannot even execute there. One predicate keeps those facts from
 * drifting apart again (SiriLee/dsh-rewind#26).
 */
function isSubagentSession(session: Session): boolean {
  const header = session.header
  return header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0
}

/**
 * Host-side locale the command output renders in. Refreshed from the durable
 * preference at mount — the command descriptions register once — and again
 * before each command renders (see `readHostLocale`); the neutral default holds
 * until a read succeeds.
 */
let activeLocale: HostLocaleId = 'en'

/** The profile entry dsh-client-locale keeps the browser preference in. */
const LOCALE_ENTRY = 'locale'

/** The preference field inside that entry's form. */
const LOCALE_FIELD = 'preference'

/**
 * Read the user's language preference through the settings service's descriptor
 * read. 0.1.7 keeps that preference in the `locale` entry's own Config rather
 * than in a registered section, and has no host-side locale service, so the
 * descriptor read is the same public route the settings UI and the client's own
 * locale runtime take.
 *
 * `redactSecrets` is requested because the descriptors span every entry. Every
 * failure — a settings service without `describe`, a mount without the locale
 * entry, a throwing read — degrades to the neutral default instead of erroring.
 *
 * @param ctx - context carrying the settings service.
 * @returns the locale this plugin's host copy renders in.
 */
function readHostLocale(ctx: Context): HostLocaleId {
  try {
    const row = ctx.settings.describe({ redactSecrets: true })
      .find(entry => entry.ns === LOCALE_ENTRY)
    return preferredLocale((row?.value as Record<string, unknown> | undefined)?.[LOCALE_FIELD])
  } catch {
    return 'en'
  }
}

/**
 * The cleanup-policy store, mounted from this plugin's resolved config plus the
 * Loader entry that owns it. `undefined` when either is absent (an entry-less
 * mount has nowhere to write), which makes the cleanup command and auto-sweep
 * fail closed (delete nothing) rather than guess.
 */
let cleanupStore: CleanupConfigStore | undefined

/** Render one host dictionary key in the active locale. */
function t(key: HostKey, params?: Record<string, string | number>): string {
  return translate(activeLocale, key, params)
}

/**
 * Report one command name this plugin could not register, without failing the
 * plugin. The host logs stay English, like every other line here.
 * @param ctx - host context carrying the logger.
 * @param name - the command name that could not be registered.
 * @param error - the error the registry raised (usually a duplicate name).
 */
function warnCommandUnavailable(ctx: Context, name: string, error: unknown): void {
  ctx.logger.warn(`[dsh-rewind] command "${name}" was not registered: ${error instanceof Error ? error.message : String(error)}`)
}

/** Extract the file path a tracked tool call mutates, or undefined. */
function mutationPathOf(exec: ToolExecution): string | undefined {
  const args = exec.arguments as { file_path?: unknown }
  if (exec.name === 'write' || exec.name === 'edit') {
    return typeof args.file_path === 'string' ? args.file_path : undefined
  }
  return undefined
}

/** True for the harness fs abort (a normal cancel, never a diagnostic). */
function isFsAbort(error: unknown): boolean {
  return (error as { readonly code?: unknown } | null)?.code === 'FS_ABORTED'
}

/**
 * Record the pre-touch state of a path the current step has not tracked yet,
 * during `tools/execute` (after approval, before the body). The store itself
 * rejects non-regular targets, hard links, over-cap files and a missing
 * current checkpoint; this function only resolves and maps the path.
 */
async function captureFirstTouch(
  ctx: Context,
  fs: FileSystem,
  workingDirectory: WorkingDirectoryService,
  store: SnapshotStore,
  exec: ToolExecution,
): Promise<void> {
  if (!TRACKED_TOOLS.has(exec.name)) return
  const agent = exec.agent
  if (agent === undefined) return
  if (isSubagentSession(agent.session)) return
  const path = mutationPathOf(exec)
  if (path === undefined) return
  const cwd = await workingDirectory.ensure(agent, exec.signal)
  let target: Awaited<ReturnType<FileSystem['resolve']>>
  try {
    target = await fs.resolve(path, { cwd, signal: exec.signal })
  } catch (error) {
    // A genuine resolution failure silently loses this path's checkpoint; a
    // cancelled run is expected and stays silent.
    if (!isFsAbort(error)) {
      ctx.logger.warn(`[dsh-rewind] first-touch resolve failed for ${path}: ${error instanceof Error ? error.message : String(error)}`)
    }
    return
  }
  // A non-local backend has no host path a node:fs restore could safely touch.
  if (fs.processPathFromHostPath(target.displayPath) === undefined) return
  await ensureStoreSession(store, agent.session, message => ctx.logger.warn(message))
  const { warnings } = await store.captureFirstTouch(agent.session.id, target.displayPath)
  for (const warning of warnings) ctx.logger.warn(`[dsh-rewind] ${warning}`)
}

/** Handler shape of the Host Connection exact Fetch registry. */
type RewindFetchHandler = (request: Request) => Promise<Response>

/** One exact Fetch route this plugin registers on `ctx.connection`. */
interface RewindFetchRoute {
  readonly path: string
  readonly methods: readonly ('GET' | 'POST')[]
  readonly requestBody: 'buffered'
  readonly fetch: RewindFetchHandler
}

/** The slice of `ctx.connection` this plugin registers on. */
interface RewindFetchHost {
  readonly fetch: { register(route: RewindFetchRoute): () => Promise<void> }
}

/** The slice of `ctx.agents` the route handlers resolve a live agent through. */
interface AgentLookup {
  get(sessionId: SessionId): Agent | undefined
}

/** True for a plain object payload. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** JSON envelope of the candidate read. */
type CandidatesResult =
  | { readonly ok: true; readonly value: { readonly candidates: unknown } }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly details: object } }

/** Build the candidate handler. */
function createCandidatesHandler(agentsOf: () => AgentLookup | undefined): RewindFetchHandler {
  return async (request) => {
    const failure = (code: string, message: string): Response => Response.json({
      ok: false,
      error: { code, message, details: {} },
    } satisfies CandidatesResult)
    try {
      if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
        return new Response('content type must be application/json', { status: 415 })
      }
      let payload: unknown
      try {
        payload = await request.json()
      } catch {
        return failure('rewind/bad-request', 'body is not JSON')
      }
      if (!isRecord(payload)) return failure('rewind/bad-request', 'invalid payload')
      const sessionId = payload['sessionId']
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        return failure('rewind/bad-request', 'sessionId must be a non-empty string')
      }
      const agents = agentsOf()
      if (agents === undefined) return failure('rewind/agents-unavailable', 'agent registry is unavailable')
      const agent = agents.get(sessionId as SessionId)
      if (agent === undefined) return failure('rewind/session-not-found', `session ${sessionId} is not attached`)
      // Full surface (the store's 100-candidate window), not the loaded chat window.
      return Response.json({
        ok: true,
        value: { candidates: listRewindCandidates(agent.session.snapshotEvents(), agent.session.surface.nodes) },
      } satisfies CandidatesResult)
    } catch (error) {
      return failure('rewind/failed', error instanceof Error ? error.message : String(error))
    }
  }
}

/** HTTP status of each stable contract failure. */
const CONTRACT_STATUS: Record<ContractErrorCode, number> = {
  'bad-request': 400,
  'session-not-found': 404,
  'target-missing': 404,
  'head-changed': 409,
  'turn-running': 409,
  'commit-in-flight': 409,
  'internal': 500,
}

/** The stable failure codes the v1 routes can return. */
type ContractErrorCode =
  | 'bad-request'
  | 'session-not-found'
  | 'target-missing'
  | 'head-changed'
  | 'turn-running'
  | 'commit-in-flight'
  | 'internal'

/** Encode one failed contract response. */
function contractFailure(code: ContractErrorCode, message: string): Response {
  return Response.json({ ok: false, error: { code, message } }, { status: CONTRACT_STATUS[code] })
}

/** Encode one successful contract response. */
function contractSuccess(value: unknown): Response {
  return Response.json({ ok: true, value })
}

/** Read a JSON-object request body, or the response refusing it. */
async function readContractPayload(request: Request): Promise<
  { readonly ok: true; readonly payload: Record<string, unknown> } | { readonly ok: false; readonly response: Response }
> {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') {
    return { ok: false, response: contractFailure('bad-request', 'content-type must be application/json') }
  }
  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return { ok: false, response: contractFailure('bad-request', 'body is not JSON') }
  }
  if (!isRecord(payload)) {
    return { ok: false, response: contractFailure('bad-request', 'body must be a JSON object') }
  }
  return { ok: true, payload }
}

/** The inputs one mounted contract adapter needs. */
interface ContractRouteDeps {
  readonly engine: RewindEngine
  readonly agents: () => AgentLookup | undefined
  /** Re-sync the observation cache after a committed file restore. */
  readonly syncFiles: (agent: Agent, files: FilesCommit | undefined) => Promise<void>
  readonly logError: (message: string) => void
}

/** Build the three exact route handlers of the public v1 contract. */
function createContractHandlers(deps: ContractRouteDeps): {
  readonly health: RewindFetchHandler
  readonly preview: RewindFetchHandler
  readonly commit: RewindFetchHandler
} {
  /** Resolve one payload's session to its live agent, or the contract failure. */
  const agentOf = (payload: Record<string, unknown>): Agent | Response => {
    const sessionId = payload['sessionId']
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return contractFailure('bad-request', 'sessionId must be a non-empty string')
    }
    const agents = deps.agents()
    if (agents === undefined) {
      deps.logError('[dsh-rewind] the agent registry is unavailable')
      return contractFailure('internal', 'the agent registry is unavailable')
    }
    const agent = agents.get(sessionId as SessionId)
    if (agent === undefined) {
      return contractFailure('session-not-found', `session ${sessionId} is not attached`)
    }
    return agent
  }

  const health: RewindFetchHandler = async () => contractSuccess({ contract: CONTRACT_VERSION })

  const preview: RewindFetchHandler = async (request) => {
    const parsed = await readContractPayload(request)
    if (!parsed.ok) return parsed.response
    const agent = agentOf(parsed.payload)
    if (agent instanceof Response) return agent
    const seq = parsed.payload['seq']
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq)) {
      return contractFailure('bad-request', 'seq must be an integer')
    }
    const result = await deps.engine.preview({ session: agent.session, seq })
    if (!result.ok) {
      if (result.code === 'internal') deps.logError(`[dsh-rewind] preview failed: ${result.message}`)
      return contractFailure(result.code, result.message)
    }
    const { headSeq, withdraw, files } = result.value
    return contractSuccess({
      headSeq,
      withdraw,
      files: files.available
        ? { available: true, changes: files.changes, skipped: files.skipped }
        : { available: false, reason: files.reason },
    })
  }

  const commit: RewindFetchHandler = async (request) => {
    const parsed = await readContractPayload(request)
    if (!parsed.ok) return parsed.response
    const agent = agentOf(parsed.payload)
    if (agent instanceof Response) return agent
    const seq = parsed.payload['seq']
    const headSeq = parsed.payload['headSeq']
    const mode = parsed.payload['mode']
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq)) {
      return contractFailure('bad-request', 'seq must be an integer')
    }
    if (typeof headSeq !== 'number' || !Number.isSafeInteger(headSeq)) {
      return contractFailure('bad-request', 'headSeq must be an integer')
    }
    if (mode !== 'conversation' && mode !== 'files' && mode !== 'both') {
      return contractFailure('bad-request', 'mode must be conversation, files or both')
    }
    const result = await deps.engine.commit({ agent, seq, headSeq, mode })
    if (!result.ok) {
      if (result.code === 'internal') deps.logError(`[dsh-rewind] commit failed: ${result.message}`)
      return contractFailure(result.code, result.message)
    }
    await deps.syncFiles(agent, result.value.files)
    const value: Record<string, unknown> = {}
    if (result.value.conversation !== undefined) value['conversation'] = result.value.conversation
    const files = result.value.files
    if (files !== undefined) {
      value['files'] = files.applied
        ? {
          applied: true,
          restored: files.restored,
          deleted: files.deleted,
          skipped: files.skipped,
          failed: files.failed,
        }
        : { applied: false, reason: files.reason }
    }
    return contractSuccess(value)
  }

  /** Convert an unexpected adapter fault into the contract's `internal`. */
  const guard = (handler: RewindFetchHandler): RewindFetchHandler => async (request) => {
    try {
      return await handler(request)
    } catch (error) {
      deps.logError(`[dsh-rewind] contract route failed: ${error instanceof Error ? error.message : String(error)}`)
      return contractFailure('internal', 'internal error')
    }
  }
  return { health: guard(health), preview: guard(preview), commit: guard(commit) }
}

/**
 * Resolve a restored/deleted display path back into an fs target, or
 * undefined on resolution failure (the sync then skips the file silently).
 */
async function resolveObservationTarget(
  fs: FileSystem,
  path: string,
): Promise<Awaited<ReturnType<FileSystem['resolve']>> | undefined> {
  try {
    return await fs.resolve(path)
  } catch {
    return undefined
  }
}

/**
 * Re-sync the harness fs-observation-policy's per-session observation cache
 * after a both-mode restore. The restore writes/deletes through plain
 * `node:fs`, which the policy layer cannot see — that is about the
 * observation cache, not permission enforcement (the restore still touches
 * only the checkpoint plan's path set). Without this sync, the same
 * session's next write of a restored or rewind-deleted file is judged against
 * the STALE pre-restore observation (the file still "present" at its old
 * version), so the write tool's intent becomes `replaceIfVersion` and
 * `fs-local` refuses the now-missing file with `FS_STALE_VERSION` ("file no
 * longer exists — re-read the file, then retry") — even though the agent is
 * legitimately creating a fresh file after the rewind.
 *
 * Emitting authoritative observations on the same public `fs/observed` event
 * the read/write tools emit tells the policy layer the truth it cannot learn
 * otherwise: deleted files become `{ kind: 'absent' }` (next write uses
 * `createIfAbsent`); restored files become `{ kind: 'present', version }`
 * from a fresh stat (next write CASes against the current version and
 * succeeds). The safety model is unchanged: a LATER external modification
 * after this sync still trips the stale guard exactly as before — only the
 * inconsistency CREATED BY THE RESTORE ITSELF is healed.
 *
 * Per-file failures are silent no-ops: without fs, or when resolve/stat
 * fails, the pre-existing behavior (the write tool's remediated stale error
 * with its re-read hint) remains the fallback.
 *
 * @param ctx - context carrying the `fs/observed` event bus.
 * @param fs - the fs service, or undefined when the deployment has none.
 * @param agent - the rewound agent; its session is the observation owner.
 * @param outcome - the restore outcome (deleted/restored paths to sync).
 */
async function syncRestoreObservations(
  ctx: Context,
  fs: FileSystem | undefined,
  agent: Agent,
  outcome: RestoreOutcome,
): Promise<void> {
  if (fs === undefined) return
  const actor = { agent }
  for (const path of outcome.deleted) {
    const target = await resolveObservationTarget(fs, path)
    if (target === undefined) continue
    ctx.emit('fs/observed', target, { kind: 'absent' }, actor)
  }
  for (const path of outcome.restored) {
    const target = await resolveObservationTarget(fs, path)
    if (target === undefined) continue
    const info = await fs.stat(target).catch(() => undefined)
    if (info === undefined) continue
    ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, actor)
  }
}

/**
 * Re-sync the harness fs-observation policy after a committed file restore. The
 * restore writes through plain `node:fs`, invisible to the observation layer
 * (see `syncRestoreObservations`); an unavailable fs service degrades to a no-op.
 */
async function syncCommittedFiles(
  ctx: Context,
  fs: FileSystem | undefined,
  agent: Agent,
  files: FilesCommit | undefined,
): Promise<void> {
  if (files?.applied !== true) return
  await syncRestoreObservations(ctx, fs, agent, {
    restored: [...files.restored],
    deleted: [...files.deleted],
    skipped: [],
    failed: [],
    noCheckpoint: false,
  })
}

/** Whether THIS MOUNT already ran its one-shot auto-cleanup check. */
let autoSweepChecked = false

/**
 * One-shot lazy auto-cleanup gate. The FIRST session activity of a mount (a
 * user message or a tool result) performs a single check: it reads the policy
 * and the persisted last-sweep time and, only when enabled AND the configured
 * cadence has elapsed, runs the sweep and re-anchors the window on disk. After
 * that one check the mount stops considering auto-cleanup (a mount reads the
 * policy at most once), while the cadence survives a restart because the
 * last-sweep time is persisted rather than kept in memory. Runs in the
 * background (voided by callers) and NEVER rejects: an invalid config
 * fail-closes (deletes nothing) and logs, and a prune failure logs — neither
 * blocks the activity that triggered it. The active `sessionId` is the one
 * directory that must never be pruned.
 *
 * The gate is re-armed by every `apply` (see the reset there), so a live
 * disable → enable round trip checks again instead of inheriting the previous
 * mount's "already checked" flag.
 * @param signal - the mount's lifecycle signal; an aborted mount writes nothing.
 */
async function maybeRunAutoCleanup(
  ctx: Context,
  store: SnapshotStore,
  sessionId: string | undefined,
  dshHome: string | undefined,
  sweepIntervalMs: number | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (autoSweepChecked || signal?.aborted === true) return
  autoSweepChecked = true
  try {
    await runAutoCleanupCheck({
      pruner: store,
      readConfig: () => readCleanupPolicy(),
      statePath: resolveCleanupStatePath(dshHome),
      log: msg => ctx.logger.warn(msg),
      ...(sweepIntervalMs === undefined ? {} : { intervalMs: sweepIntervalMs }),
      ...(signal === undefined ? {} : { signal }),
    }, sessionId)
  } catch (error) {
    // The helper is contracted never to reject; this covers the one remaining
    // path — a logger on an already-disposed context — so an unload can never
    // surface as an unhandled rejection.
    try {
      ctx.logger.warn(`[dsh-rewind] snapshot auto-cleanup failed: ${error instanceof Error ? error.message : String(error)}`)
    } catch {
      // The context is disposed and its logger is gone: nothing left to report.
    }
  }
}

/**
 * Read the resolved cleanup policy from the config-backed store. Without a
 * resolved config (a mount without the Loader, so nowhere to write) the read
 * fails closed: an error, deleting nothing.
 */
async function readCleanupPolicy(): Promise<{ ok: true; config: CleanupConfig } | { ok: false; error: string }> {
  if (cleanupStore === undefined) {
    return { ok: false, error: 'cleanup policy unavailable; snapshot cleanup policy cannot be read' }
  }
  return { ok: true, config: cleanupStore.load() }
}

/** Persist a validated cleanup policy through the config-backed store. */
async function writeCleanupPolicy(next: CleanupConfig): Promise<void> {
  if (cleanupStore === undefined) throw new Error('cleanup policy unavailable; snapshot cleanup policy cannot be written')
  await cleanupStore.save(next)
}

/** Render a {@link PruneStaleReport} for the `run` sub-command (dry vs apply). */
function formatCleanupReport(report: PruneStaleReport): string {
  const key: HostKey = report.dryRun ? 'cleanup.runDry' : 'cleanup.runApply'
  const text = t(key, {
    deleted: report.deleted,
    freed: report.freedBytes,
    kept: report.kept,
    remaining: report.remainingBytes,
  })
  return report.skippedActive > 0 ? `${text}\n${t('cleanup.skipped', { skipped: report.skippedActive })}` : text
}

/**
 * Handle one `/snapshot-auto-cleanup` invocation: view or configure the
 * persistent cleanup policy, or run the sweep now. All writes go through the
 * validated save, so the config file is never left invalid; a read of an
 * invalid file fail-closes the sweep (and reports on `status`/`run`).
 */
async function handleSnapshotCleanup(
  store: SnapshotStore,
  invocation: CommandInvocation,
  dshHome: string | undefined,
): Promise<CommandResult> {
  const parsed = parseCleanupCommand(invocation.rawInput)
  if ('error' in parsed) return { kind: 'error', text: t('cleanup.usage') }
  switch (parsed.action) {
    case 'status': {
      const loaded = await readCleanupPolicy()
      if (!loaded.ok) return { kind: 'error', text: t('cleanup.cfgInvalid', { detail: loaded.error }) }
      return {
        kind: 'success',
        text: t('cleanup.status', {
          state: t(loaded.config.enabled ? 'cleanup.enabled' : 'cleanup.disabled'),
          days: loaded.config.maxAgeDays,
        }),
      }
    }
    case 'on':
    case 'off': {
      const loaded = await readCleanupPolicy()
      const next: CleanupConfig = { ...(loaded.ok ? loaded.config : DEFAULT_CLEANUP_CONFIG), enabled: parsed.action === 'on' }
      try {
        await writeCleanupPolicy(next)
      } catch (error) {
        return { kind: 'error', text: t('cleanup.saveFailed', { detail: error instanceof Error ? error.message : String(error) }) }
      }
      return { kind: 'success', text: t(parsed.action === 'on' ? 'cleanup.onOk' : 'cleanup.offOk') }
    }
    case 'max-age': {
      const loaded = await readCleanupPolicy()
      const next: CleanupConfig = { ...(loaded.ok ? loaded.config : DEFAULT_CLEANUP_CONFIG), maxAgeDays: parsed.value! }
      try {
        await writeCleanupPolicy(next)
      } catch (error) {
        return { kind: 'error', text: t('cleanup.saveFailed', { detail: error instanceof Error ? error.message : String(error) }) }
      }
      return { kind: 'success', text: t('cleanup.maxAgeOk', { days: parsed.value! }) }
    }
    case 'run': {
      const apply = parsed.apply
      // `--current` re-targets the manual action to the ACTIVE session's
      // snapshots (the "clear this session now" path); without it, `run` keeps
      // its age-based stale-session sweep semantics.
      if (parsed.target === 'current') {
        return handleClearCurrent(store, invocation, apply)
      }
      const loaded = await readCleanupPolicy()
      if (!loaded.ok) return { kind: 'error', text: t('cleanup.cfgInvalid', { detail: loaded.error }) }
      try {
        const report = await store.pruneStale({
          keepActiveId: invocation.agent.session.id,
          maxAgeDays: loaded.config.maxAgeDays,
          dryRun: !apply,
        })
        // A real (non dry-run) sweep also re-anchors the 24h window, so the
        // automatic sweep does not immediately re-run after a manual one.
        if (!report.dryRun) await saveLastSweepAt(resolveCleanupStatePath(dshHome), Date.now())
        return { kind: 'success', text: formatCleanupReport(report) }
      } catch (error) {
        return { kind: 'error', text: t('cleanup.runFailed', { detail: error instanceof Error ? error.message : String(error) }) }
      }
    }
  }
}

/** Render a {@link ClearSessionReport} for the current-session clear (dry vs apply). */
function formatClearReport(report: ClearSessionReport): string {
  const key: HostKey = report.dryRun ? 'cleanup.clearDry' : 'cleanup.clearApply'
  return t(key, {
    entries: report.entries,
    bytes: report.bytes,
  })
}

/**
 * Handle the `run --current` manual clear of the ACTIVE session. Without
 * `--apply` it is a dry-run preview (disk and memory untouched); with it, the
 * session's entire checkpoint directory is deleted and the in-memory state is
 * reset, so the next admitted step starts from an empty tracked set.
 *
 * The `--apply` mutation must only run once the session is STOPPED: a running
 * turn (the LLM thinking/outputting/editing, actively driving write tools)
 * would otherwise let a concurrent first-touch write interleave with this
 * directory `rm`. Mirroring `rewind`, we ACTIVELY pause the running turn —
 * cancel it and wait for quiescence — before clearing; if it cannot stop, we
 * error (`stopFailed`) and never clear, so the plugin is never left corrupted.
 * `agent.status` reads `idle` during a maintenance phase, so a mere status read
 * is not enough — the `whenIdle` race is required, exactly as in
 * `executeRewind`.
 *
 * Clearing is an explicit abandonment of this session's checkpoint archive.
 * The memory reset is part of `clearSession`; it is what keeps the next
 * checkpoint and restore correct afterwards.
 */
async function handleClearCurrent(
  store: SnapshotStore,
  invocation: CommandInvocation,
  apply: boolean,
): Promise<CommandResult> {
  const { agent } = invocation
  const sessionId = agent.session.id
  // Only the apply (mutation) path needs quiescence: a dry-run is a pure read.
  if (apply) {
    if (agent.status !== 'idle') {
      agent.cancel({ kind: 'user' }, { keepInbox: true })
      const stopped = await waitForAgentIdle(agent, invocation.signal)
      if (!stopped) {
        return { kind: 'error', text: t('cleanup.clearActive', { sessionId }) }
      }
    }
    if (invocation.signal.aborted) {
      return { kind: 'error', text: t('cleanup.clearCancelled') }
    }
  }
  try {
    const report = await store.clearSession(sessionId, { dryRun: !apply })
    return { kind: 'success', text: formatClearReport(report) }
  } catch (error) {
    return { kind: 'error', text: t('cleanup.clearFailed', { detail: error instanceof Error ? error.message : String(error), sessionId }) }
  }
}


/** The Loader's nested-include id prefix, between this fiber and its profile row. */
const INCLUDE_ENTRY_PREFIX = 'include:'

/** This fiber's own Loader entry id, when the mount has one (a bare `apply` does not). */
function rewindConfigKey(ctx: Context): string | undefined {
  return (ctx as { fiber?: { entry?: { id?: string } } }).fiber?.entry?.id
}

/**
 * The settings entry id this plugin's configuration is addressed by: the PROFILE
 * ROW id from the bundle's patch, not this fiber's nested include id. The loader
 * mounts a bundle's rows under an `include:` scope, so the fiber id carries that
 * prefix while the configuration editor keys entries and profile patches by the
 * bare row id.
 * @param entryId - this fiber's Loader entry id, when it has one.
 * @returns the configuration key, or undefined without an entry.
 */
export function profileEntryKey(entryId: string | undefined): string | undefined {
  if (entryId === undefined) return undefined
  return entryId.startsWith(INCLUDE_ENTRY_PREFIX) ? entryId.slice(INCLUDE_ENTRY_PREFIX.length) : entryId
}


/**
 * Register `/snapshot-auto-cleanup` and the checkpoint pipeline: dense manifests
 * at `agent/pre-step` and first-touch rows at `tools/execute`.
 *
 * The cleanup command is fs-independent and registers immediately. The
 * checkpoint pipeline mounts through a dynamic
 * `ctx.inject(['fs', 'workingDirectory'])`:
 * it takes effect whenever those services become available and never fails the
 * plugin's load in a deployment without them (without fs, no checkpoints are
 * recorded and `both` restores report no checkpoint).
 *
 * The pre-step listener is prepended so it observes the final decision after
 * every other listener, then `await next()`; a rejected step creates nothing.
 * Capture runs in `tools/execute` (the around-dispatch stage), NOT in
 * `tools/pre-execute`: a pre-execute `{ kind: 'ask' }` short-circuit from
 * another plugin (e.g. dsh-edit-approval) skips later pre-execute listeners,
 * and a denied call never dispatches — so approved calls are still captured,
 * denied calls record nothing.
 *
 * @param ctx - context carrying `commands`, `tools`, and an optional `fs`.
 * @param config - resolved plugin config: the store options (`snapshotDir`,
 *  `dshHome`, `maxFileBytes`) plus the live policy
 *  (`fileCheckpointingEnabled`, cleanup `enabled`/`maxAgeDays`).
 */
export function apply(ctx: Context, config?: Config): void {
  // Fresh per-mount host state: these live at module scope because module-level
  // helpers read them without a ctx thread, and a fired one-shot sweep gate or
  // the previous mount's policy store would otherwise survive a live
  // disable → enable round trip. The locale is re-read here rather than reset,
  // so the command descriptions registered below carry the user's language.
  activeLocale = readHostLocale(ctx)
  cleanupStore = undefined
  autoSweepChecked = false
  // Cancels this mount's in-flight background work when the fiber disposes: the
  // live plugin manager can unload the plugin at any moment, and neither async
  // listener body may keep writing to disk or reading a disposed service.
  const lifecycle = new AbortController()
  ctx.effect(() => () => { lifecycle.abort() }, 'dsh-rewind lifecycle abort')

  // Own config card, so opt out of the schema-generated page (`autoGenerate`).
  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber), 'dsh-rewind page policy')
  })

  const dshHome = config?.dshHome
  const store = new SnapshotStore(config?.snapshotDir, {
    dshHome,
    maxFileBytes: config?.maxFileBytes,
  })
  // The cleanup policy reads the config's live references, so a settings write
  // is visible here without a remount; writes go through the settings service's
  // entry API, which is the only owner of the document and addresses entries by
  // their PROFILE ROW id (`dsh-rewind-plugin`), not by this fiber's nested
  // include id (`include:dsh-rewind-plugin`). `settings` is a declared inject,
  // so the service is reachable as `ctx.settings`; without a resolved config or
  // a Loader entry there is nowhere to write, and the policy stays fail-closed
  // (reads report "unavailable", a sweep deletes nothing).
  const configKey = profileEntryKey(rewindConfigKey(ctx))
  if (config !== undefined && configKey !== undefined) {
    const writer: CleanupConfigWriter = {
      entryId: configKey,
      update: (id, patch) => ctx.settings.update(id, patch),
      clear: (id, fields) => ctx.settings.mutate(id, fields.map(field => ({ op: 'unset' as const, path: [field] }))),
    }
    cleanupStore = volatileCleanupStore(config, writer)
  }
  // Host-internal engine: one commit per session, shared by the command and the
  // public contract; the live checkpoint policy is read per operation.
  const engine = new RewindEngine({
    store,
    checkpointingEnabled: () => isFileCheckpointingEnabled(config),
    log: message => ctx.logger.warn(message),
  })
  // The fs service, captured from the dynamic `ctx.inject(['fs'])` scope and
  // handed to the v1 commit route for the post-restore observation sync.
  // Undefined until the service mounts (or in fs-less deployments): the sync
  // then degrades to a no-op and the pre-existing stale-error fallback stays.
  let fsService: FileSystem | undefined

  ctx.effect(function* () {
    /**
     * Refresh the host language, then run the handler: a command result is the
     * surface the user reads, and the preference can change without a remount.
     */
    const withHostLocale = (
      handler: (invocation: CommandInvocation) => Promise<CommandResult>,
    ): ((invocation: CommandInvocation) => Promise<CommandResult>) =>
      (invocation) => {
        activeLocale = readHostLocale(ctx)
        return handler(invocation)
      }
    // Each registration is isolated so a name another plugin owns costs only
    // that name (issue #49). Cordis rolls a failed effect back, so one
    // unguarded throw would also take the checkpoint pipeline below down.
    try {
      yield ctx.commands.register({
        name: 'snapshot-auto-cleanup',
        description: t('cleanup.description'),
        input: { hint: t('cleanup.inputHint') },
        handler: withHostLocale(invocation => handleSnapshotCleanup(store, invocation, dshHome)),
      })
    } catch (error) {
      warnCommandUnavailable(ctx, 'snapshot-auto-cleanup', error)
    }
  }, 'dsh-rewind command')

  // Load the session's checkpoint store before queued work runs. This is where
  // the store reconciles meta, drops orphans/corrupt manifests, retains the
  // newest window and GCs; a store from a newer build is marked unavailable
  // (conversation rewind still works). Subagent sessions are skipped: their
  // edits are not tracked and a rewind cannot execute there.
  ctx.on('agent/created', async ({ agent }: { agent: Agent }) => {
    const session = agent.session
    if (isSubagentSession(session)) return
    try {
      if (lifecycle.signal.aborted) return
      const { warnings } = await store.loadSession(storeSessionOf(session), { force: true })
      for (const warning of warnings) ctx.logger.warn(`[dsh-rewind] ${warning}`)
    } catch (error) {
      ctx.logger.warn(`[dsh-rewind] checkpoint store load failed for ${session.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }, { global: true })

  // Pre-step is the message boundary: after `next()` so a rejected step or a
  // later listener's rewrite is honored, before `step()` appends the user
  // messages and before any model/tool work. `prepend` makes this the
  // outermost listener, so the decision is final. The boundary only needs the
  // store, so it is registered globally: a missing or remounted fs service
  // cannot silently stop checkpoint creation.
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next()
    if (decision.kind !== 'enter' || lifecycle.signal.aborted) return decision
    const session = agent.session
    if (isSubagentSession(session)) return decision
    // Subagents returned above; only a real session may claim the sweep's
    // active-session exemption.
    void maybeRunAutoCleanup(ctx, store, session.id, dshHome, config?.autoSweepIntervalMs, lifecycle.signal)
    try {
      if (!isFileCheckpointingEnabled(config)) {
        // The off period is a coverage gap: the previous message's manifest
        // must not receive first-touch rows after the switch flips back on.
        await store.abandonCurrent(session.id).catch(() => undefined)
        return decision
      }
      if (engine.isCommitting(session.id)) return decision
      await ensureStoreSession(store, session, message => ctx.logger.warn(message))
      const batch: string[] = []
      const seen = new Set<string>()
      for (const message of decision.messages) {
        if (message.source.kind !== 'user' || seen.has(message.id)) continue
        seen.add(message.id)
        batch.push(message.id)
      }
      if (batch.length === 0) return decision
      const { warnings } = await store.createCheckpoints(session.id, session.header.version, batch)
      for (const warning of warnings) ctx.logger.warn(`[dsh-rewind] ${warning}`)
    } catch (error) {
      // A checkpoint failure must not consume the user's message. Drop the
      // current reference so this turn's later first touches are skipped, and
      // let the next admitted step retry from the same tracked set.
      await store.abandonCurrent(agent.session.id).catch(() => undefined)
      ctx.logger.warn(`[dsh-rewind] checkpoint creation failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    return decision
  }, { prepend: true, global: true })

  // Read-only queries travel over exact `/api` routes; the Fetch registry does
  // not read `webServer` from Connection's own context. See audit U10.
  ctx.inject(['connection'], (scope) => {
    const connection = (scope as unknown as { readonly connection?: RewindFetchHost }).connection
    if (connection === undefined) return
    const agentsOf = (): AgentLookup | undefined => scope.get('agents') as AgentLookup | undefined
    /** Register one exact route; a failure costs only that route. */
    const registerRoute = (path: string, methods: readonly ('GET' | 'POST')[], handler: RewindFetchHandler): void => {
      try {
        scope.effect(() => connection.fetch.register({
          path,
          methods,
          requestBody: 'buffered',
          fetch: handler,
        }), `dsh-rewind ${path} route`)
      } catch (error) {
        ctx.logger.error(`[dsh-rewind] route registration failed for ${path}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    // The public engine contract. It is the same code path the command drives.
    const contract = createContractHandlers({
      engine,
      agents: agentsOf,
      syncFiles: (agent, files) => syncCommittedFiles(ctx, fsService, agent, files),
      logError: message => ctx.logger.error(message),
    })
    registerRoute(CONTRACT_HEALTH_PATH, ['GET'], contract.health)
    registerRoute(CONTRACT_PREVIEW_PATH, ['POST'], contract.preview)
    registerRoute(CONTRACT_COMMIT_PATH, ['POST'], contract.commit)
    // Internal picker read: the full host surface, not the contract.
    registerRoute(REWIND_CANDIDATES_PATH, ['POST'], createCandidatesHandler(agentsOf))
  })

  ctx.inject(['fs', 'workingDirectory'], (scope) => {
    const fs = scope.fs
    const workingDirectory = scope.workingDirectory
    // Expose the fs service to the v1 commit route (restore observation sync).
    // Undefined before the service mounts: the sync then degrades to a no-op.
    fsService = fs
    // The scope disposes with either service: drop the captured reference so the
    // command path can never hand a released instance to the observation sync.
    scope.effect(() => () => { fsService = undefined }, 'dsh-rewind fs capture')

    scope.on('tools/execute', async (exec: ToolExecution, next): Promise<ToolExecutionResult> => {
      if (lifecycle.signal.aborted) return next()
      const session = exec.agent?.session
      if (session !== undefined && !isSubagentSession(session)) {
        void maybeRunAutoCleanup(ctx, store, session.id, dshHome, config?.autoSweepIntervalMs, lifecycle.signal)
      }
      try {
        if (!isFileCheckpointingEnabled(config)) {
          if (session !== undefined && !isSubagentSession(session)) {
            await store.abandonCurrent(session.id).catch(() => undefined)
          }
        } else {
          await captureFirstTouch(ctx, fs, workingDirectory, store, exec)
        }
      } catch (error) {
        ctx.logger.warn(`[dsh-rewind] first-touch capture failed for ${exec.name}: ${error instanceof Error ? error.message : String(error)}`)
      }
      return next()
    })
  })
}
