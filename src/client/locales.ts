/** `rewind` namespace dictionaries for the client plugin. */

/** English dictionary — the canonical key set (the harness fallback language). */
export const en = {
  'button.aria': 'Rewind to this message',
  'button.title': 'Rewind',
  'button.retract.aria': 'Rewind to this pending message',
  'button.retract.title': 'Rewind',
  'popover.title': 'Rewind to this message',
  'popover.noText': '(no text)',
  'popover.retract.title': 'Rewind to this pending message',
  'popover.retract.target': 'Pending · {preview}',
  'popover.retract.hint': 'Retracts this pending message and the ones after it, without interrupting the run',
  'popover.retract.confirm': 'Confirm rewind',
  'popover.chat': 'Rewind conversation only',
  'popover.chat.hint': 'Context only; workspace untouched',
  'popover.both': 'Rewind conversation and files',
  'popover.both.hint': 'Context and restore workspace files',
  'popover.checking': 'Checking for file changes…',
  'popover.noChanges': 'No restorable file changes',
  'popover.backupDisabled': 'Snapshots off; the restore may be incomplete',
  'popover.cancel': 'Cancel',
  'popover.impact.loading': 'Fetching impact list…',
  'popover.impact.failed': 'Could not fetch the impact list: {message}',
  'popover.impact.none': 'No tracked file changes after the target; nothing to restore.',
  'popover.impact.restore': 'Restore {path}',
  'popover.impact.delete': 'Delete {path}',
  'popover.confirm': 'Confirm rewind',
  'popover.back': 'Back',
  'backup.title': 'Snapshot backups',
  'backup.on': 'When on, file snapshots are created automatically for file restore.',
  'backup.off': 'When off, no file snapshots are created; file changes made while off cannot be restored.',
  'cleanup.auto': 'Auto cleanup',
  'cleanup.auto.on': 'When enabled, session snapshots idle past the cutoff are cleaned automatically.',
  'cleanup.auto.off': 'When off, snapshots are not cleaned automatically.',
  'cleanup.maxAge': 'Idle time (days)',
  'cleanup.maxAge.hint': 'Snapshot backups of sessions idle longer than this many days are cleaned.',
  'cleanup.invalid': 'Enter a positive integer, or leave blank to use the default',
  'cleanup.overridden': 'Overridden',
  'cleanup.reset': 'Reset to default',
  'cleanup.save': 'Save',
  'cleanup.saving': 'Saving…',
  'cleanup.saveFailed': 'The deployment did not accept these values; they were left for you to correct',
  'cleanup.readonly': 'This deployment stores settings read-only',
  'cleanup.unavailable': 'This plugin is not loaded, so it cannot be configured right now',
} satisfies Record<string, string>

/** The rewind namespace key union. */
export type RewindKey = keyof typeof en

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The in-place rewind controls' copy. */
    rewind: RewindKey
  }
}

/** Chinese dictionary, checked complete against the en key set. */
export const zh: Record<RewindKey, string> = {
  'button.aria': '回退到此消息',
  'button.title': '回退',
  'button.retract.aria': '回退到此插话消息',
  'button.retract.title': '回退',
  'popover.title': '回退到这条消息',
  'popover.noText': '（无文本）',
  'popover.retract.title': '回退到这条插话消息',
  'popover.retract.target': '插话中 · {preview}',
  'popover.retract.hint': '撤回这条及之后的插话消息，不打断当前生成',
  'popover.retract.confirm': '确认回退',
  'popover.chat': '仅回退对话',
  'popover.chat.hint': '仅回退上下文，不动工作区文件',
  'popover.both': '回退对话和文件',
  'popover.both.hint': '回退上下文并还原工作区文件',
  'popover.checking': '正在检查文件变更…',
  'popover.noChanges': '无可还原的文件变更',
  'popover.backupDisabled': '快照备份已关闭，还原可能不充分',
  'popover.cancel': '取消',
  'popover.impact.loading': '正在获取影响清单…',
  'popover.impact.failed': '无法获取影响清单：{message}',
  'popover.impact.none': '目标之后没有跟踪到的写类变更，无需还原文件。',
  'popover.impact.restore': '还原 {path}',
  'popover.impact.delete': '删除 {path}',
  'popover.confirm': '确认回退',
  'popover.back': '返回',
  'backup.title': '快照备份',
  'backup.on': '开启后自动创建文件快照，用于文件还原。',
  'backup.off': '关闭后不再创建文件快照；关闭期间的文件改动无法还原。',
  'cleanup.auto': '自动清理',
  'cleanup.auto.on': '开启后按不活跃天数自动清理过期会话快照。',
  'cleanup.auto.off': '关闭后不会自动清理快照。',
  'cleanup.maxAge': '不活跃时间（天）',
  'cleanup.maxAge.hint': '超过该天数未活动的会话快照会被清理。',
  'cleanup.invalid': '请填正整数；留空表示使用默认值',
  'cleanup.overridden': '已覆盖',
  'cleanup.reset': '恢复默认',
  'cleanup.save': '保存',
  'cleanup.saving': '保存中…',
  'cleanup.saveFailed': '本部署没有接受这些值，已保留供你修改',
  'cleanup.readonly': '本部署的设置为只读',
  'cleanup.unavailable': '该插件当前未加载，暂时无法配置',
}

/** Japanese dictionary, checked complete against the en key set. */
export const ja: Record<RewindKey, string> = {
  'button.aria': 'このメッセージまで巻き戻す',
  'button.title': '巻き戻し',
  'button.retract.aria': 'この保留中のメッセージまで巻き戻す',
  'button.retract.title': '巻き戻し',
  'popover.title': 'このメッセージまで巻き戻す',
  'popover.noText': '（テキストなし）',
  'popover.retract.title': 'この保留中のメッセージまで巻き戻す',
  'popover.retract.target': '保留中 · {preview}',
  'popover.retract.hint': 'この保留中のメッセージとそれ以降を撤回します。現在の生成は中断しません',
  'popover.retract.confirm': '巻き戻しを実行',
  'popover.chat': '会話のみ巻き戻す',
  'popover.chat.hint': 'コンテキストのみ対象で、ワークスペースは変更しません',
  'popover.both': '会話とファイルを巻き戻す',
  'popover.both.hint': 'コンテキストを巻き戻し、ワークスペースのファイルを復元します',
  'popover.checking': 'ファイルの変更を確認中…',
  'popover.noChanges': '復元できるファイルの変更はありません',
  'popover.backupDisabled': 'スナップショットが無効なため、復元が不完全になる可能性があります',
  'popover.cancel': 'キャンセル',
  'popover.impact.loading': '影響リストを取得中…',
  'popover.impact.failed': '影響リストを取得できませんでした：{message}',
  'popover.impact.none': '対象より後に追跡されたファイル変更はありません。復元するものはありません。',
  'popover.impact.restore': '{path} を復元',
  'popover.impact.delete': '{path} を削除',
  'popover.confirm': '巻き戻しを実行',
  'popover.back': '戻る',
  'backup.title': 'スナップショットのバックアップ',
  'backup.on': '有効にすると、ファイル復元用のスナップショットが自動で作成されます。',
  'backup.off': '無効にすると、ファイルのスナップショットは作成されません。無効な間のファイル変更は復元できません。',
  'cleanup.auto': '自動クリーンアップ',
  'cleanup.auto.on': '有効にすると、しきい値を超えてアイドル状態のセッションのスナップショットが自動で削除されます。',
  'cleanup.auto.off': '無効にすると、スナップショットは自動で削除されません。',
  'cleanup.maxAge': 'アイドル時間（日）',
  'cleanup.maxAge.hint': 'この日数を超えてアイドル状態のセッションのスナップショットバックアップが削除されます。',
  'cleanup.invalid': '正の整数を入力してください。空欄の場合は既定値を使います',
  'cleanup.overridden': '上書き済み',
  'cleanup.reset': '既定値に戻す',
  'cleanup.save': '保存',
  'cleanup.saving': '保存中…',
  'cleanup.saveFailed': 'このデプロイメントでは値が受け付けられませんでした。修正できるよう入力は保持されています',
  'cleanup.readonly': 'このデプロイメントでは設定が読み取り専用です',
  'cleanup.unavailable': 'このプラグインは現在読み込まれていないため、設定できません',
}

/**
 * Every dictionary this plugin ships, canonical first. Registration takes this
 * map as a whole, so shipping another language is one dictionary above plus one
 * entry here — no wiring change in `index.ts`.
 */
export const CLIENT_DICTS = { en, zh, ja }
