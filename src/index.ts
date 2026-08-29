/**
 * dsh-rewind host half: the `/rewind` command and the Claude-Code-style
 * checkpoint store, composed as one dual-face bundle row (the browser half
 * lives in `src/client/`).
 *
 * Rewind mechanism: planning is pure (`src/rewind.ts`); execution appends a
 * marker `assistant/message` into the session log whose `surfaceOp` replaces
 * every surface node after the target message with the marker. The
 * append-only log (and the rendered transcript) is untouched — only the
 * model-visible surface is cut, so the next request derives its context from
 * the target onward.
 *
 * File restore (mode `both`) follows Claude Code's checkpointing: the plugin
 * backs up each tracked write-class edit BEFORE it happens (at the
 * `tools/execute` around-dispatch stage, so an approval short-circuit cannot
 * skip the capture and a denied call never records), commits the backup under
 * the turn's anchor message seq at `tools/post-execute`, and a rewind to
 * message N restores every backup anchored at or after N — modified files are
 * written back to their pre-edit content, files created after N are deleted.
 * Backups persist on disk under the dsh data directory (newest 100 message
 * groups per session), so restores work after a host restart, and they
 * read/write the real file system with plain `node:fs` — independent of the
 * fs service. See `src/snapshot.ts`.
 *
 * @module dsh-rewind
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { FileSystem, FsTarget } from '@deepseek-ai/dsh-fs'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import type { AssistantMessage, Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { PostToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { unlink } from 'node:fs/promises'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { translate, type HostKey, type HostLocaleId } from './locales.ts'
import { formatCandidateList, listRewindCandidates, markerStepOf, markerTurnOf, parseRewindTarget, planRewind, RewindError, type RewindMode, type RewindPlan, type RewindTarget } from './rewind.ts'
import { execSessionCwd } from './session-cwd.ts'
import { reconcileTracked, SnapshotStore, type ClearSessionReport, type PruneStaleReport, type RestoreOutcome } from './snapshot.ts'
import {
  DEFAULT_CLEANUP_CONFIG,
  loadCleanupConfig,
  parseCleanupCommand,
  resolveCleanupConfigPath,
  resolveCleanupStatePath,
  runAutoCleanupCheck,
  saveCleanupConfig,
  saveLastSweepAt,
  type CleanupConfig,
} from './snapshot-cleanup.ts'

export { SnapshotStore } from './snapshot.ts'
export type { CheckpointEntry, FileImpact, PruneStaleReport, RestoreOutcome, RestoreJournal, RestoreJournalState, RestoreReconcileReport } from './snapshot.ts'

export const name = 'dsh-rewind'
export const inject = ['commands', 'tools']

/** Plugin config. */
export interface RewindConfig {
  /** Checkpoint store root (exact path; beats `DSH_REWIND_SNAPSHOT_DIR` and the harness-home default). */
  readonly snapshotDir?: string
  /** Harness home override (`config.dshHome` > `$DSH_HOME` > `~/.dsh`); feeds the default snapshot/cleanup paths. */
  readonly dshHome?: string
  /** In-place content dedup (identical before-content → link). Default `true`. */
  readonly dedup?: boolean
}

/** Tool names whose mutations the checkpoint tracker follows. */
const TRACKED_TOOLS = new Set(['write', 'edit', 'str_replace_editor'])

/** str_replace_editor commands that mutate the filesystem. */
const MUTATING_EDITOR_COMMANDS = new Set(['create', 'str_replace', 'insert'])

/** Host-side locale the command output renders in; updated from settings at apply time. */
let activeLocale: HostLocaleId = 'en'

/** Render one host dictionary key in the active locale. */
function t(key: HostKey, params?: Record<string, string | number>): string {
  return translate(activeLocale, key, params)
}

/** Render the `/rewind` usage block in the active locale. */
function usage(): string {
  return [
    t('usage.title'),
    t('usage.noArgs'),
    t('usage.seq'),
    t('usage.blocked'),
  ].join('\n')
}

/** Before-state captured for one in-flight tool call, keyed by agent+callId. */
interface PendingCapture {
  /** Resolved display path (absolute) of the file the call will mutate. */
  readonly path: string
  /** Full content before the change; undefined when the file does not exist (a creation). */
  readonly before: string | undefined
}

/** Extract the file path a tracked tool call mutates, or undefined. */
function mutationPathOf(exec: ToolExecution): string | undefined {
  const args = exec.arguments as { file_path?: unknown; path?: unknown; command?: unknown }
  if (exec.name === 'write' || exec.name === 'edit') {
    return typeof args.file_path === 'string' ? args.file_path : undefined
  }
  if (exec.name === 'str_replace_editor') {
    if (typeof args.command !== 'string' || !MUTATING_EDITOR_COMMANDS.has(args.command)) return undefined
    return typeof args.path === 'string' ? args.path : undefined
  }
  return undefined
}

/** One cached anchor computation for a session. */
interface AnchorCacheEntry {
  /** Anchor seq as of `eventsLength` events. */
  readonly anchor: number | undefined
  /** Number of events the anchor was computed against. */
  readonly eventsLength: number
}

/**
 * Latest `user/message` seq in the session log — the turn's anchor.
 *
 * Incremental: a cached anchor is reused until a NEW user/message lands. Tool
 * and assistant events appended between two tool results move the log tail but
 * never the anchor, so only the events since the last computation are scanned —
 * amortized O(1) per commit instead of a full backward walk every time.
 *
 * Keyed by the Session OBJECT (WeakMap): a session id is a branded string that
 * an exotic lifecycle could reuse, and a stale `eventsLength`-match against a
 * recycled id would hand back another session's anchor.
 */
function anchorSeqOf(session: Session, cache: WeakMap<Session, AnchorCacheEntry>): number | undefined {
  const events = session.events
  const cached = cache.get(session)
  if (cached !== undefined && cached.eventsLength === events.length) return cached.anchor
  let anchor: number | undefined = cached?.anchor
  for (let i = events.length - 1; i >= (cached?.eventsLength ?? 0); i--) {
    if (events[i]!.type === 'user/message') {
      anchor = events[i]!.seq
      break
    }
  }
  cache.set(session, { anchor, eventsLength: events.length })
  return anchor
}

/** Resolve a path against the session cwd (fs-tools rule), or undefined on resolution failure. */
async function resolveTarget(
  fs: FileSystem,
  path: string,
  cwd: string | undefined,
  signal?: AbortSignal,
): Promise<Awaited<ReturnType<FileSystem['resolve']>> | undefined> {
  try {
    return await fs.resolve(path, {
      ...cwd !== undefined ? { cwd } : {},
      signal,
    })
  } catch {
    return undefined
  }
}

/** Read a target's full text, or undefined when the file is absent. */
async function readTextOrUndefined(fs: FileSystem, target: FsTarget, signal?: AbortSignal): Promise<string | undefined> {
  try {
    return await fs.readText(target, signal)
  } catch (error) {
    const code = (error as { code?: string })?.code
    if (code === 'ENOENT' || code === 'FS_NOT_FOUND') return undefined
    throw error
  }
}

/**
 * Capture the before-state of a tracked mutation during `tools/execute` (the
 * around-dispatch wrapper): the file still holds the old content, and this
 * stage only runs after any pre-execute approval gate allowed the call — so a
 * `{ kind: 'ask' }` short-circuit from another plugin (e.g. dsh-edit-approval)
 * cannot skip the capture, and a denied call never captures (no pending leak).
 * The recorded path is the RESOLVED display path, so restores always name the
 * real file regardless of how the model spelled it.
 */
async function captureBefore(
  fs: FileSystem,
  exec: ToolExecution,
  pending: Map<string, PendingCapture>,
): Promise<void> {
  if (!TRACKED_TOOLS.has(exec.name)) return
  // Claude Code alignment: subagent edits are NOT tracked (official
  // checkpointing limitation). A subagent runs its own session, so a backup
  // recorded under the subagent session id could never be restored by a
  // rewind of the parent session — it would only leak on disk (the subagent
  // log is short, so the per-session 100-group prune never fires for it).
  // Skipping the capture here mirrors Claude Code's behavior exactly.
  const header = exec.agent?.session.header
  if (header !== undefined && (header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0)) return
  const path = mutationPathOf(exec)
  if (path === undefined) return
  const cwd = execSessionCwd(exec, path)
  const target = await resolveTarget(fs, path, cwd, exec.signal)
  if (target === undefined) return
  const before = await readTextOrUndefined(fs, target, exec.signal)
  pending.set(`${exec.agent?.id ?? 'anon'}:${exec.callId}`, { path: target.displayPath, before })
}

/**
 * Commit one tracked mutation during `tools/post-execute`: resolve the turn
 * anchor and write the before-backup to the checkpoint store. Failed calls
 * never commit (the pending capture is dropped).
 */
async function commitEntry(
  store: SnapshotStore,
  pending: Map<string, PendingCapture>,
  anchorCache: WeakMap<Session, AnchorCacheEntry>,
  trackedBySession: Map<string, Set<string>>,
  exec: ToolExecution,
  result: ToolExecutionResult,
): Promise<void> {
  const key = `${exec.agent?.id ?? 'anon'}:${exec.callId}`
  const capture = pending.get(key)
  if (capture === undefined) return
  pending.delete(key)
  if (result.isError) return
  const agent = exec.agent
  if (agent === undefined) return
  const anchorSeq = anchorSeqOf(agent.session, anchorCache)
  if (anchorSeq === undefined) return
  await store.recordEntry(agent.session.id, {
    callId: exec.callId,
    anchorSeq,
    path: capture.path,
    before: capture.before ?? null,
  })
  // The path is now a tracked file: remember it for the boundary re-check
  // (the per-session set may not have been loaded yet — seed it lazily).
  let tracked = trackedBySession.get(agent.session.id)
  if (tracked === undefined) {
    tracked = new Set()
    trackedBySession.set(agent.session.id, tracked)
  }
  tracked.add(capture.path)
}

/**
 * Build the rewind marker: an EMPTY-content assistant message. Deriving an
 * empty assistant/message to `null` (harness behavior), so the marker never
 * enters the model context and never renders as conversation content — the
 * agent and the user both see the conversation as it was at the target. The
 * marker only exists as the surface-replacement carrier in the append-only
 * log (audit).
 *
 * The marker's turn comes from `markerTurnOf` — the LAST STARTED turn, never
 * `lastTurn + 1`: the harness numbers its next real turn exactly `lastTurn
 * turn/start + 1`, so a `maxTurn + 1` marker collides with the following
 * `turn/start` and breaks history replay (see `markerTurnOf`).
 *
 * The marker is appended inside a GHOST STEP frame (`step/start` …
 * `step/end` with the marker between them, step number from `markerStepOf`):
 * the harness token-meter replays the log and rejects any `assistant/message`
 * that does not sit inside an open step of the same `(turn, step)` — a bare
 * marker (appended while idle, every step already closed) would make every
 * later measure() throw, silently disabling /compact and automatic
 * compaction. See `markerStepOf` for why the step number must be fresh.
 */
function buildMarker(): AssistantMessage {
  return createAssistantMessage({
    content: [],
    source: { provider: 'dsh-rewind', model: 'rewind-marker' },
  })
}

/** Render a parsed target for the step-2 hint. */
function describeTarget(target: RewindTarget): string {
  return target.kind === 'seq'
    ? t('describeTarget.seq', { seq: target.seq })
    : t('describeTarget.index', { index: target.index })
}

/**
 * Render an impact list for `preview` and the `both` confirmation. The human
 * copy follows the active host locale; the trailing block is a
 * locale-independent machine channel the client parses to render its own
 * localized popover and to decide both-mode availability:
 *   `impact=<n>`        → number of files affected
 *   `restore:<path>`    → one file to restore
 *   `delete:<path>`     → one file to delete
 * The client MUST render from these tokens, never from the human copy.
 */
function formatPlan(plan: RewindPlan, files: readonly { path: string; action: 'restore' | 'delete' }[]): string {
  const lines = [
    t('plan.rewinding', { targetSeq: plan.targetSeq, count: plan.shadowedSeqs.length }),
  ]
  if (files.length > 0) {
    lines.push(t('plan.affects', { count: files.length }))
    for (const file of files) {
      lines.push(`  ${file.action === 'restore' ? t('plan.restore', { path: file.path }) : t('plan.delete', { path: file.path })}`)
    }
  } else {
    lines.push(t('plan.noChanges'))
  }
  // Machine-readable trailer (stable literal, locale-independent): the client
  // parses `impact=<n>` and the restore:/delete: lines to render its own
  // localized copy — never the human lines above.
  lines.push(`impact=${files.length}`)
  for (const file of files) {
    lines.push(`${file.action}:${file.path}`)
  }
  return lines.join('\n')
}

/** Resolve a raw target token into a plan, mapping failures to messages. */
function resolveOrError(events: Session['events'], surface: Session['surface']['nodes'], raw: string): RewindPlan {
  const target = parseRewindTarget(raw)
  if (target === undefined) {
    throw new RewindError('invalid-index', t('error.invalidTarget', { raw }))
  }
  return planRewind(events, surface, target)
}

/** One failed file restore, rendered for the result text. */
function renderFailures(failed: readonly { path: string; message: string }[]): string {
  if (failed.length === 0) return ''
  return t('failures.suffix', {
    count: failed.length,
    list: failed.map(f => t('failures.item', { path: f.path, message: f.message })).join('、'),
  })
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
 * `node:fs`, which the policy layer cannot see; without this sync, the same
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
    const info = await fs.stat(target)
    if (info === undefined) continue
    ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, actor)
  }
}

/**
 * Wait until an agent reaches `idle` (a running turn stops), or the
 * deadline/abort hits. Uses the agent's own `whenIdle()` — the loop's
 * activity promise — instead of polling `status` every 50ms. The agent's
 * status reads `idle` during a `maintenance` phase too, so we ALWAYS race
 * `whenIdle()` (which follows the activity promise, maintenance included)
 * rather than short-circuiting on the status: its concurrent session writes
 * would otherwise race the rewind's append.
 */
async function waitForAgentIdle(agent: Agent, signal: AbortSignal, timeoutMs = 15_000): Promise<boolean> {
  if (signal.aborted) return false
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  try {
    await Promise.race([
      agent.whenIdle(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('rewind idle wait timed out')), timeoutMs)
        onAbort = () => reject(new Error('rewind idle wait aborted'))
        signal.addEventListener('abort', onAbort, { once: true })
      }),
    ])
    return true
  } catch {
    return false
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
  }
}

/** Sessions with a rewind currently executing (per-session in-flight guard). */
type InflightRewinds = Set<string>

/**
 * Drop every pending steering (next-step) inbox message. Used when a rewind
 * rolls the conversation back to a point before them: they belong to the
 * future being cut, and keeping them would deliver them first on the next
 * send. Queued (next-turn) messages are deliberately NOT touched — the
 * harness QueueDock already offers the user per-item edit/remove.
 */
function dropPendingSteering(agent: Agent): void {
  for (const message of [...agent.inbox.nextStep]) {
    agent.inbox.remove(message.id)
  }
}

/** Execute a validated rewind: append the marker, then optionally restore files. */
async function executeRewind(
  ctx: Context,
  store: SnapshotStore,
  fs: FileSystem | undefined,
  invocation: CommandInvocation,
  rawTarget: string,
  mode: RewindMode,
  inflight: InflightRewinds,
): Promise<CommandResult> {
  const { agent } = invocation
  const sessionId = agent.session.id
  // Per-session in-flight guard: two concurrent rewinds (double-click, a
  // second tab) would both plan against the same surface; the second append's
  // replace range would then target nodes the first marker already shadowed,
  // and `Session.append` rejects with "start seq not found in surface".
  if (inflight.has(sessionId)) {
    return { kind: 'error', text: t('inflight') }
  }
  inflight.add(sessionId)
  try {
    // A running turn (the LLM is thinking or streaming) must be stopped before
    // the surface can be cut: force-cancel it (user cause), wait for quiescence,
    // then rewind. The inbox is KEPT by the cancel (keepInbox) — only the
    // pending steering (next-step) messages are dropped below: they belong to
    // the future being rolled back. Queued (next-turn) messages are left
    // untouched: the harness QueueDock already offers per-item edit/remove, so
    // a rewind must not silently drop messages the user may still want to send.
    if (agent.status !== 'idle') {
      agent.cancel({ kind: 'user' }, { keepInbox: true })
      const stopped = await waitForAgentIdle(agent, invocation.signal)
      if (!stopped) {
        return { kind: 'error', text: t('stopFailed') }
      }
    }
    // Idle or not, rewinding to a point before them must not keep pending
    // steering messages alive to be delivered first on the next send.
    dropPendingSteering(agent)
    // The command was cancelled (or its caller aborted) while we waited for
    // quiescence: stop here instead of executing a rewind nobody asked for.
    if (invocation.signal.aborted) {
      return { kind: 'error', text: t('cancelled') }
    }
    let plan: RewindPlan
    try {
      plan = resolveOrError(agent.session.events, agent.session.surface.nodes, rawTarget)
    } catch (error) {
      return rewindErrorResult(error)
    }

    const marker = buildMarker()
    let event: ReturnType<Session['append']>
    try {
      // The marker is an EMPTY assistant/message: it derives to null in the
      // model context and renders nothing, so the surface simply ends before
      // the withdrawn messages — agent and user both see the conversation as
      // it was before the target.
      //
      // It is wrapped in a ghost step frame (`step/start` … `step/end`, fresh
      // step number) so the harness token-meter replay accepts the marker:
      // token-meter requires every `assistant/message` to sit inside an open
      // step of the same (turn, step), and the marker is appended while idle
      // (every real step already closed). Without the frame, the first
      // measure() after the rewind throws "no matching step/start event" and
      // /compact (and automatic compaction) stay broken for the session.
      const turn = markerTurnOf(agent.session.events)
      const step = markerStepOf(agent.session.events, turn)
      agent.session.append('step/start', { turn, step })
      try {
        event = agent.session.append('assistant/message', { turn, step, message: marker }, {
          surfaceOp: { op: 'replace', start: plan.surfaceStart, end: plan.surfaceEnd },
          sourceEventSeqs: [...plan.shadowedSeqs],
        })
      } catch (error) {
        // The step/start above already committed; close the ghost step so the
        // log never carries a dangling open step (a later token-meter replay
        // would reject the first step/end it sees). Only the surface-replace
        // append can fail here (range validation); step/end itself cannot.
        agent.session.append('step/end', { turn, step })
        throw error
      }
      agent.session.append('step/end', { turn, step })
    } catch (error) {
      return {
        kind: 'error',
        text: t('failed', { error: error instanceof Error ? error.message : String(error) }),
      }
    }

    let restore = ''
    if (mode === 'both') {
      const outcome = await store.restoreAfter(agent.session.id, plan.targetSeq, path => unlink(path))
      // The restore wrote through plain node:fs, invisible to the harness
      // observation policy: re-sync it so the session's next write of a
      // restored/deleted file is not judged against the stale pre-restore
      // observation (see syncRestoreObservations).
      await syncRestoreObservations(ctx, fs, agent, outcome)
      const parts: string[] = []
      if (outcome.restored.length > 0) parts.push(t('restore.count', { count: outcome.restored.length }))
      if (outcome.deleted.length > 0) parts.push(t('delete.count', { count: outcome.deleted.length }))
      if (outcome.skipped.length > 0) parts.push(t('skip.count', { count: outcome.skipped.length }))
      restore = parts.length > 0 ? `；${parts.join('、')}` : t('noRestorable')
      restore += renderFailures(outcome.failed)
    }

    // Every rewind withdraws the target message and everything after it; its
    // content is offered back in the composer for re-sending.
    return {
      kind: 'success',
      text: t('success', { targetSeq: plan.targetSeq, restore }),
      sourceEventSeq: event.seq,
    }
  } finally {
    inflight.delete(sessionId)
  }
}

/** Map a typed rewind failure to a command error result. */
function rewindErrorResult(error: unknown): CommandResult {
  if (error instanceof RewindError) {
    const text = {
      'no-user-messages': t('noUserMessages'),
      'invalid-index': error.message,
      'not-a-user-message': error.message,
      'not-on-surface': error.message,
    }[error.code]
    return { kind: 'error', text }
  }
  throw error
}

/** Handle one `/rewind` invocation (two-step text flow + direct execution). */
async function handleRewind(
  ctx: Context,
  store: SnapshotStore,
  fs: FileSystem | undefined,
  invocation: CommandInvocation,
  inflight: InflightRewinds,
): Promise<CommandResult> {
  const session = invocation.agent.session
  const input = invocation.rawInput.trim()

  if (input === '') {
    // A bare `/rewind` in the composer is taken by the client's command
    // decoration (see src/client/index.ts), which opens the candidate picker
    // instead of running this host path; the button likewise drives this
    // parameterized path with an explicit `@seq` target. The bare form below
    // is a defensive fallback for non-composer callers: it withdraws the most
    // recent user message (time-travel back one turn; the text is offered
    // back in the composer).
    const candidates = listRewindCandidates(session.events, session.surface.nodes, 1)
    if (candidates.length === 0) {
      return { kind: 'error', text: t('noUserMessages') }
    }
    return executeRewind(ctx, store, fs, invocation, `@${candidates[0]!.seq}`, 'chat', inflight)
  }

  const parts = input.split(/\s+/)
  if (parts[0] === 'preview') {
    const target = parts[1]
    if (target === undefined) return { kind: 'error', text: usage() }
    let plan: RewindPlan
    try {
      plan = resolveOrError(session.events, session.surface.nodes, target)
    } catch (error) {
      return rewindErrorResult(error)
    }
    const impacts = await store.impactsAfter(session.id, plan.targetSeq)
    return { kind: 'success', text: formatPlan(plan, impacts) }
  }

  // Internal machine channel: `/rewind __candidates` returns the FULL
  // candidate list (host surface + full event log) so the client popupSelect
  // can render every reachable rewind target — not just the already-loaded
  // history window. Side-effect free: no event is appended, nothing rewound.
  if (parts[0] === '__candidates') {
    const candidates = listRewindCandidates(session.events, session.surface.nodes)
    return { kind: 'success', text: formatCandidateList(candidates) }
  }

  const target = parts[0]!
  const mode = parts[1]
  if (mode !== undefined && mode !== 'chat' && mode !== 'both') {
    return { kind: 'error', text: usage() }
  }
  if (mode === undefined) {
    const parsed = parseRewindTarget(target)
    if (parsed === undefined) return { kind: 'error', text: usage() }
    return {
      kind: 'success',
      text: t('chooseMode', { target: describeTarget(parsed) }),
    }
  }
  return executeRewind(ctx, store, fs, invocation, target, mode, inflight)
}

/**
 * Lazy 24h auto-cleanup gate. Called on the first session activity of a
 * window (a user message or a tool result). The 24h window is anchored on a
 * PERSISTED last-sweep timestamp (read from `~/.dsh/snapshot-cleanup-last-sweep.json`
 * and written back on each run), so a host restart does NOT reset it — a real
 * deployment is rarely up 24/7, so an in-memory timestamp would re-sweep on
 * every boot. Runs in the background (voided by callers) and NEVER rejects: a
 * config error fail-closes (deletes nothing) and logs, and a prune failure
 * logs — neither blocks the activity that triggered it. The active
 * `sessionId` is the one directory that must never be pruned; an undefined
 * value (no session in scope) still honors the throttle and just skips no
 * directory.
 */
/** Whether this process already ran its one-shot auto-cleanup check. */
let autoSweepChecked = false

/**
 * One-shot lazy auto-cleanup gate. The FIRST session activity of a run (a user
 * message or a tool result) performs a single check: it reads the policy and the
 * persisted last-sweep time and, only when enabled AND >=24h since the last
 * sweep, runs the sweep and re-anchors the 24h window on disk. After that one
 * check the process stops considering auto-cleanup (a short-lived run reads the
 * policy at most once), while the 24h cadence survives a restart because the
 * last-sweep time is persisted rather than kept in memory. Runs in the
 * background (voided by callers) and NEVER rejects: an invalid config
 * fail-closes (deletes nothing) and logs, and a prune failure logs — neither
 * blocks the activity that triggered it. The active `sessionId` is the one
 * directory that must never be pruned.
 */
async function maybeRunAutoCleanup(ctx: Context, store: SnapshotStore, sessionId: string | undefined, dshHome?: string): Promise<void> {
  if (autoSweepChecked) return
  autoSweepChecked = true
  await runAutoCleanupCheck({
    pruner: store,
    configPath: resolveCleanupConfigPath(dshHome),
    statePath: resolveCleanupStatePath(dshHome),
    log: msg => ctx.logger.warn(msg),
  }, sessionId)
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
  trackedBySession: Map<string, Set<string>>,
): Promise<CommandResult> {
  const parsed = parseCleanupCommand(invocation.rawInput)
  if ('error' in parsed) return { kind: 'error', text: t('cleanup.usage') }
  const configPath = resolveCleanupConfigPath(dshHome)
  switch (parsed.action) {
    case 'status': {
      const loaded = await loadCleanupConfig(configPath)
      if (!loaded.ok) return { kind: 'error', text: t('cleanup.cfgInvalid', { detail: loaded.error }) }
      return {
        kind: 'success',
        text: t('cleanup.status', {
          state: t(loaded.config.enabled ? 'cleanup.enabled' : 'cleanup.disabled'),
          days: loaded.config.maxAgeDays,
          path: configPath,
          present: t(loaded.fromFile ? 'cleanup.present' : 'cleanup.absent'),
        }),
      }
    }
    case 'on':
    case 'off': {
      const loaded = await loadCleanupConfig(configPath)
      const next: CleanupConfig = { ...(loaded.ok ? loaded.config : DEFAULT_CLEANUP_CONFIG), enabled: parsed.action === 'on' }
      try {
        await saveCleanupConfig(configPath, next)
      } catch (error) {
        return { kind: 'error', text: t('cleanup.saveFailed', { detail: error instanceof Error ? error.message : String(error) }) }
      }
      return { kind: 'success', text: t(parsed.action === 'on' ? 'cleanup.onOk' : 'cleanup.offOk') }
    }
    case 'max-age': {
      const loaded = await loadCleanupConfig(configPath)
      const next: CleanupConfig = { ...(loaded.ok ? loaded.config : DEFAULT_CLEANUP_CONFIG), maxAgeDays: parsed.value! }
      try {
        await saveCleanupConfig(configPath, next)
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
        return handleClearCurrent(store, invocation, apply, trackedBySession)
      }
      const loaded = await loadCleanupConfig(configPath)
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
 * session's entire snapshot directory is deleted and the in-memory tracked set
 * dropped, so the next user-message boundary re-derives an empty tracked set
 * instead of re-scanning every formerly-tracked file (the lag relief).
 *
 * The `--apply` mutation must only run once the session is STOPPED: a running
 * turn (the LLM thinking/outputting/editing, actively driving write tools)
 * would otherwise let a concurrent `recordEntry` at `tools/post-execute`
 * interleave with this directory `rm` and the in-memory dedup reset, leaving a
 * dangling dedup link (restore resolution then fails per-file). Mirroring
 * `rewind`, we ACTIVELY pause the running turn — cancel it and wait for
 * quiescence — before clearing; if it cannot stop, we error (`stopFailed`) and
 * never clear, so the plugin is never left corrupted. `agent.status` reads
 * `idle` during a maintenance phase and the boundary re-check is fire-and-forget,
 * so a mere status read is not enough — the `whenIdle` race is required, exactly
 * as in `executeRewind`.
 *
 * Clearing is an explicit abandonment of this session's snapshot archive, so it
 * is not gated on any restore-journal state (a clear and a restore never
 * interleave; any non-terminal journal found is a stale orphan from a previous
 * process). The memory reset is the part that must never be skipped — it is
 * what keeps restore resolution and the boundary re-check correct afterwards.
 */
async function handleClearCurrent(
  store: SnapshotStore,
  invocation: CommandInvocation,
  apply: boolean,
  trackedBySession: Map<string, Set<string>>,
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
    if (!report.dryRun) trackedBySession.delete(sessionId)
    return { kind: 'success', text: formatClearReport(report) }
  } catch (error) {
    return { kind: 'error', text: t('cleanup.clearFailed', { detail: error instanceof Error ? error.message : String(error), sessionId }) }
  }
}


/**
 * Register the `/rewind` command and the checkpoint pipeline (before-capture
 * at `tools/execute`, disk commit at `tools/post-execute`).
 *
 * The command is fs-independent and registers immediately. The checkpoint
 * pipeline needs `fs` to resolve tracked paths to their real display paths,
 * so it mounts through a dynamic `ctx.inject(['fs'])` — it takes effect
 * whenever the fs service becomes available (and never fails the plugin's
 * load when a deployment has no fs; without it, no entries are recorded and
 * `both` restores report "no tracked changes").
 *
 * Capture runs in `tools/execute` (the around-dispatch stage), NOT in
 * `tools/pre-execute`: a pre-execute `{ kind: 'ask' }` short-circuit from
 * another plugin (e.g. dsh-edit-approval) skips later pre-execute listeners,
 * and a denied call never dispatches — so approved calls are still captured,
 * denied calls never leave a pending entry behind. Entries are committed to
 * disk at `tools/post-execute` under the turn's anchor message seq.
 *
 * @param ctx - context carrying `commands`, `tools`, and an optional `fs`.
 * @param config - optional plugin config: `snapshotDir` (exact store-root override),
 *  `dshHome` (harness-home override feeding the default paths), `dedup`.
 */
export function apply(ctx: Context, config?: RewindConfig): void {
  const dshHome = config?.dshHome
  const store = new SnapshotStore(config?.snapshotDir, { dedup: config?.dedup, dshHome })
  // Pending before-captures keyed by agent id + callId (callIds are unique,
  // but scoping by agent makes cross-session collisions impossible).
  const pending = new Map<string, PendingCapture>()
  // Incremental turn-anchor cache, keyed by the Session object (see
  // anchorSeqOf).
  const anchorCache = new WeakMap<Session, AnchorCacheEntry>()
  // Sessions with a rewind currently executing (per-session in-flight guard).
  const inflight: InflightRewinds = new Set()
  // Per-session tracked path sets (seeded lazily from the snapshot store; a
  // path joins as soon as a write-class tool commits an entry for it). Used
  // by the user-message boundary re-check below.
  const trackedBySession = new Map<string, Set<string>>()
  // The fs service, captured from the dynamic `ctx.inject(['fs'])` scope and
  // handed to the command path for the post-restore observation sync.
  // Undefined until the service mounts (or in fs-less deployments): the sync
  // then degrades to a no-op and the pre-existing stale-error fallback stays.
  let fsService: FileSystem | undefined

  // Resolve the durable locale preference (registered by dsh-client-locale's
  // host half) and keep the command output following it. Settings is optional
  // and injected dynamically like fs: an absent service (or a preference that
  // was never set) leaves the default English — the ecosystem's neutral
  // fallback — without failing the plugin load.
  ctx.inject(['settings'], (settingsCtx) => {
    const section = settingsCtx.settings.get(settingsNamespace('locale')) as
      | { preference?: HostLocaleId }
      | undefined
    if (section?.preference === 'zh' || section?.preference === 'en') {
      activeLocale = section.preference
    }
  })

  ctx.effect(function* () {
    // One handler serves both `/rewind` and its alias `/undo`.
    const rewindHandler = (invocation: CommandInvocation): Promise<CommandResult> =>
      handleRewind(ctx, store, fsService, invocation, inflight)
    yield ctx.commands.register({
      name: 'rewind',
      description: t('command.description'),
      handler: rewindHandler,
    })
    yield ctx.commands.register({
      name: 'undo',
      description: t('command.description'),
      handler: rewindHandler,
    })
    yield ctx.commands.register({
      name: 'snapshot-auto-cleanup',
      description: t('cleanup.description'),
      input: { hint: t('cleanup.inputHint') },
      handler: invocation => handleSnapshotCleanup(store, invocation, dshHome, trackedBySession),
    })
  }, 'dsh-rewind command')

  // User-message boundary re-check (Claude Code's fileHistoryMakeSnapshot
  // analog): every time a user/message lands in a session log, re-read every
  // tracked file of that session and record a before-backup for any whose
  // on-disk state changed since it was last recorded (including EXTERNAL
  // edits and deletions the write-class capture never saw). The change test
  // uses the store's single last-known-state source, so only CHANGED files
  // are recorded (a full snapshot; unchanged ones stay in memory, no per-
  // message dedup file). The entry is anchored at the boundary message, so a
  // later rewind to this message restores the file to this exact state — and
  // a rewind to an earlier message restores an earlier entry. Subagent
  // sessions are skipped (their edits are not tracked, matching captureBefore).
  // Runs async off the append hot path; failures are logged, never blocking
  // the message.
  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (event.type !== 'user/message') return
    const header = session.header
    if (header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0) return
    void (async () => {
      try {
        const sessionId = session.id
        // Lazy 24h auto-cleanup: a user message is the practical first trigger
        // of a day; it runs in the background and fail-closes on config error.
        void maybeRunAutoCleanup(ctx, store, sessionId, dshHome)
        let tracked = trackedBySession.get(sessionId)
        if (tracked === undefined) {
          tracked = await store.trackedPaths(sessionId)
          trackedBySession.set(sessionId, tracked)
        }
        if (tracked.size === 0) return
        await reconcileTracked(store, sessionId, event.seq, tracked)
      } catch (error) {
        ctx.logger.warn(`[dsh-rewind] boundary re-check failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    })()
  }, { global: true })

  ctx.inject(['fs'], (scope) => {
    const fs = scope.fs
    // Expose the fs service to the command path (restore observation sync).
    // Undefined before the service mounts: the sync then degrades to a no-op.
    fsService = fs
    scope.on('tools/execute', async (exec: ToolExecution, next): Promise<ToolExecutionResult> => {
      try {
        await captureBefore(fs, exec, pending)
      } catch (error) {
        ctx.logger.warn(`[dsh-rewind] before-capture failed for ${exec.name}: ${error instanceof Error ? error.message : String(error)}`)
      }
      return next()
    })

    scope.on('tools/post-execute', async (exec: ToolExecution, result: ToolExecutionResult, next): Promise<PostToolDecision> => {
      try {
        // Lazy 24h auto-cleanup: a tool result is the fallback trigger (covers
        // LLM work that never landed a user/message); the session id is the
        // directory that must never be pruned.
        void maybeRunAutoCleanup(ctx, store, exec.agent?.session?.id, dshHome)
        await commitEntry(store, pending, anchorCache, trackedBySession, exec, result)
      } catch (error) {
        ctx.logger.warn(`[dsh-rewind] checkpoint commit failed for ${exec.name}: ${error instanceof Error ? error.message : String(error)}`)
      }
      return next()
    })

    scope.on('tools/result', (exec: ToolExecution): undefined => {
      // A THROW inside the `tools/execute` waterfall — from another wrapper,
      // not from the tool body (`dispatchToolBody` catches body errors and
      // still produces a post-result, so the body path keeps post-execute) —
      // short-circuits the registry's catch straight to `final-result`,
      // skipping `tools/post-execute`; its before-capture would otherwise leak
      // in `pending` forever (holding a full file content in memory).
      // `tools/result` fires on BOTH the normal and the throw path: delete
      // here as the safety net (a no-op when commitEntry already consumed it).
      pending.delete(`${exec.agent?.id ?? 'anon'}:${exec.callId}`)
      return undefined
    })
  })
}
