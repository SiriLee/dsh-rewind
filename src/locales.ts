/**
 * Host-side localization for dsh-rewind's `/rewind` command output and command
 * description.
 *
 * Architecture (matches the dsh ecosystem): the HOST half of a dual-face
 * plugin has no locale service — only the browser client carries one. The host
 * therefore renders its command-adjacent copy from a durable user preference
 * (`ctx.settings` → `locale.preference`, registered by dsh-client-locale),
 * defaulting to English — the ecosystem's neutral default language (the harness
 * `FALLBACK_LOCALE` and the language dsh's own host commands use, e.g.
 * dsh-plan-mode). See packages/client/locale in deepseek-harness.
 *
 * The client half (`src/client/locales.ts`) owns all interactive UI copy via
 * `ctx.locale` + `t()`; the host's human text is a machine channel the client
 * renders through machine tokens (`impact=<n>`, `args` @seq), never by parsing
 * host prose.
 *
 * English is the key-set source of truth; zh is checked complete against it.
 *
 * @module dsh-rewind/locales
 */

/** Host-side supported locale ids, mirroring the harness's shipped locales. */
export type HostLocaleId = 'zh' | 'en'

/** English dictionary — the key-set source of truth (neutral default). */
export const en = {
  'usage.title': 'Usage:',
  'usage.noArgs': '  /rewind                       (no args) withdraw the most recent user message',
  'usage.seq': '  /rewind @<seq> chat|both      rewind to the given message (chat = conversation only / both = conversation + files)',
  'usage.blocked': '  Manual /rewind input is intercepted; use the ↶ button next to a message',
  'describeTarget.seq': 'seq {seq}',
  'describeTarget.index': 'message {index}',
  'plan.rewinding': 'Rewind to seq {targetSeq}, removing {count} node(s) from the model context (conversation log kept).',
  'plan.affects': 'Affects {count} file(s):',
  'plan.restore': 'restore {path}',
  'plan.delete': 'delete {path}',
  'plan.noChanges': 'No restorable changes after the target.',
  'error.invalidTarget': 'Cannot parse target "{raw}" (expected <index> or @<seq>)',
  'failures.suffix': '; {count} file(s) failed to restore: {list}',
  'failures.item': '{path} ({message})',
  'inflight': 'A rewind is already running for this session; please wait.',
  'stopFailed': 'Could not stop the running agent; rewind cancelled. Please try again.',
  'cancelled': 'Rewind cancelled.',
  'failed': 'Rewind failed: {error}. The session is unchanged.',
  'restore.count': 'restored {count} file(s)',
  'delete.count': 'deleted {count} file(s)',
  'skip.count': 'skipped {count} link(s)',
  'noRestorable': '; no restorable write-class changes after the target',
  'success': 'Withdrawn seq {targetSeq} and everything after it (conversation returned to earlier){restore}.',
  'noUserMessages': 'This session has no rewindable user messages yet.',
  'openStep': 'The session log holds an unclosed step (likely left by a crash or a manual log edit). Rewind is blocked because it would break /compact. Repair the log (close the pending step/end) or start a new session, then rewind again.',
  'chooseMode': 'Rewind to {target}. Choose a mode:\n  /rewind {target} chat  conversation only\n  /rewind {target} both  conversation + file restore',
  'command.description': 'Rewind the conversation back to an earlier user message (optionally restoring files)',
} satisfies Record<string, string>

/** The host rewind dictionary key union. */
export type HostKey = keyof typeof en

/** Chinese dictionary, checked complete against the en key set. */
export const zh: Record<HostKey, string> = {
  'usage.title': '用法：',
  'usage.noArgs': '  /rewind                       （无参数）撤回最近一条用户消息',
  'usage.seq': '  /rewind @<seq> chat|both      回退到指定消息（chat 仅对话 / both 对话+文件）',
  'usage.blocked': '  手动输入 /rewind 会被拦截，请使用消息旁的「回退」按钮',
  'describeTarget.seq': 'seq {seq}',
  'describeTarget.index': '第 {index} 条消息',
  'plan.rewinding': '将回退到 seq {targetSeq}，从模型上下文移除 {count} 个节点（对话日志保留）。',
  'plan.affects': '将影响 {count} 个文件：',
  'plan.restore': '还原 {path}',
  'plan.delete': '删除 {path}',
  'plan.noChanges': '目标之后没有需要还原的变更。',
  'error.invalidTarget': '无法解析目标 "{raw}"（应为 <序号> 或 @<seq>）',
  'failures.suffix': '；{count} 个文件还原失败：{list}',
  'failures.item': '{path}（{message}）',
  'inflight': '该会话已有一个回退正在执行，请稍候。',
  'stopFailed': '无法停止运行中的 agent，回退已取消。请稍后再试。',
  'cancelled': '回退已取消。',
  'failed': '回退失败：{error}。会话未改变。',
  'restore.count': '还原 {count} 个文件',
  'delete.count': '删除 {count} 个文件',
  'skip.count': '跳过 {count} 个链接',
  'noRestorable': '；目标之后没有可还原的写类变更',
  'success': '已撤回 seq {targetSeq} 及之后内容（对话已回到此前）{restore}。',
  'noUserMessages': '当前会话还没有可回退的用户消息。',
  'openStep': '会话日志中存在未闭合的 step（可能是崩溃或手动编辑遗留）。回退已阻止，因为继续会破坏 /compact。请修复日志（补上缺失的 step/end）或新建会话后再试。',
  'chooseMode': '将回退到 {target}。选择模式：\n  /rewind {target} chat  仅回退对话\n  /rewind {target} both  回退对话并还原文件',
  'command.description': '在同窗口内将对话回退到更早的用户消息（可同时还原文件）',
}

/** The host dictionaries keyed by locale id. */
export const HOST_DICTS: Record<HostLocaleId, Record<HostKey, string>> = { en, zh }

/**
 * Render one dictionary key with `{name}` template interpolation. Unknown
 * params are ignored; a missing key falls back to the raw key so a dictionary
 * gap is visible instead of blank.
 * @param lang - the active locale.
 * @param key - the dictionary key.
 * @param params - `{name}` substitution values.
 */
export function translate(
  lang: HostLocaleId,
  key: HostKey,
  params: Record<string, string | number> = {},
): string {
  const dict = HOST_DICTS[lang] ?? en
  let text = dict[key] ?? key
  for (const [name, value] of Object.entries(params)) {
    text = text.split(`{${name}}`).join(String(value))
  }
  return text
}
