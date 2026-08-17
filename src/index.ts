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
import type { AssistantMessage, Session } from '@deepseek-ai/dsh-session'
import type { PostToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { unlink } from 'node:fs/promises'
import { listRewindCandidates, parseRewindTarget, planRewind, RewindError, type RewindMode, type RewindPlan, type RewindTarget } from './rewind.ts'
import { execSessionCwd } from './session-cwd.ts'
import { SnapshotStore } from './snapshot.ts'

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

/** Latest `user/message` seq in the session log — the turn's anchor. */
function anchorSeqOf(session: Session): number | undefined {
  for (let i = session.events.length - 1; i >= 0; i--) {
    const event = session.events[i]!
    if (event.type === 'user/message') return event.seq
  }
  return undefined
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
  const anchorSeq = anchorSeqOf(agent.session)
  if (anchorSeq === undefined) return
  await store.recordEntry(agent.session.id, {
    callId: exec.callId,
    anchorSeq,
    path: capture.path,
    before: capture.before ?? null,
  })
}

/**
 * Build the rewind marker: an EMPTY-content assistant message. Deriving an
 * empty assistant/message to `null` (harness behavior), so the marker never
 * enters the model context and never renders as conversation content — the
 * agent and the user both see the conversation as it was at the target. The
 * marker only exists as the surface-replacement carrier in the append-only
 * log (audit).
 */
function buildMarker(): AssistantMessage {
  return createAssistantMessage({
    content: [],
    source: { provider: 'dsh-rewind', model: 'rewind-marker' },
  })
}

/** Next turn number for the marker event (past every recorded turn). */
function nextTurnOf(session: Session): number {
  let max = -1
  for (const event of session.events) {
    if (event.type === 'turn/start' || event.type === 'turn/end' || event.type === 'assistant/message') {
      if (event.data.turn > max) max = event.data.turn
    }
  }
  return max + 1
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
    lines.push('目标之后没有快照记录的写类变更，无需还原文件。')
  }
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

/** Wait until an agent reaches `idle` (a running turn stops), or the deadline/abort hits. */
async function waitForAgentIdle(agent: Agent, signal: AbortSignal, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (agent.status !== 'idle') {
    if (signal.aborted || Date.now() > deadline) return false
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return true
}

/** Execute a validated rewind: append the marker, then optionally restore files. */
async function executeRewind(
  ctx: Context,
  store: SnapshotStore,
  invocation: CommandInvocation,
  rawTarget: string,
  mode: RewindMode,
): Promise<CommandResult> {
  const { agent } = invocation
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
    event = agent.session.append('assistant/message', { turn: nextTurnOf(agent.session), step: 0, message: marker }, {
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
    const parts: string[] = []
    if (outcome.restored.length > 0) parts.push(`还原 ${outcome.restored.length} 个文件`)
    if (outcome.deleted.length > 0) parts.push(`删除 ${outcome.deleted.length} 个文件`)
    if (outcome.skipped.length > 0) parts.push(`跳过 ${outcome.skipped.length} 个符号链接`)
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
  invocation: CommandInvocation,
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
    return executeRewind(ctx, store, invocation, `@${candidates[0]!.seq}`, 'chat')
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
  return executeRewind(ctx, store, invocation, target, mode)
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

  ctx.effect(function* () {
    yield ctx.commands.register({
      name: 'rewind',
      description: '在同窗口内将对话回退到更早的用户消息（可同时还原文件）',
      handler: invocation => handleRewind(ctx, store, invocation),
    })
  }, 'dsh-rewind command')

  ctx.inject(['fs'], (scope) => {
    const fs = scope.fs
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
        await commitEntry(store, pending, exec, result)
      } catch (error) {
        ctx.logger.warn(`[dsh-rewind] checkpoint commit failed for ${exec.name}: ${error instanceof Error ? error.message : String(error)}`)
      }
      return next()
    })
  })
}
