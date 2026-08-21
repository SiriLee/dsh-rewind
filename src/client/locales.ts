/** `rewind` namespace dictionaries for the client plugin. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'button.aria': '回退到此消息',
  'button.title': '回退',
  'popover.title': '回退到这条消息',
  'popover.noText': '（无文本）',
  'popover.chat': '仅回退对话',
  'popover.chat.hint': '只回退模型上下文，不动工作区文件',
  'popover.both': '回退对话和代码',
  'popover.both.hint': '对话回退并还原工作区文件',
  'popover.checking': '正在检查文件变更…',
  'popover.noChanges': '此消息之后没有可还原的文件变更，仅可回退对话',
  'popover.cancel': '取消',
  'popover.impact.loading': '正在获取影响清单…',
  'popover.impact.failed': '无法获取影响清单：{message}',
  'popover.impact.none': '目标之后没有跟踪到的写类变更，无需还原文件。',
  'popover.confirm': '确认回退',
  'popover.back': '返回',
  'menu.title': '回退到哪条消息？',
  'menu.hint': '↑↓ 选择 · Enter 确认 · 数字键直选 · Esc 关闭',
  'menu.empty': '当前会话还没有可回退的用户消息',
  'menu.more': '仅显示最近 {count} 条',
  'menu.cancel': '取消',
  'guard.hint': '/rewind 手动输入不接受参数，请直接输入 /rewind 打开回退菜单',
} satisfies Record<string, string>

/** The rewind namespace key union. */
export type RewindKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The in-place rewind controls' copy. */
    rewind: RewindKey
  }
}

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'button.aria': 'Rewind to this message',
  'button.title': 'Rewind',
  'popover.title': 'Rewind to this message',
  'popover.noText': '(no text)',
  'popover.chat': 'Rewind conversation only',
  'popover.chat.hint': 'Cut the model context only; workspace files stay untouched',
  'popover.both': 'Rewind conversation and code',
  'popover.both.hint': 'Cut the context and restore workspace files',
  'popover.checking': 'Checking for file changes…',
  'popover.noChanges': 'No tracked file changes after this message; conversation-only rewind',
  'popover.cancel': 'Cancel',
  'popover.impact.loading': 'Fetching impact list…',
  'popover.impact.failed': 'Could not fetch the impact list: {message}',
  'popover.impact.none': 'No tracked file changes after the target; nothing to restore.',
  'popover.confirm': 'Confirm rewind',
  'popover.back': 'Back',
  'menu.title': 'Rewind to which message?',
  'menu.hint': '↑↓ to move · Enter to confirm · number to pick · Esc to close',
  'menu.empty': 'No user messages to rewind in this session',
  'menu.more': 'Showing the {count} most recent only',
  'menu.cancel': 'Cancel',
  'guard.hint': '/rewind takes no typed arguments — enter /rewind to open the rewind menu.',
} satisfies Record<RewindKey, string>
