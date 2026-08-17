/**
 * dsh-rewind host half: the `/rewind` command and the write-class change
 * ledger, composed as one dual-face bundle row (the browser half lives in
 * `src/client/`).
 *
 * Rewind mechanism: planning is pure (`src/rewind.ts`); execution appends a
 * marker `user/message` into the session log whose `surfaceOp` replaces every
 * surface node after the target message with the marker. The append-only log
 * (and the rendered transcript) is untouched — only the model-visible surface
 * is cut, so the next request derives its context from the target onward.
 * Mode `both` additionally reverses every ledger-recorded file change that
 * followed the target.
 *
 * @module dsh-rewind
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'
import type {
  PostToolDecision, PreToolDecision, ToolExecution, ToolExecutionResult,
} from '@deepseek-ai/dsh-tools'
import { unlink } from 'node:fs/promises'
import { RewindLedger } from './ledger.ts'
import {
  formatCandidate, listRewindCandidates, parseRewindTarget, planRewind,
  RewindError, type RewindMode, type RewindPlan, type RewindTarget,
} from './rewind.ts'

export const name = 'dsh-rewind'
export const inject = ['commands', 'tools']

/** Tool names whose mutations the ledger records. */
const TRACKED_TOOLS = new Set(['write', 'edit', 'str_replace_editor'])

/** str_replace_editor commands that mutate the filesystem. */
const MUTATING_EDITOR_COMMANDS = new Set(['create', 'str_replace', 'insert'])

/** Before-state captured for one in-flight tool call, keyed by callId. */
interface PendingCapture {
  readonly path: string
  readonly before: string | undefined
}

const USAGE = [
  'Usage:',
  '  /rewind                        list recent user messages to rewind to',
  '  /rewind <序号|@seq>             choose a mode for that message',
  '  /rewind <序号|@seq> chat        rewind the conversation only',
  '  /rewind <序号|@seq> both        rewind conversation and restore files',
  '  /rewind preview <目标>           show the impact list without executing',
].join('\n')

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

/** Read the full current text of a path, or undefined when the file is absent. */
async function readMaybe(fs: FileSystem, path: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const target = await fs.resolve(path, { signal })
    return await fs.readText(target, signal)
  } catch (error) {
    const code = (error as { code?: string })?.code
    if (code === 'ENOENT' || code === 'FS_NOT_FOUND') return undefined
    throw error
  }
}

/**
 * Capture the before-state of a tracked mutation during `tools/pre-execute`
 * (the file still holds the old content at this point).
 */
async function captureBefore(
  fs: FileSystem,
  exec: ToolExecution,
  pending: Map<string, PendingCapture>,
): Promise<void> {
  if (!TRACKED_TOOLS.has(exec.name)) return
  const path = mutationPathOf(exec)
  if (path === undefined) return
  const before = await readMaybe(fs, path, exec.signal)
  pending.set(`${exec.agent?.id ?? 'anon'}:${exec.callId}`, { path, before })
}

/**
 * Finalize one tracked mutation during `tools/post-execute`: read the new
 * content, resolve the turn anchor, and commit the ledger entry.
 */
async function commitEntry(
  fs: FileSystem,
  ledgerFor: (session: Session) => RewindLedger,
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
  let after: string
  try {
    after = await readMaybe(fs, capture.path, exec.signal) ?? ''
  } catch {
    return // unreadable post-state: nothing dependable to restore later
  }
  ledgerFor(agent.session).record({
    toolName: exec.name,
    anchorSeq,
    path: capture.path,
    before: capture.before,
    after,
  })
}

/** Build the rewind marker message the surface replacement lands on. */
function buildMarker(targetSeq: number): UserMessage {
  return createUserMessage({
    content: [{
      type: 'text',
      text: `[回退标记 / rewind marker] 对话已回退到 seq ${targetSeq}，此标记之后的历史已从模型上下文中移除。请忽略此标记本身，等待用户的下一条消息。`,
    }],
    source: { kind: 'user' },
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
    lines.push('目标之后没有台账记录的写类变更，无需还原文件。')
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

/** Execute a validated rewind: append the marker, then optionally restore files. */
async function executeRewind(
  ctx: Context,
  ledger: RewindLedger,
  invocation: CommandInvocation,
  rawTarget: string,
  mode: RewindMode,
): Promise<CommandResult> {
  const { agent } = invocation
  if (agent.status !== 'idle') {
    return { kind: 'error', text: 'agent 正在运行中，无法回退。请等待当前回合结束后再试。' }
  }
  let plan: RewindPlan
  try {
    plan = resolveOrError(agent.session.events, agent.session.surface.nodes, rawTarget)
  } catch (error) {
    return rewindErrorResult(error)
  }

  const marker = buildMarker(plan.targetSeq)
  let event: ReturnType<Session['append']>
  try {
    event = agent.session.append('user/message', marker, {
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
    const fs = ctx.get('fs', false) as FileSystem | undefined
    if (fs === undefined) {
      restore = '；未找到文件系统服务，未还原文件（可仅用 chat 模式回退对话）'
    } else {
      const outcome = await ledger.restoreAfter(fs, processPath => unlink(processPath), plan.targetSeq)
      restore = `；还原 ${outcome.restored.length} 个文件、删除 ${outcome.deleted.length} 个文件${renderFailures(outcome.failed)}`
    }
  }

  return {
    kind: 'success',
    text: `已回退到 seq ${plan.targetSeq}，移除 ${plan.shadowedSeqs.length} 条上下文（日志保留）${restore}。`,
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
      'nothing-after': error.message,
    }[error.code]
    return { kind: 'error', text }
  }
  throw error
}

/** Handle one `/rewind` invocation (two-step text flow + direct execution). */
async function handleRewind(
  ctx: Context,
  ledger: RewindLedger,
  invocation: CommandInvocation,
): Promise<CommandResult> {
  const session = invocation.agent.session
  const input = invocation.rawInput.trim()

  if (input === '') {
    const candidates = listRewindCandidates(session.events, session.surface.nodes)
    if (candidates.length === 0) {
      return { kind: 'error', text: '当前会话还没有可回退的用户消息。' }
    }
    return {
      kind: 'success',
      text: `选择要回退到的用户消息（最近在上）：\n${candidates.map(formatCandidate).join('\n')}\n\n继续：/rewind <序号|@seq>，或直接 /rewind <序号|@seq> chat|both 执行。`,
    }
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
    const impacts = ledger.impactsAfter(plan.targetSeq)
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
  return executeRewind(ctx, ledger, invocation, target, mode)
}

/**
 * Register the `/rewind` command and the tools-pipeline ledger hooks.
 * @param ctx - context carrying `commands`, `tools`, and an optional `fs`.
 */
export function apply(ctx: Context): void {
  // Ledgers are per-session: seq numbers only make sense inside one log.
  const ledgers = new Map<string, RewindLedger>()
  const ledgerFor = (session: Session): RewindLedger => {
    let ledger = ledgers.get(session.id)
    if (ledger === undefined) {
      ledger = new RewindLedger()
      ledgers.set(session.id, ledger)
    }
    return ledger
  }
  const fs = ctx.get('fs', false) as FileSystem | undefined
  // Pending before-captures keyed by agent id + callId (callIds are unique,
  // but scoping by agent makes cross-session collisions impossible).
  const pending = new Map<string, PendingCapture>()

  ctx.on('tools/pre-execute', async (exec: ToolExecution, next): Promise<PreToolDecision> => {
    if (fs !== undefined) {
      try {
        await captureBefore(fs, exec, pending)
      } catch (error) {
        ctx.logger.warn(`[dsh-rewind] before-capture failed for ${exec.name}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return next()
  })

  ctx.on('tools/post-execute', async (exec: ToolExecution, result: ToolExecutionResult, next): Promise<PostToolDecision> => {
    if (fs !== undefined) {
      try {
        await commitEntry(fs, ledgerFor, pending, exec, result)
      } catch (error) {
        ctx.logger.warn(`[dsh-rewind] ledger commit failed for ${exec.name}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return next()
  })

  ctx.effect(function* () {
    yield ctx.commands.register({
      name: 'rewind',
      description: '在同窗口内将对话回退到更早的用户消息（可同时还原文件）',
      handler: invocation => handleRewind(ctx, ledgerFor(invocation.agent.session), invocation),
    })
  }, 'dsh-rewind lifecycle')
}
