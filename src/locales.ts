/**
 * Host-side localization for dsh-rewind's command output and command
 * description.
 *
 * Architecture (matches the dsh ecosystem): the HOST half of a dual-face
 * plugin has no locale service — only the browser client carries one. The host
 * therefore renders its command-adjacent copy from the durable user preference
 * dsh-client-locale persists, defaulting to English — the ecosystem's neutral
 * default language (the harness `FALLBACK_LOCALE`). See packages/client/locale
 * in deepseek-harness.
 *
 * DSH 0.1.7 moved that preference out of a registered settings section into the
 * `locale` entry's own Config, so the host reads it through the settings
 * service's descriptor read (`readHostLocale` in `src/index.ts`) — the same
 * public read the settings UI and the client's own locale runtime perform.
 *
 * The client half (`src/client/locales.ts`) owns all interactive UI copy via
 * `ctx.locale` + `t()`; the client never parses host prose (the popover reads
 * travel over the RPC channel).
 *
 * DSH localizes only its OWN command descriptions via the client locale — a
 * closed `HOST_FACES` allowlist; third-party plugin descriptions are
 * not in that channel (see docs/compat/audit.md, RU-I18N), and no host command
 * OUTPUT is localized for anyone, so this dictionary is what carries it.
 *
 * English is the canonical key set: every other dictionary is typed complete
 * against it, and the tests compare every dictionary's template placeholders
 * with it. Adding a language is one dictionary plus one entry in `HOST_DICTS`.
 *
 * @module dsh-rewind/locales
 */

/** English dictionary — the canonical key set (neutral default). */
export const en = {
  'plan.skip': '  not restored: {path} ({reason})',
  'skipReason.oversized': 'over the {limit} backup limit, so the recorded state predates untracked edits',
  'error.invalidTarget': 'Cannot parse target "{raw}" (expected <index> or @<seq>)',
  'sep.list': ', ',
  'sep.clause': '; ',
  'failures.suffix': '; {count} file(s) failed to restore: {list}',
  'failures.item': '{path} ({message})',
  'inflight': 'A rewind is already running for this session; please wait.',
  'stopFailed': 'Could not stop the running agent; rewind cancelled. Please try again.',
  'cancelled': 'Rewind cancelled.',
  'failed': 'Rewind failed: {error}. The session is unchanged.',
  'restore.count': 'restored {count} file(s)',
  'delete.count': 'deleted {count} file(s)',
  'skip.count': 'skipped {count} path(s)',
  'noRestorable': '; no restorable write-class changes after the target',
  'backupOff': 'snapshot backups are off, so the restore may be incomplete',
  'storeUnsupported': 'file restore unavailable: these snapshots use a newer store format (v{version}) than this plugin understands; nothing was changed. Update the plugin or clear this session\'s snapshots.',
  'success': 'Withdrawn seq {targetSeq} and everything after it (conversation returned to earlier){restore}.',
  'noUserMessages': 'This session has no rewindable user messages yet.',
  'command.description': 'Rewind the conversation and/or files to a previous point',
  'command.undoDescription': 'Alias of /rewind',
  'engine.description': 'dsh-rewind internal command',
  'engine.rejected': 'Internal command: use /rewind or /undo.',
  'engine.inputHint': '@<seq> chat|both',
  'cleanup.description': 'Manage automatic cleanup of session snapshot backups',
  'cleanup.inputHint': 'on | off | max-age <days> | run [--apply] [--current]',
  'cleanup.status': 'Auto-cleanup: {state}. Max age: {days} day(s).',
  'cleanup.enabled': 'enabled',
  'cleanup.disabled': 'disabled',
  'cleanup.onOk': 'Auto-cleanup enabled.',
  'cleanup.offOk': 'Auto-cleanup disabled — all snapshots kept.',
  'cleanup.maxAgeOk': 'Auto-cleanup max age set to {days} day(s).',
  'cleanup.cfgInvalid': 'Snapshot cleanup config invalid: {detail}. Nothing was executed; use "on|off|max-age" to reset the config.',
  'cleanup.saveFailed': 'Could not save cleanup config: {detail}.',
  'cleanup.runDry': 'Dry-run: would remove {deleted} session snapshot backup(s), freeing {freed} bytes. Re-run with --apply to delete.',
  'cleanup.runApply': 'Removed {deleted} session snapshot backup(s), freeing {freed} bytes; {kept} kept, {remaining} bytes remain.',
  'cleanup.runFailed': 'Cleanup failed: {detail}.',
  'cleanup.skipped': '({skipped} active session(s) skipped.)',
  'cleanup.clearDry': 'Dry-run: would clear {entries} snapshot(s) of the current session, freeing {bytes} bytes. Re-run with --apply to delete.',
  'cleanup.clearApply': 'Cleared {entries} snapshot(s) of the current session, freeing {bytes} bytes. This session now records snapshots fresh from its current state.',
  'cleanup.clearActive': 'Could not clear session {sessionId}: the session is still running and could not be stopped. Try again once it is idle.',
  'cleanup.clearCancelled': 'Clear cancelled.',
  'cleanup.clearFailed': 'Could not clear session {sessionId}: {detail}.',
  'cleanup.usage': 'Usage:\n  /snapshot-auto-cleanup                 show status\n  /snapshot-auto-cleanup on|off          enable/disable auto-cleanup\n  /snapshot-auto-cleanup max-age <days>  set the idle cutoff\n  /snapshot-auto-cleanup run [--apply]   dry-run, or execute with --apply\n  /snapshot-auto-cleanup run --current [--apply]   dry-run/clear this session\'s snapshots',
} satisfies Record<string, string>

/** The host rewind dictionary key union. */
export type HostKey = keyof typeof en

/** Chinese dictionary, checked complete against the en key set. */
export const zh: Record<HostKey, string> = {
  'plan.skip': '  未还原：{path}（{reason}）',
  'skipReason.oversized': '已超过 {limit} 的备份上限，记录的状态早于未被跟踪的修改',
  'error.invalidTarget': '无法解析目标 "{raw}"（应为 <序号> 或 @<seq>）',
  'sep.list': '、',
  'sep.clause': '；',
  'failures.suffix': '；{count} 个文件还原失败：{list}',
  'failures.item': '{path}（{message}）',
  'inflight': '该会话已有一个回退正在执行，请稍候。',
  'stopFailed': '无法停止运行中的 agent，回退已取消。请稍后再试。',
  'cancelled': '回退已取消。',
  'failed': '回退失败：{error}。会话未改变。',
  'restore.count': '还原 {count} 个文件',
  'delete.count': '删除 {count} 个文件',
  'skip.count': '跳过 {count} 个路径',
  'noRestorable': '；目标之后没有可还原的写类变更',
  'backupOff': '快照备份已关闭，还原可能不充分',
  'storeUnsupported': '文件还原不可用：这些快照使用了比本插件更新的存储格式（v{version}）；工作区未做任何改动。请更新插件，或清除该会话的快照。',
  'success': '已撤回 seq {targetSeq} 及之后内容（对话已回到此前）{restore}。',
  'noUserMessages': '当前会话还没有可回退的用户消息。',
  'command.description': '把对话和/或文件回退到之前的某条消息',
  'command.undoDescription': '/rewind 的别名',
  'engine.description': 'dsh-rewind 内部命令',
  'engine.rejected': '内部命令：请使用 /rewind 或 /undo。',
  'engine.inputHint': '@<seq> chat|both',
  'cleanup.description': '管理会话快照备份的自动清理',
  'cleanup.inputHint': 'on | off | max-age <天数> | run [--apply] [--current]',
  'cleanup.status': '自动清理：{state}。最大保留天数：{days} 天。',
  'cleanup.enabled': '已开启',
  'cleanup.disabled': '已关闭',
  'cleanup.onOk': '已开启自动清理。',
  'cleanup.offOk': '已关闭自动清理——保留全部快照。',
  'cleanup.maxAgeOk': '已将自动清理的最大保留天数设为 {days} 天。',
  'cleanup.cfgInvalid': '快照清理配置无效：{detail}。未执行任何操作；请用「on|off|max-age」重设配置以修复。',
  'cleanup.saveFailed': '无法保存清理配置：{detail}。',
  'cleanup.runDry': '预演：将删除 {deleted} 个会话的快照备份，释放 {freed} 字节。加 --apply 正式删除。',
  'cleanup.runApply': '已删除 {deleted} 个会话的快照备份，释放 {freed} 字节；保留 {kept} 个，剩余 {remaining} 字节。',
  'cleanup.runFailed': '清理失败：{detail}。',
  'cleanup.skipped': '（跳过了 {skipped} 个活动会话。）',
  'cleanup.clearDry': '预演：将清除当前会话的 {entries} 个快照，释放 {bytes} 字节。加 --apply 正式删除。',
  'cleanup.clearApply': '已清除当前会话的 {entries} 个快照，释放 {bytes} 字节。该会话已重置为从当前状态重新记录快照。',
  'cleanup.clearActive': '无法清除会话 {sessionId}：会话仍在运行且未能停止，请待其空闲后重试。',
  'cleanup.clearCancelled': '清空已取消。',
  'cleanup.clearFailed': '无法清除会话 {sessionId}：{detail}。',
  'cleanup.usage': '用法：\n  /snapshot-auto-cleanup                 查看状态\n  /snapshot-auto-cleanup on|off          开启/关闭自动清理\n  /snapshot-auto-cleanup max-age <天数>  设置失活阈值（天）\n  /snapshot-auto-cleanup run [--apply]   预演，或加 --apply 执行\n  /snapshot-auto-cleanup run --current [--apply]  预演/清除本会话快照',
}

/** Japanese dictionary, checked complete against the en key set. */
export const ja: Record<HostKey, string> = {
  'plan.skip': '  復元対象外：{path}（{reason}）',
  'skipReason.oversized': '{limit} のバックアップ上限を超えているため、記録された状態は未追跡の編集より前のものです',
  'error.invalidTarget': '対象 "{raw}" を解析できません（<index> または @<seq> を指定してください）',
  'sep.list': '、',
  'sep.clause': '；',
  'failures.suffix': '；{count} 件のファイルを復元できませんでした：{list}',
  'failures.item': '{path}（{message}）',
  'inflight': 'このセッションでは既に巻き戻しが実行中です。お待ちください。',
  'stopFailed': '実行中のエージェントを停止できなかったため、巻き戻しをキャンセルしました。もう一度お試しください。',
  'cancelled': '巻き戻しをキャンセルしました。',
  'failed': '巻き戻しに失敗しました：{error}。セッションは変更されていません。',
  'restore.count': '{count} 件のファイルを復元しました',
  'delete.count': '{count} 件のファイルを削除しました',
  'skip.count': '{count} 件のパスをスキップしました',
  'noRestorable': '；対象より後に復元できる書込み系の変更はありません',
  'backupOff': 'スナップショットのバックアップが無効なため、復元が不完全になる可能性があります',
  'storeUnsupported': 'ファイルを復元できません：これらのスナップショットは、このプラグインが理解できる形式より新しい保存形式（v{version}）を使っています。何も変更されていません。プラグインを更新するか、このセッションのスナップショットを消去してください。',
  'success': 'seq {targetSeq} とそれ以降を撤回しました（会話は以前の状態に戻りました）{restore}。',
  'noUserMessages': 'このセッションにはまだ巻き戻しできるユーザーメッセージがありません。',
  'command.description': '会話やファイルを以前の時点まで巻き戻します',
  'command.undoDescription': '/rewind のエイリアス',
  'engine.description': 'dsh-rewind の内部コマンド',
  'engine.rejected': '内部コマンドです。/rewind または /undo を使ってください。',
  'engine.inputHint': '@<seq> chat|both',
  'cleanup.description': 'セッションのスナップショットバックアップの自動クリーンアップを管理します',
  'cleanup.inputHint': 'on | off | max-age <日数> | run [--apply] [--current]',
  'cleanup.status': '自動クリーンアップ：{state}。最大保持期間：{days} 日。',
  'cleanup.enabled': '有効',
  'cleanup.disabled': '無効',
  'cleanup.onOk': '自動クリーンアップを有効にしました。',
  'cleanup.offOk': '自動クリーンアップを無効にしました — すべてのスナップショットが保持されます。',
  'cleanup.maxAgeOk': '自動クリーンアップの最大保持期間を {days} 日に設定しました。',
  'cleanup.cfgInvalid': 'スナップショットのクリーンアップ設定が無効です：{detail}。何も実行されていません。"on|off|max-age" で設定をリセットしてください。',
  'cleanup.saveFailed': 'クリーンアップ設定を保存できませんでした：{detail}。',
  'cleanup.runDry': 'ドライラン：{deleted} 件のセッションのスナップショットバックアップを削除し、{freed} バイトを解放します。実際に削除するには --apply を付けて再実行してください。',
  'cleanup.runApply': '{deleted} 件のセッションのスナップショットバックアップを削除し、{freed} バイトを解放しました。{kept} 件を保持し、残りは {remaining} バイトです。',
  'cleanup.runFailed': 'クリーンアップに失敗しました：{detail}。',
  'cleanup.skipped': '（アクティブなセッション {skipped} 件をスキップしました。）',
  'cleanup.clearDry': 'ドライラン：現在のセッションのスナップショット {entries} 件を消去し、{bytes} バイトを解放します。実際に削除するには --apply を付けて再実行してください。',
  'cleanup.clearApply': '現在のセッションのスナップショット {entries} 件を消去し、{bytes} バイトを解放しました。このセッションは現在の状態から新しくスナップショットを記録します。',
  'cleanup.clearActive': 'セッション {sessionId} を消去できません：セッションはまだ実行中で、停止できませんでした。アイドル状態になってからもう一度お試しください。',
  'cleanup.clearCancelled': '消去をキャンセルしました。',
  'cleanup.clearFailed': 'セッション {sessionId} を消去できませんでした：{detail}。',
  'cleanup.usage': '使い方：\n  /snapshot-auto-cleanup                 状態を表示\n  /snapshot-auto-cleanup on|off          自動クリーンアップの有効/無効\n  /snapshot-auto-cleanup max-age <日数>  アイドルしきい値を設定\n  /snapshot-auto-cleanup run [--apply]   ドライラン、または --apply で実行\n  /snapshot-auto-cleanup run --current [--apply]   ドライラン／現在のセッションのスナップショットを消去',
}

/**
 * Every language this plugin ships a host dictionary for. English is first as
 * the canonical dictionary; the rest follow the harness's language order.
 * Adding a language is one dictionary above plus one entry here — the locale-id
 * type, the preference resolver, and the tests all derive from this map.
 */
export const HOST_DICTS = { en, zh, ja } satisfies Record<string, Record<HostKey, string>>

/** Host-side supported locale ids (the registry keys). */
export type HostLocaleId = keyof typeof HOST_DICTS

/** Neutral default, matching the harness's `FALLBACK_LOCALE`. */
export const DEFAULT_HOST_LOCALE = 'en' as const satisfies HostLocaleId

/** Whether a normalized tag names a shipped host dictionary. */
function isHostLocale(tag: string): tag is HostLocaleId {
  return Object.hasOwn(HOST_DICTS, tag)
}

/**
 * The locale a durable preference selects from this plugin's dictionaries.
 *
 * The harness accepts any BCP 47-style id while this plugin ships a fixed set,
 * so the preference is matched against the registry: the full tag first
 * (case-insensitively), then its primary subtag (`xx-YY` → `xx`), mirroring the
 * client runtime. Anything else — an unset preference, an unsupported language,
 * a non-string value — is the neutral default.
 *
 * @param preference - the raw `locale.preference` value.
 * @returns the dictionary this plugin renders its host copy in.
 */
export function preferredLocale(preference: unknown): HostLocaleId {
  if (typeof preference !== 'string') return DEFAULT_HOST_LOCALE
  const tag = preference.toLowerCase()
  if (isHostLocale(tag)) return tag
  const primary = tag.split('-')[0]
  return primary !== undefined && isHostLocale(primary) ? primary : DEFAULT_HOST_LOCALE
}

/**
 * Render one dictionary key with `{name}` template interpolation. Unknown
 * params are ignored; a missing key falls back to the raw key so a dictionary
 * gap is visible instead of blank.
 * @param lang - the active locale id.
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
