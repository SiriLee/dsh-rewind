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

/** Spanish dictionary, checked complete against the en key set. */
export const es: Record<HostKey, string> = {
  'plan.skip': '  no restaurado: {path} ({reason})',
  'skipReason.oversized': 'supera el límite de copias de seguridad de {limit}, por lo que el estado registrado es anterior a los cambios no rastreados',
  'error.invalidTarget': 'No se puede interpretar el destino "{raw}" (se esperaba <index> o @<seq>)',
  'sep.list': ', ',
  'sep.clause': '; ',
  'failures.suffix': '; no se pudieron restaurar {count} archivo(s): {list}',
  'failures.item': '{path} ({message})',
  'inflight': 'Ya hay un rebobinado en curso para esta sesión; espere por favor.',
  'stopFailed': 'No se pudo detener el agente en ejecución; rebobinado cancelado. Inténtelo de nuevo.',
  'cancelled': 'Rebobinado cancelado.',
  'failed': 'Error al rebobinar: {error}. La sesión no ha cambiado.',
  'restore.count': '{count} archivo(s) restaurado(s)',
  'delete.count': '{count} archivo(s) eliminado(s)',
  'skip.count': '{count} ruta(s) omitida(s)',
  'noRestorable': '; no hay cambios de escritura restaurables después del destino',
  'backupOff': 'las copias de seguridad de instantáneas están desactivadas, la restauración puede ser incompleta',
  'storeUnsupported': 'restauración de archivos no disponible: estas instantáneas usan un formato de almacenamiento más reciente (v{version}) que este plugin no entiende; no se ha cambiado nada. Actualice el plugin o borre las instantáneas de esta sesión.',
  'success': 'Retirado seq {targetSeq} y todo lo posterior (conversación devuelta a un punto anterior){restore}.',
  'noUserMessages': 'Esta sesión aún no tiene mensajes de usuario a los que rebobinar.',
  'command.description': 'Rebobinar la conversación y/o los archivos a un punto anterior',
  'command.undoDescription': 'Alias de /rewind',
  'engine.description': 'Comando interno de dsh-rewind',
  'engine.rejected': 'Comando interno: use /rewind o /undo.',
  'engine.inputHint': '@<seq> chat|both',
  'cleanup.description': 'Gestionar la limpieza automática de las copias de seguridad de instantáneas de sesión',
  'cleanup.inputHint': 'on | off | max-age <días> | run [--apply] [--current]',
  'cleanup.status': 'Limpieza automática: {state}. Antigüedad máxima: {days} día(s).',
  'cleanup.enabled': 'activada',
  'cleanup.disabled': 'desactivada',
  'cleanup.onOk': 'Limpieza automática activada.',
  'cleanup.offOk': 'Limpieza automática desactivada: se conservan todas las instantáneas.',
  'cleanup.maxAgeOk': 'Antigüedad máxima de la limpieza automática: {days} día(s).',
  'cleanup.cfgInvalid': 'Configuración de limpieza de instantáneas no válida: {detail}. No se ejecutó nada; use "on|off|max-age" para restablecer la configuración.',
  'cleanup.saveFailed': 'No se pudo guardar la configuración de limpieza: {detail}.',
  'cleanup.runDry': 'Simulación: se eliminarían {deleted} copia(s) de seguridad de instantáneas de sesión y se liberarían {freed} bytes. Vuelva a ejecutar con --apply para eliminar.',
  'cleanup.runApply': 'Se eliminaron {deleted} copia(s) de seguridad de instantáneas de sesión y se liberaron {freed} bytes; {kept} conservada(s), quedan {remaining} bytes.',
  'cleanup.runFailed': 'Error en la limpieza: {detail}.',
  'cleanup.skipped': '({skipped} sesión(es) activa(s) omitida(s).)',
  'cleanup.clearDry': 'Simulación: se borrarían {entries} instantánea(s) de la sesión actual y se liberarían {bytes} bytes. Vuelva a ejecutar con --apply para eliminar.',
  'cleanup.clearApply': 'Se borraron {entries} instantánea(s) de la sesión actual y se liberaron {bytes} bytes. La sesión ahora registra instantáneas nuevas desde su estado actual.',
  'cleanup.clearActive': 'No se pudo borrar la sesión {sessionId}: sigue en ejecución y no se pudo detener. Inténtelo de nuevo cuando esté inactiva.',
  'cleanup.clearCancelled': 'Borrado cancelado.',
  'cleanup.clearFailed': 'No se pudo borrar la sesión {sessionId}: {detail}.',
  'cleanup.usage': 'Uso:\n  /snapshot-auto-cleanup                 mostrar estado\n  /snapshot-auto-cleanup on|off          activar/desactivar la limpieza automática\n  /snapshot-auto-cleanup max-age <días>  definir el umbral de inactividad\n  /snapshot-auto-cleanup run [--apply]   simular, o ejecutar con --apply\n  /snapshot-auto-cleanup run --current [--apply]   simular/borrar las instantáneas de esta sesión',
}

/** French dictionary, checked complete against the en key set. */
export const fr: Record<HostKey, string> = {
  'plan.skip': '  non restauré : {path} ({reason})',
  'skipReason.oversized': 'dépasse la limite de {limit} sauvegardes : l’état enregistré précède les modifications non suivies',
  'error.invalidTarget': 'Impossible d’analyser la cible « {raw} » (attendu : <index> ou @<seq>)',
  'sep.list': ', ',
  'sep.clause': ' ; ',
  'failures.suffix': ' ; échec de la restauration de {count} fichier(s) : {list}',
  'failures.item': '{path} ({message})',
  'inflight': 'Un rembobinage est déjà en cours pour cette session ; veuillez patienter.',
  'stopFailed': 'Impossible d’arrêter l’agent en cours ; rembobinage annulé. Veuillez réessayer.',
  'cancelled': 'Rembobinage annulé.',
  'failed': 'Échec du rembobinage : {error}. La session est inchangée.',
  'restore.count': '{count} fichier(s) restauré(s)',
  'delete.count': '{count} fichier(s) supprimé(s)',
  'skip.count': '{count} chemin(s) ignoré(s)',
  'noRestorable': ' ; aucune modification d’écriture restaurable après la cible',
  'backupOff': 'les sauvegardes d’instantanés sont désactivées, la restauration peut être incomplète',
  'storeUnsupported': 'restauration de fichiers indisponible : ces instantanés utilisent un format de stockage plus récent (v{version}) que celui compris par ce plugin ; rien n’a été modifié. Mettez à jour le plugin ou effacez les instantanés de cette session.',
  'success': 'Retiré seq {targetSeq} et tout ce qui suit (conversation revenue à un point antérieur){restore}.',
  'noUserMessages': 'Cette session n’a pas encore de messages utilisateur vers lesquels rembobiner.',
  'command.description': 'Rembobiner la conversation et/ou les fichiers à un point antérieur',
  'command.undoDescription': 'Alias de /rewind',
  'engine.description': 'Commande interne de dsh-rewind',
  'engine.rejected': 'Commande interne : utilisez /rewind ou /undo.',
  'engine.inputHint': '@<seq> chat|both',
  'cleanup.description': 'Gérer le nettoyage automatique des sauvegardes d’instantanés de session',
  'cleanup.inputHint': 'on | off | max-age <jours> | run [--apply] [--current]',
  'cleanup.status': 'Nettoyage automatique : {state}. Ancienneté max. : {days} jour(s).',
  'cleanup.enabled': 'activé',
  'cleanup.disabled': 'désactivé',
  'cleanup.onOk': 'Nettoyage automatique activé.',
  'cleanup.offOk': 'Nettoyage automatique désactivé — tous les instantanés sont conservés.',
  'cleanup.maxAgeOk': 'Ancienneté maximale du nettoyage automatique : {days} jour(s).',
  'cleanup.cfgInvalid': 'Configuration de nettoyage des instantanés non valide : {detail}. Rien n’a été exécuté ; utilisez « on|off|max-age » pour réinitialiser la configuration.',
  'cleanup.saveFailed': 'Impossible d’enregistrer la configuration de nettoyage : {detail}.',
  'cleanup.runDry': 'Simulation : supprimerait {deleted} sauvegarde(s) d’instantanés de session et libérerait {freed} octets. Relancez avec --apply pour supprimer.',
  'cleanup.runApply': 'Suppression de {deleted} sauvegarde(s) d’instantanés de session, libération de {freed} octets ; {kept} conservée(s), {remaining} octets restants.',
  'cleanup.runFailed': 'Échec du nettoyage : {detail}.',
  'cleanup.skipped': '({skipped} session(s) active(s) ignorée(s).)',
  'cleanup.clearDry': 'Simulation : effacerait {entries} instantané(s) de la session courante et libérerait {bytes} octets. Relancez avec --apply pour supprimer.',
  'cleanup.clearApply': 'Suppression de {entries} instantané(s) de la session courante, libération de {bytes} octets. Cette session enregistre désormais de nouveaux instantanés à partir de son état actuel.',
  'cleanup.clearActive': 'Impossible d’effacer la session {sessionId} : elle est toujours en cours et n’a pas pu être arrêtée. Réessayez une fois qu’elle est inactive.',
  'cleanup.clearCancelled': 'Effacement annulé.',
  'cleanup.clearFailed': 'Impossible d’effacer la session {sessionId} : {detail}.',
  'cleanup.usage': 'Utilisation :\n  /snapshot-auto-cleanup                 afficher l’état\n  /snapshot-auto-cleanup on|off          activer/désactiver le nettoyage automatique\n  /snapshot-auto-cleanup max-age <jours>  définir le seuil d’inactivité\n  /snapshot-auto-cleanup run [--apply]   simuler, ou exécuter avec --apply\n  /snapshot-auto-cleanup run --current [--apply]   simuler/effacer les instantanés de cette session',
}

/** German dictionary, checked complete against the en key set. */
export const de: Record<HostKey, string> = {
  'plan.skip': '  nicht wiederhergestellt: {path} ({reason})',
  'skipReason.oversized': 'über dem Sicherungslimit von {limit}, daher stammt der aufgezeichnete Stand von vor nicht erfassten Änderungen',
  'error.invalidTarget': 'Ziel "{raw}" kann nicht verarbeitet werden (erwartet: <index> oder @<seq>)',
  'sep.list': ', ',
  'sep.clause': '; ',
  'failures.suffix': '; {count} Datei(en) konnten nicht wiederhergestellt werden: {list}',
  'failures.item': '{path} ({message})',
  'inflight': 'Für diese Sitzung läuft bereits ein Zurückspulen; bitte warten.',
  'stopFailed': 'Der laufende Agent konnte nicht gestoppt werden; Zurückspulen abgebrochen. Bitte erneut versuchen.',
  'cancelled': 'Zurückspulen abgebrochen.',
  'failed': 'Zurückspulen fehlgeschlagen: {error}. Die Sitzung ist unverändert.',
  'restore.count': '{count} Datei(en) wiederhergestellt',
  'delete.count': '{count} Datei(en) gelöscht',
  'skip.count': '{count} Pfad(e) übersprungen',
  'noRestorable': '; keine wiederherstellbaren Schreibänderungen nach dem Ziel',
  'backupOff': 'Snapshot-Sicherungen sind deaktiviert, die Wiederherstellung kann unvollständig sein',
  'storeUnsupported': 'Dateiwiederherstellung nicht verfügbar: Diese Snapshots nutzen ein neueres Speicherformat (v{version}), als dieses Plugin versteht; es wurde nichts geändert. Aktualisieren Sie das Plugin oder löschen Sie die Snapshots dieser Sitzung.',
  'success': 'seq {targetSeq} und alles danach zurückgezogen (Unterhaltung auf einen früheren Stand zurückgesetzt){restore}.',
  'noUserMessages': 'Diese Sitzung hat noch keine Benutzernachrichten, zu denen zurückgespult werden kann.',
  'command.description': 'Unterhaltung und/oder Dateien auf einen früheren Stand zurückspulen',
  'command.undoDescription': 'Alias von /rewind',
  'engine.description': 'Interner Befehl von dsh-rewind',
  'engine.rejected': 'Interner Befehl: Verwenden Sie /rewind oder /undo.',
  'engine.inputHint': '@<seq> chat|both',
  'cleanup.description': 'Automatische Bereinigung der Snapshot-Sicherungen von Sitzungen verwalten',
  'cleanup.inputHint': 'on | off | max-age <Tage> | run [--apply] [--current]',
  'cleanup.status': 'Automatische Bereinigung: {state}. Max. Alter: {days} Tag(e).',
  'cleanup.enabled': 'aktiviert',
  'cleanup.disabled': 'deaktiviert',
  'cleanup.onOk': 'Automatische Bereinigung aktiviert.',
  'cleanup.offOk': 'Automatische Bereinigung deaktiviert — alle Snapshots bleiben erhalten.',
  'cleanup.maxAgeOk': 'Maximales Alter der automatischen Bereinigung: {days} Tag(e).',
  'cleanup.cfgInvalid': 'Konfiguration der Snapshot-Bereinigung ungültig: {detail}. Es wurde nichts ausgeführt; setzen Sie die Konfiguration mit "on|off|max-age" zurück.',
  'cleanup.saveFailed': 'Bereinigungskonfiguration konnte nicht gespeichert werden: {detail}.',
  'cleanup.runDry': 'Testlauf: würde {deleted} Snapshot-Sicherung(en) von Sitzungen entfernen und {freed} Bytes freigeben. Erneut mit --apply ausführen, um zu löschen.',
  'cleanup.runApply': '{deleted} Snapshot-Sicherung(en) von Sitzungen entfernt, {freed} Bytes freigegeben; {kept} behalten, {remaining} Bytes verbleiben.',
  'cleanup.runFailed': 'Bereinigung fehlgeschlagen: {detail}.',
  'cleanup.skipped': '({skipped} aktive Sitzung(en) übersprungen.)',
  'cleanup.clearDry': 'Testlauf: würde {entries} Snapshot(s) der aktuellen Sitzung löschen und {bytes} Bytes freigeben. Erneut mit --apply ausführen, um zu löschen.',
  'cleanup.clearApply': '{entries} Snapshot(s) der aktuellen Sitzung gelöscht, {bytes} Bytes freigegeben. Diese Sitzung zeichnet Snapshots jetzt neu ab ihrem aktuellen Stand auf.',
  'cleanup.clearActive': 'Sitzung {sessionId} konnte nicht gelöscht werden: sie läuft noch und konnte nicht gestoppt werden. Versuchen Sie es erneut, wenn sie inaktiv ist.',
  'cleanup.clearCancelled': 'Löschen abgebrochen.',
  'cleanup.clearFailed': 'Sitzung {sessionId} konnte nicht gelöscht werden: {detail}.',
  'cleanup.usage': 'Aufruf:\n  /snapshot-auto-cleanup                 Status anzeigen\n  /snapshot-auto-cleanup on|off          automatische Bereinigung aktivieren/deaktivieren\n  /snapshot-auto-cleanup max-age <Tage>  Inaktivitätsschwelle festlegen\n  /snapshot-auto-cleanup run [--apply]   Testlauf oder mit --apply ausführen\n  /snapshot-auto-cleanup run --current [--apply]   Testlauf/Snapshots dieser Sitzung löschen',
}

/** Russian dictionary, checked complete against the en key set. */
export const ru: Record<HostKey, string> = {
  'plan.skip': '  не восстановлено: {path} ({reason})',
  'skipReason.oversized': 'превышен предел резервных копий {limit}, поэтому записанное состояние предшествует неотслеживаемым изменениям',
  'error.invalidTarget': 'Не удалось разобрать цель "{raw}" (ожидается <index> или @<seq>)',
  'sep.list': ', ',
  'sep.clause': '; ',
  'failures.suffix': '; {count} файл(ов) не удалось восстановить: {list}',
  'failures.item': '{path} ({message})',
  'inflight': 'Для этого сеанса уже выполняется откат; подождите.',
  'stopFailed': 'Не удалось остановить работающий агент; откат отменён. Повторите попытку.',
  'cancelled': 'Откат отменён.',
  'failed': 'Не удалось выполнить откат: {error}. Сеанс не изменён.',
  'restore.count': 'восстановлено файлов: {count}',
  'delete.count': 'удалено файлов: {count}',
  'skip.count': 'пропущено путей: {count}',
  'noRestorable': '; после цели нет восстановимых изменений записи',
  'backupOff': 'резервные копии снимков отключены, восстановление может быть неполным',
  'storeUnsupported': 'восстановление файлов недоступно: эти снимки используют более новый формат хранилища (v{version}), чем понимает этот плагин; ничего не изменено. Обновите плагин или очистите снимки этого сеанса.',
  'success': 'Отозвано seq {targetSeq} и всё после него (беседа возвращена к более раннему состоянию){restore}.',
  'noUserMessages': 'В этом сеансе пока нет сообщений пользователя для отката.',
  'command.description': 'Откатить беседу и/или файлы к более раннему состоянию',
  'command.undoDescription': 'Псевдоним /rewind',
  'engine.description': 'Внутренняя команда dsh-rewind',
  'engine.rejected': 'Внутренняя команда: используйте /rewind или /undo.',
  'engine.inputHint': '@<seq> chat|both',
  'cleanup.description': 'Управление автоматической очисткой резервных копий снимков сеансов',
  'cleanup.inputHint': 'on | off | max-age <дней> | run [--apply] [--current]',
  'cleanup.status': 'Автоочистка: {state}. Макс. возраст: {days} дн.',
  'cleanup.enabled': 'включена',
  'cleanup.disabled': 'отключена',
  'cleanup.onOk': 'Автоочистка включена.',
  'cleanup.offOk': 'Автоочистка отключена — все снимки сохранены.',
  'cleanup.maxAgeOk': 'Максимальный возраст автоочистки: {days} дн.',
  'cleanup.cfgInvalid': 'Недопустимая конфигурация очистки снимков: {detail}. Ничего не выполнено; сбросьте конфигурацию с помощью "on|off|max-age".',
  'cleanup.saveFailed': 'Не удалось сохранить конфигурацию очистки: {detail}.',
  'cleanup.runDry': 'Пробный запуск: удалит резервные копии снимков сеансов ({deleted}), освободив {freed} байт. Запустите с --apply, чтобы удалить.',
  'cleanup.runApply': 'Удалены резервные копии снимков сеансов ({deleted}), освобождено {freed} байт; сохранено {kept}, осталось {remaining} байт.',
  'cleanup.runFailed': 'Ошибка очистки: {detail}.',
  'cleanup.skipped': '({skipped} активных сеансов пропущено.)',
  'cleanup.clearDry': 'Пробный запуск: очистит снимки текущего сеанса ({entries}), освободив {bytes} байт. Запустите с --apply, чтобы удалить.',
  'cleanup.clearApply': 'Очищены снимки текущего сеанса ({entries}), освобождено {bytes} байт. Теперь сеанс записывает снимки заново от текущего состояния.',
  'cleanup.clearActive': 'Не удалось очистить сеанс {sessionId}: он всё ещё выполняется и не был остановлен. Повторите попытку, когда он освободится.',
  'cleanup.clearCancelled': 'Очистка отменена.',
  'cleanup.clearFailed': 'Не удалось очистить сеанс {sessionId}: {detail}.',
  'cleanup.usage': 'Использование:\n  /snapshot-auto-cleanup                 показать состояние\n  /snapshot-auto-cleanup on|off          включить/отключить автоочистку\n  /snapshot-auto-cleanup max-age <дней>  задать порог неактивности\n  /snapshot-auto-cleanup run [--apply]   пробный запуск или выполнение с --apply\n  /snapshot-auto-cleanup run --current [--apply]   пробный запуск/очистка снимков этого сеанса',
}

/** Brazilian Portuguese dictionary, checked complete against the en key set. */
export const pt: Record<HostKey, string> = {
  'plan.skip': '  não restaurado: {path} ({reason})',
  'skipReason.oversized': 'acima do limite de {limit} backups, então o estado registrado é anterior a alterações não rastreadas',
  'error.invalidTarget': 'Não foi possível interpretar o destino "{raw}" (esperado <index> ou @<seq>)',
  'sep.list': ', ',
  'sep.clause': '; ',
  'failures.suffix': '; falha ao restaurar {count} arquivo(s): {list}',
  'failures.item': '{path} ({message})',
  'inflight': 'Já há um rebobinamento em andamento para esta sessão; aguarde.',
  'stopFailed': 'Não foi possível parar o agente em execução; rebobinamento cancelado. Tente novamente.',
  'cancelled': 'Rebobinamento cancelado.',
  'failed': 'Falha no rebobinamento: {error}. A sessão não foi alterada.',
  'restore.count': '{count} arquivo(s) restaurado(s)',
  'delete.count': '{count} arquivo(s) excluído(s)',
  'skip.count': '{count} caminho(s) ignorado(s)',
  'noRestorable': '; nenhuma alteração de gravação restaurável após o destino',
  'backupOff': 'os backups de snapshots estão desativados, a restauração pode ficar incompleta',
  'storeUnsupported': 'restauração de arquivos indisponível: estes snapshots usam um formato de armazenamento mais novo (v{version}) do que este plugin entende; nada foi alterado. Atualize o plugin ou limpe os snapshots desta sessão.',
  'success': 'Retirado seq {targetSeq} e tudo depois dele (conversa retornada a um ponto anterior){restore}.',
  'noUserMessages': 'Esta sessão ainda não tem mensagens de usuário para rebobinar.',
  'command.description': 'Rebobinar a conversa e/ou os arquivos para um ponto anterior',
  'command.undoDescription': 'Alias de /rewind',
  'engine.description': 'Comando interno do dsh-rewind',
  'engine.rejected': 'Comando interno: use /rewind ou /undo.',
  'engine.inputHint': '@<seq> chat|both',
  'cleanup.description': 'Gerenciar a limpeza automática dos backups de snapshots de sessão',
  'cleanup.inputHint': 'on | off | max-age <dias> | run [--apply] [--current]',
  'cleanup.status': 'Limpeza automática: {state}. Idade máxima: {days} dia(s).',
  'cleanup.enabled': 'ativada',
  'cleanup.disabled': 'desativada',
  'cleanup.onOk': 'Limpeza automática ativada.',
  'cleanup.offOk': 'Limpeza automática desativada — todos os snapshots são mantidos.',
  'cleanup.maxAgeOk': 'Idade máxima da limpeza automática: {days} dia(s).',
  'cleanup.cfgInvalid': 'Configuração de limpeza de snapshots inválida: {detail}. Nada foi executado; use "on|off|max-age" para redefinir a configuração.',
  'cleanup.saveFailed': 'Não foi possível salvar a configuração de limpeza: {detail}.',
  'cleanup.runDry': 'Simulação: removeria {deleted} backup(s) de snapshots de sessão, liberando {freed} bytes. Execute novamente com --apply para excluir.',
  'cleanup.runApply': 'Removidos {deleted} backup(s) de snapshots de sessão, liberando {freed} bytes; {kept} mantido(s), restam {remaining} bytes.',
  'cleanup.runFailed': 'Falha na limpeza: {detail}.',
  'cleanup.skipped': '({skipped} sessão(ões) ativa(s) ignorada(s).)',
  'cleanup.clearDry': 'Simulação: limparia {entries} snapshot(s) da sessão atual, liberando {bytes} bytes. Execute novamente com --apply para excluir.',
  'cleanup.clearApply': 'Limpados {entries} snapshot(s) da sessão atual, liberando {bytes} bytes. Esta sessão agora registra snapshots novos a partir do estado atual.',
  'cleanup.clearActive': 'Não foi possível limpar a sessão {sessionId}: ela ainda está em execução e não pôde ser parada. Tente novamente quando estiver ociosa.',
  'cleanup.clearCancelled': 'Limpeza cancelada.',
  'cleanup.clearFailed': 'Não foi possível limpar a sessão {sessionId}: {detail}.',
  'cleanup.usage': 'Uso:\n  /snapshot-auto-cleanup                 mostrar status\n  /snapshot-auto-cleanup on|off          ativar/desativar a limpeza automática\n  /snapshot-auto-cleanup max-age <dias>  definir o limite de inatividade\n  /snapshot-auto-cleanup run [--apply]   simular, ou executar com --apply\n  /snapshot-auto-cleanup run --current [--apply]   simular/limpar os snapshots desta sessão',
}

/**
 * Every language this plugin ships a host dictionary for. English is first as
 * the canonical dictionary; the rest follow the harness's language order.
 * Adding a language is one dictionary above plus one entry here — the locale-id
 * type, the preference resolver, and the tests all derive from this map.
 */
export const HOST_DICTS = { en, zh, ja, es, fr, de, ru, pt } satisfies Record<string, Record<HostKey, string>>

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
