/** `rewind` namespace dictionaries for the client plugin. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'button.aria': '回退到此消息',
  'button.title': '回退',
  'popover.title': '回退到这条消息',
  'popover.target': 'seq {seq} · {time}',
  'popover.chat': '仅回退对话',
  'popover.chat.hint': '只回退模型上下文，不动工作区文件',
  'popover.both': '回退对话和代码',
  'popover.both.hint': '对话回退并还原工作区文件',
  'popover.cancel': '取消',
  'popover.impact.loading': '正在获取影响清单…',
  'popover.impact.failed': '无法获取影响清单：{message}',
  'popover.impact.none': '目标之后没有跟踪到的写类变更，无需还原文件。',
  'popover.confirm': '确认回退',
  'popover.back': '返回',
  'guard.hint': '/rewind 命令不支持手动输入，请使用消息旁的 ↶ 回退按钮',
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
  'popover.target': 'seq {seq} · {time}',
  'popover.chat': 'Rewind conversation only',
  'popover.chat.hint': 'Cut the model context only; workspace files stay untouched',
  'popover.both': 'Rewind conversation and code',
  'popover.both.hint': 'Cut the context and restore workspace files',
  'popover.cancel': 'Cancel',
  'popover.impact.loading': 'Fetching impact list…',
  'popover.impact.failed': 'Could not fetch the impact list: {message}',
  'popover.impact.none': 'No tracked file changes after the target; nothing to restore.',
  'popover.confirm': 'Confirm rewind',
  'popover.back': 'Back',
  'guard.hint': '/rewind cannot be typed manually — use the ↶ button on a message to rewind.',
} satisfies Record<RewindKey, string>
