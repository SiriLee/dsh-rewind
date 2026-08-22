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
import { listRewindCandidates, markerTurnOf, parseRewindTarget, planRewind, RewindError, type RewindMode, type RewindPlan, type RewindTarget } from './rewind.ts'
import { execSessionCwd } from './session-cwd.ts'
import { reconcileTracked, SnapshotStore, type RestoreOutcome } from './snapshot.ts'

export { SnapshotStore } from './snapshot.ts'
export type { CheckpointEntry, FileImpact, RestoreOutcome } from './snapshot.ts'

export const name = 'dsh-rewind'
export const inject = ['commands', 'tools']

/** Plugin config: optional override of the checkpoint store root. */
export interface RewindConfig {
  /** Checkpoint store root (defaults to `~/.dsh/rewind-snapshots`). */
  readonly snapshotDir?: string
}

/** Tool names whose mutations the checkpoint tracker follows. */
const TRACKED_TOOLS = new Set(['write', 'edit', 'str_replace_editor'])

/** str_replace_editor commands that mutate the filesystem. */
const MUTATING_EDITOR_COMMANDS = new Set(['create', 'str_replace', 'insert'])

const USAGE = [
  'Usage:',
  '  /rewind                       （无参数）撤回最近一条用户消息',
  '  /rewind @<seq> chat|both      回退到指定消息（chat 仅对话 / both 对话+文件）',
  '  手动输入 /rewind 会被拦截，请使用消息旁的「回退」按钮',
].join('\n')

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
    ? `seq ${target.seq}`
    : `第 ${target.index} 条消息`
}

/** Render an impact list for `preview` and the `both` confirmation. */
function formatPlan(plan: RewindPlan, files: readonly { path: string; action: 'restore' | 'delete' }[]): string {
  const lines = [
    `将回退到 seq ${plan.targetSeq}，从模型上下文移除 ${plan.shadowedSeqs.length} 个节点（对话日志保留）。`,
  ]
  if (files.length > 0) {
    lines.push(`将影响 ${files.length} 个文件：`)
    for (const file of files) {
      lines.push(`  ${file.action === 'restore' ? '还原' : '删除'} ${file.path}`)
    }
  } else {
    lines.push('目标之后没有需要还原的变更。')
  }
  // Machine-readable trailer (stable literal, locale-independent): the client
  // parses `impact=<n>` to decide whether the code-restore mode is available
  // and strips the line before showing the text — never the human copy above.
  lines.push(`impact=${files.length}`)
  return lines.join('\n')
}

/** Resolve a raw target token into a plan, mapping failures to messages. */
function resolveOrError(events: Session['events'], surface: Session['surface']['nodes'], raw: string): RewindPlan {
  const target = parseRewindTarget(raw)
  if (target === undefined) {
    throw new RewindError('invalid-index', `无法解析目标 "${raw}"（应为 <序号> 或 @<seq>）`)
  }
  return planRewind(events, surface, target)
}

/** One failed file restore, rendered for the result text. */
function renderFailures(failed: readonly { path: string; message: string }[]): string {
  if (failed.length === 0) return ''
  return `；${failed.length} 个文件还原失败：${failed.map(f => `${f.path}（${f.message}）`).join('、')}`
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
    return { kind: 'error', text: '该会话已有一个回退正在执行，请稍候。' }
  }
  inflight.add(sessionId)
  try {
    // A running turn (the LLM is thinking or streaming) must be stopped before
    // the surface can be cut: force-cancel it (user cause), wait for quiescence,
    // then rewind. Queued/steering inbox items are discarded with the turn.
    if (agent.status !== 'idle') {
      agent.cancel({ kind: 'user' })
      const stopped = await waitForAgentIdle(agent, invocation.signal)
      if (!stopped) {
        return { kind: 'error', text: '无法停止运行中的 agent，回退已取消。请稍后再试。' }
      }
    }
    // The command was cancelled (or its caller aborted) while we waited for
    // quiescence: stop here instead of executing a rewind nobody asked for.
    if (invocation.signal.aborted) {
      return { kind: 'error', text: '回退已取消。' }
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
      event = agent.session.append('assistant/message', { turn: markerTurnOf(agent.session.events), step: 0, message: marker }, {
        surfaceOp: { op: 'replace', start: plan.surfaceStart, end: plan.surfaceEnd },
        sourceEventSeqs: [...plan.shadowedSeqs],
      })
    } catch (error) {
      return {
        kind: 'error',
        text: `回退失败：${error instanceof Error ? error.message : String(error)}。会话未改变。`,
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
      if (outcome.restored.length > 0) parts.push(`还原 ${outcome.restored.length} 个文件`)
      if (outcome.deleted.length > 0) parts.push(`删除 ${outcome.deleted.length} 个文件`)
      if (outcome.skipped.length > 0) parts.push(`跳过 ${outcome.skipped.length} 个链接`)
      restore = parts.length > 0 ? `；${parts.join('、')}` : '；目标之后没有可还原的写类变更'
      restore += renderFailures(outcome.failed)
    }

    // Every rewind withdraws the target message and everything after it; its
    // content is offered back in the composer for re-sending.
    return {
      kind: 'success',
      text: `已撤回 seq ${plan.targetSeq} 及之后内容（对话已回到此前）${restore}。`,
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
      'no-user-messages': '当前会话还没有可回退的用户消息。',
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
    // Manual `/rewind` input is blocked entirely in the client composer guard
    // (see src/client/index.ts): the command exists as the per-message ↶
    // button's internal channel, which always drives this host path with an
    // explicit `@seq` target. The bare form below is a defensive fallback for
    // non-composer callers: it withdraws the most recent user message
    // (time-travel back one turn; the text is offered back in the composer).
    const candidates = listRewindCandidates(session.events, session.surface.nodes, 1)
    if (candidates.length === 0) {
      return { kind: 'error', text: '当前会话还没有可回退的用户消息。' }
    }
    return executeRewind(ctx, store, fs, invocation, `@${candidates[0]!.seq}`, 'chat', inflight)
  }

  const parts = input.split(/\s+/)
  if (parts[0] === 'preview') {
    const target = parts[1]
    if (target === undefined) return { kind: 'error', text: USAGE }
    let plan: RewindPlan
    try {
      plan = resolveOrError(session.events, session.surface.nodes, target)
    } catch (error) {
      return rewindErrorResult(error)
    }
    const impacts = await store.impactsAfter(session.id, plan.targetSeq)
    return { kind: 'success', text: formatPlan(plan, impacts) }
  }

  const target = parts[0]!
  const mode = parts[1]
  if (mode !== undefined && mode !== 'chat' && mode !== 'both') {
    return { kind: 'error', text: USAGE }
  }
  if (mode === undefined) {
    const parsed = parseRewindTarget(target)
    if (parsed === undefined) return { kind: 'error', text: USAGE }
    return {
      kind: 'success',
      text: `将回退到 ${describeTarget(parsed)}。选择模式：\n  /rewind ${target} chat  仅回退对话\n  /rewind ${target} both  回退对话并还原文件`,
    }
  }
  return executeRewind(ctx, store, fs, invocation, target, mode, inflight)
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
 * @param config - optional override of the checkpoint store root.
 */
export function apply(ctx: Context, config?: RewindConfig): void {
  const store = new SnapshotStore(config?.snapshotDir)
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
  // Per-session last-seen file states (path → content, null = absent) for
  // the boundary re-check. Empty after a restart: the first boundary then
  // unconditionally records the current state (redundant but correct).
  const statesBySession = new Map<string, Map<string, string | null>>()
  // The fs service, captured from the dynamic `ctx.inject(['fs'])` scope and
  // handed to the command path for the post-restore observation sync.
  // Undefined until the service mounts (or in fs-less deployments): the sync
  // then degrades to a no-op and the pre-existing stale-error fallback stays.
  let fsService: FileSystem | undefined

  ctx.effect(function* () {
    yield ctx.commands.register({
      name: 'rewind',
      description: '在同窗口内将对话回退到更早的用户消息（可同时还原文件）',
      handler: invocation => handleRewind(ctx, store, fsService, invocation, inflight),
    })
  }, 'dsh-rewind command')

  // User-message boundary re-check (Claude Code's fileHistoryMakeSnapshot
  // analog): every time a user/message lands in a session log, re-read every
  // tracked file of that session and record a before-backup for any whose
  // on-disk state changed since it was last seen (including EXTERNAL edits
  // and deletions the write-class capture never saw). The entry is anchored
  // at the boundary message, so a later rewind to this message restores the
  // file to this exact state — and a rewind to an earlier message restores
  // an earlier entry. Subagent sessions are skipped (their edits are not
  // tracked, matching captureBefore). Runs async off the append hot path;
  // failures are logged, never blocking the message.
  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (event.type !== 'user/message') return
    const header = session.header
    if (header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0) return
    void (async () => {
      try {
        const sessionId = session.id
        let tracked = trackedBySession.get(sessionId)
        if (tracked === undefined) {
          tracked = await store.trackedPaths(sessionId)
          trackedBySession.set(sessionId, tracked)
        }
        if (tracked.size === 0) return
        let states = statesBySession.get(sessionId)
        if (states === undefined) {
          states = new Map()
          statesBySession.set(sessionId, states)
        }
        await reconcileTracked(store, sessionId, event.seq, tracked, states)
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
