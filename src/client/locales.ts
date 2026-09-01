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
  'cleanup.title': '快照清理',
  'cleanup.desc': '管理会话快照备份的自动清理策略',
  'cleanup.expand': '展开',
  'cleanup.collapse': '收起',
  'cleanup.unsaved': '未保存修改',
  'cleanup.auto': '自动清理',
  'cleanup.auto.hint': '开启后按下面的不活跃天数自动清理过期会话快照',
  'cleanup.maxAge': '不活跃时间（天）',
  'cleanup.maxAge.hint': '超过该天数未活动的会话快照会被清理',
  'cleanup.invalid': '仅接受正整数',
  'cleanup.discard': '放弃修改',
  'cleanup.save': '保存',
  'cleanup.saving': '保存中…',
  'cleanup.saved': '已保存并生效',
  'cleanup.saveFailed': '保存失败：{message}',
  'cleanup.readonly': '设置源只读',
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
  'cleanup.title': 'Snapshot cleanup',
  'cleanup.desc': 'Manage the auto-cleanup policy of session snapshot backups',
  'cleanup.expand': 'Expand',
  'cleanup.collapse': 'Collapse',
  'cleanup.unsaved': 'Unsaved changes',
  'cleanup.auto': 'Auto cleanup',
  'cleanup.auto.hint': 'When on, idle session snapshots are cleaned automatically after the idle days below',
  'cleanup.maxAge': 'Idle time (days)',
  'cleanup.maxAge.hint': 'Snapshot backups of sessions idle longer than this many days are cleaned',
  'cleanup.invalid': 'A positive integer only',
  'cleanup.discard': 'Discard changes',
  'cleanup.save': 'Save',
  'cleanup.saving': 'Saving…',
  'cleanup.saved': 'Saved and applied',
  'cleanup.saveFailed': 'Save failed: {message}',
  'cleanup.readonly': 'Read-only settings source',
} satisfies Record<RewindKey, string>
