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
  'chooseMode': 'Rewind to {target}. Choose a mode:\n  /rewind {target} chat  conversation only\n  /rewind {target} both  conversation + file restore',
  'command.description': 'Rewind the conversation back to an earlier user message (optionally restoring files)',
  'cleanup.description': 'Manage automatic cleanup of finished-session snapshots',
  'cleanup.inputHint': 'on | off | max-age <days> | run [--apply] | status',
  'cleanup.status': 'Auto-cleanup: {state}. Max age: {days} day(s). Config: {path} ({present}).',
  'cleanup.enabled': 'enabled',
  'cleanup.disabled': 'disabled',
  'cleanup.present': 'file present',
  'cleanup.absent': 'no file — defaults',
  'cleanup.onOk': 'Auto-cleanup enabled.',
  'cleanup.offOk': 'Auto-cleanup disabled — all snapshots kept.',
  'cleanup.maxAgeOk': 'Auto-cleanup max age set to {days} day(s).',
  'cleanup.cfgInvalid': 'Snapshot cleanup config invalid: {detail}. Using the safe default (disabled).',
  'cleanup.saveFailed': 'Could not save cleanup config: {detail}.',
  'cleanup.runDry': 'Dry-run: would remove {deleted} session dir(s), freeing {freed} bytes; {kept} kept, {remaining} bytes remain.',
  'cleanup.runApply': 'Removed {deleted} session dir(s), freeing {freed} bytes; {kept} kept, {remaining} bytes remain.',
  'cleanup.runFailed': 'Cleanup failed: {detail}.',
  'cleanup.skipped': '({skipped} active session(s) skipped.)',
  'cleanup.usage': 'Usage:\n  /snapshot-auto-cleanup                 show status\n  /snapshot-auto-cleanup on|off          enable/disable auto-cleanup\n  /snapshot-auto-cleanup max-age <days>  set the idle cutoff\n  /snapshot-auto-cleanup run [--apply]   dry-run, or execute with --apply',
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
  'chooseMode': '将回退到 {target}。选择模式：\n  /rewind {target} chat  仅回退对话\n  /rewind {target} both  回退对话并还原文件',
  'command.description': '在同窗口内将对话回退到更早的用户消息（可同时还原文件）',
  'cleanup.description': '管理已完成会话快照的自动清理',
  'cleanup.inputHint': 'on | off | max-age <天数> | run [--apply] | status',
  'cleanup.status': '自动清理：{state}。最大保留天数：{days} 天。配置：{path}（{present}）。',
  'cleanup.enabled': '已开启',
  'cleanup.disabled': '已关闭',
  'cleanup.present': '存在配置文件',
  'cleanup.absent': '无文件——使用默认值',
  'cleanup.onOk': '已开启自动清理。',
  'cleanup.offOk': '已关闭自动清理——保留全部快照。',
  'cleanup.maxAgeOk': '已将自动清理的最大保留天数设为 {days} 天。',
  'cleanup.cfgInvalid': '快照清理配置无效：{detail}。已使用安全默认值（关闭）。',
  'cleanup.saveFailed': '无法保存清理配置：{detail}。',
  'cleanup.runDry': '预演：将删除 {deleted} 个会话目录，释放 {freed} 字节；保留 {kept} 个，剩余 {remaining} 字节。',
  'cleanup.runApply': '已删除 {deleted} 个会话目录，释放 {freed} 字节；保留 {kept} 个，剩余 {remaining} 字节。',
  'cleanup.runFailed': '清理失败：{detail}。',
  'cleanup.skipped': '（跳过了 {skipped} 个活动会话。）',
  'cleanup.usage': '用法：\n  /snapshot-auto-cleanup                 查看状态\n  /snapshot-auto-cleanup on|off          开启/关闭自动清理\n  /snapshot-auto-cleanup max-age <天数>  设置失活阈值（天）\n  /snapshot-auto-cleanup run [--apply]   预演，或加 --apply 执行',
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
