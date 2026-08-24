/** `rewind` namespace dictionaries for the client plugin. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'button.aria': '回退到此消息',
  'button.title': '回退',
  'button.retract.aria': '回退到此插话消息',
  'button.retract.title': '回退',
  'popover.title': '回退到这条消息',
  'popover.noText': '（无文本）',
  'popover.retract.title': '回退到这条插话消息',
  'popover.retract.target': '插话中 · {preview}',
  'popover.retract.hint': '将停止当前生成，并回退到该消息之前',
  'popover.retract.confirm': '确认回退',
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
  'popover.impact.restore': '还原 {path}',
  'popover.impact.delete': '删除 {path}',
  'popover.confirm': '确认回退',
  'popover.back': '返回',
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
  'button.retract.aria': 'Rewind to this pending message',
  'button.retract.title': 'Rewind',
  'popover.title': 'Rewind to this message',
  'popover.noText': '(no text)',
  'popover.retract.title': 'Rewind to this pending message',
  'popover.retract.target': 'Pending · {preview}',
  'popover.retract.hint': 'Stops the current run and rewinds to before this message',
  'popover.retract.confirm': 'Confirm rewind',
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
  'popover.impact.restore': 'Restore {path}',
  'popover.impact.delete': 'Delete {path}',
  'popover.confirm': 'Confirm rewind',
  'popover.back': 'Back',
  'guard.hint': '/rewind takes no typed arguments — enter /rewind to open the rewind picker.',
} satisfies Record<RewindKey, string>
