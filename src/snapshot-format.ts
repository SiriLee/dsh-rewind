/**
 * On-disk store format — the single source of truth for what a snapshot
 * directory looks like.
 *
 * Everything here is stateless and independent of the file-system service:
 * the naming functions, the entry/journal JSON codecs, and the ref validators
 * that keep a hostile or corrupt record inside the store. The byte format
 * itself is specified in `docs/format.md`; the fail-closed store-version
 * contract is enforced by `readEntry` here and by
 * `SnapshotStore.assertKnownStoreVersion` in `snapshot.ts`.
 *
 * @module dsh-rewind/snapshot-format
 */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename, dirname, join, relative, sep } from 'node:path'

/** Suffix of the raw byte copy holding one entry's before-content. */
export const SIDECAR_SUFFIX = '.before'

/** Session-dir sub-directory holding captures that are staged but not committed. */
export const PENDING_DIR = '.pending'

/** Session-dir sub-directory holding one pre-restore ("rescue") copy per op. */
export const RESCUE_DIR = 'rescue'

/** Journal-file prefix of the current format. */
export const JOURNAL_PREFIX = 'journal-'

/** Journal-file prefix written by the released v1 build (read-only compatibility). */
export const LEGACY_JOURNAL_PREFIX = 'restore-journal-'

/** The Unicode replacement character a lossy UTF-8 decode produces. */
const REPLACEMENT_CHAR = '\uFFFD'

/**
 * Current on-disk store format version (the session's `store` marker value and
 * the `store` field of every entry this build writes). A value ABOVE this one
 * means the snapshots were written by a NEWER build: readers must then fail
 * closed (no file restore, nothing changed) instead of guessing what the extra
 * fields mean. A missing marker (or `1`) means the released v1 string format,
 * which is still read.
 */
export const CURRENT_STORE_VERSION = 2

/**
 * Thrown when snapshots carry a store format newer than this build understands
 * (ADR-10: whole-operation fail-closed — never a partial restore, never a
 * clear). The session rewind itself does not depend on snapshots and still
 * works.
 */
export class UnknownStoreVersionError extends Error {
  constructor(
    /** The version found on disk. */
    readonly version: number,
    /** Where it was found (a marker or an entry file). */
    readonly source: string,
  ) {
    super(`snapshot store version ${version} is newer than this plugin understands (${source})`)
    this.name = 'UnknownStoreVersionError'
  }
}

/**
 * Recorded before-content — always bytes, never a decoded string:
 *
 * - `blob`: a raw byte copy inside the store (the format every new write uses).
 * - `text`: the exact UTF-8 bytes of a released-v1 string record (a v1 record
 *   that was decoded from valid UTF-8 is byte-exact, so restoring it is safe).
 * - `lossyText`: a released-v1 string record that contains U+FFFD, i.e. one
 *   the v1 build produced by a LOSSY decode of non-UTF-8 bytes. The original
 *   bytes are unknowable, so it can be compared against the disk but must
 *   never be written back as a restore target (that would destroy live data).
 */
export type ByteSource =
  | { readonly kind: 'blob'; readonly path: string }
  | { readonly kind: 'text'; readonly bytes: Buffer }
  | { readonly kind: 'lossyText'; readonly text: string }

/** Classify a released-v1 string record (U+FFFD means the decode lost bytes). */
export function textSourceOf(text: string): ByteSource {
  return text.includes(REPLACEMENT_CHAR)
    ? { kind: 'lossyText', text }
    : { kind: 'text', bytes: Buffer.from(text, 'utf8') }
}

/** A staged raw byte copy waiting to be committed (`recordBackup`). */
export interface PendingBackup {
  /** Absolute path of the staged file (inside the session's `.pending/`). */
  readonly file: string
  /** Byte size of the staged content. */
  readonly size: number
  /**
   * Permission bits of the source file (`stat().mode & 0o7777`), captured
   * best-effort. Restored alongside the content — never on its own, and never
   * as part of the change decision (ADR-9).
   */
  readonly mode?: number
}

/** One committed before-backup, keyed by tool call. */
export interface CheckpointEntry {
  readonly callId: string
  /** Seq of the user message anchoring the turn in which the change happened. */
  readonly anchorSeq: number
  /** Resolved display path (absolute) of the tracked file. */
  readonly path: string
  /** Byte source of the content before the change; null when the file was created. */
  readonly before: ByteSource | null
  /** Byte size of `before` (0 when the file was created). */
  readonly size: number
  /**
   * Checkpoint-time location pin: where `dirname(path)` resolved when the entry
   * was captured — or, when that directory was already gone, where it would
   * have resolved (nearest surviving ancestor plus the missing segments). A
   * restore refuses the path when its parent directory no longer resolves there,
   * because a repointed or moved ancestor would otherwise redirect the write
   * (or the unlink) outside the recorded location; the path's FINAL component is
   * checked separately (see {@link isUnsafeTarget}). Absent means "no pin": a
   * released-v1 entry or a legacy v2 entry, whose restore falls back to the
   * final-component check alone.
   */
  readonly parent?: string
  /**
   * Permission bits recorded at capture time, when known. Applied only when
   * the CONTENT is restored (a mode-only difference is never a reason to plan
   * a restore); a missing value means "leave the live mode alone".
   */
  readonly mode?: number
  /**
   * Set when this entry's sidecar holds re-encoded LOSSY text (a released-v1
   * record that was decoded with replacement characters, e.g. after `prune`
   * materialized its link). The bytes are comparable but must never be written
   * back: a reader turns such an entry into a `lossyText` source again.
   */
  readonly lossy?: boolean
  /** Epoch ms the entry was committed (stable ordering within a group). */
  readonly time: number
  /**
   * Absolute file this entry was READ from (in-memory only, never serialized):
   * a dedup reference must name the file that actually exists, which for an
   * entry written by an older build is not necessarily the name the current
   * naming function would produce.
   */
  readonly file?: string
}

/**
 * One in-place dedup link, keyed by tool call. When a tracked file is
 * recorded with a `before` content identical to the immediately-prior entry
 * for that path, the entry is stored as a LINK instead of a full copy: it
 * carries no content, only a `ref` naming the prior entry file
 * (`<anchorSeq>/<callId>.json`). The linear (predecessor-chained) ref makes
 * restore resolution and prune materialization rewrite-free.
 */
export interface LinkEntry {
  readonly callId: string
  readonly anchorSeq: number
  readonly path: string
  /** `<anchorSeq>/<callId>.json` of the immediately-prior entry for the path. */
  readonly ref: string
  /**
   * Checkpoint-time location pin (see {@link CheckpointEntry.parent}); a link
   * records its own, so a materialized or resolved entry never loses the
   * location the path was committed under.
   */
  readonly parent?: string
  readonly time: number
  /** Absolute file this link was read from (in-memory only, never serialized). */
  readonly file?: string
}

/** Any on-disk entry: a full before-backup or an in-place dedup link. */
export type StoredEntry = CheckpointEntry | LinkEntry

/** True when an entry is a dedup link (carries `ref`, not `before`). */
export function isLinkEntry(entry: StoredEntry): entry is LinkEntry {
  return 'ref' in entry
}

/** Per-file restore impact preview (served by the host preview route). */
export interface FileImpact {
  readonly path: string
  /** `restore` = write the before content back; `delete` = remove the file. */
  readonly action: 'restore' | 'delete'
}

/** A recorded path whose current on-disk size is over the backup cap. */
export interface UncoveredPath {
  readonly path: string
  /** Byte size observed on disk, when the probe could read one. */
  readonly size?: number
}

/** Outcome of one restore pass. */
export interface RestoreOutcome {
  readonly restored: readonly string[]
  readonly deleted: readonly string[]
  /** Symlinked or hard-linked paths left untouched. */
  readonly skipped: readonly string[]
  readonly failed: readonly { path: string; message: string }[]
}

/** Deletes one file by its real path (node:fs, bypassing the fs service). */
export type DeleteFile = (path: string) => Promise<void>

/**
 * Test-only fault injection: a crash point inside the write/restore paths.
 * The hook THROWS to simulate a host crash at the exact point; the throw
 * propagates out of the store method, leaving the journal on disk in its
 * current state. Production callers never pass it (undefined = no-op).
 */
export type CrashPoint = 'before-action' | 'after-action' | 'after-temp-write'

/** Options for the journaled restore paths; `crash` is the test-only seam. */
export interface RestoreRunOptions {
  /**
   * Throws at the given point to simulate a host crash: `before-action`
   * (before an action's fs op), `after-action` (right after the fs op,
   * before its done-mark is persisted), `after-temp-write` (inside an atomic
   * commit, between the temp write and the rename). `index` is the action
   * index for the restore loops.
   */
  readonly crash?: (point: CrashPoint, index?: number) => void
}

/**
 * Lifecycle of one restore operation journal. Terminal states are kept on
 * disk as a tiny audit trail and skipped by reconciliation.
 */
export type RestoreJournalState = 'running' | 'rollback-running' | 'completed' | 'rolled-back' | 'recovery-required'

/**
 * One journaled restore action — a mutable working record that the restore
 * loop updates (done/failed) as it applies the pass.
 */
export interface RestoreJournalAction {
  readonly path: string
  readonly action: 'restore' | 'delete'
  /** Target content for a restore; null for a delete. */
  readonly before: ByteSource | null
  /**
   * Pre-restore disk state ("rescue"): a raw byte copy of what the file had
   * right before the restore started, or null when it was absent. Rollback
   * writes this back, so the pre-restore state is recoverable exactly.
   */
  readonly rescue: ByteSource | null
  /** Set when the rescue capture failed: rollback then skips this path. */
  rescueError?: string
  /** Permission bits the restored content should end up with, when recorded. */
  readonly mode?: number
  /**
   * Checkpoint-time location pin copied from the entry the action was planned
   * from (see {@link CheckpointEntry.parent}): a continue or rollback after a
   * restart re-checks it before touching the path.
   */
  readonly parent?: string
  /** Permission bits the file had BEFORE the restore, for a faithful rollback. */
  readonly rescueMode?: number
  /** True once the action's fs op completed and was marked. */
  done: boolean
  /** Per-action failure message; the restore pass never aborts. */
  failed?: string
}

/** Durable journal for one attempted restore (written atomically). */
export interface RestoreJournal {
  /** On-disk schema version: 2 = byte references, 1 = inline legacy strings. */
  readonly version: 1 | 2
  readonly id: string
  readonly sessionId: string
  readonly targetSeq: number
  readonly startedAt: number
  finishedAt?: number
  state: RestoreJournalState
  readonly actions: RestoreJournalAction[]
  /** Set when a rollback pass failed partway (state becomes `recovery-required`). */
  rollbackError?: string
  /**
   * Absolute file this journal was read from (in-memory only, never
   * serialized): a legacy `restore-journal-` file is updated IN PLACE so an
   * op that was interrupted before the upgrade never ends up with two
   * divergent versions on disk.
   */
  sourceFile?: string
}

/**
 * Result of reconciling one interrupted restore journal against the real
 * disk. Path status is relative to the op's current goal: the restore target
 * for `running` journals, the pre-restore (rescue) state for
 * `rollback-running` / `recovery-required` journals — disambiguate with
 * {@link RestoreReconcileReport.journalState}.
 */
export interface RestoreReconcileReport {
  readonly opId: string
  /** `interrupted` = a crash left the op unfinished; `recovery-required` = a rollback could not complete. */
  readonly state: 'interrupted' | 'recovery-required'
  /** Raw journal state (`running` | `rollback-running` | `recovery-required`). */
  readonly journalState: RestoreJournalState
  readonly targetSeq: number
  readonly startedAt: number
  /** Paths whose disk already matches the op's goal. */
  readonly restored: readonly string[]
  /** Paths still short of the op's goal (not yet applied / not yet rolled back). */
  readonly pending: readonly string[]
  /** Actions that failed during the pass (kept failed until a redo succeeds). */
  readonly failed: readonly { path: string; message: string }[]
  readonly rollbackError?: string
  /** Set when the journal file itself is corrupt: it cannot be reconciled. */
  readonly corrupt?: string
}

/**
 * Current-on-disk state probe used by restore planning and reconciliation.
 * Injected so the logic runs against a fake FS in tests; the production
 * default reads the real file system with plain `node:fs` (see
 * {@link defaultProbe}) and compares byte streams, never whole files in memory.
 */
export interface DiskProbe {
  /**
   * Compare the recorded content with the file currently at `path`.
   *
   * - `true`  = the disk matches the record byte-for-byte (for a `null`
   *   source: the path is absent).
   * - `false` = it differs — including "the record says the file did not
   *   exist but it does" and "the record has content but the file is gone".
   * - `undefined` = the comparison could not be decided (IO/permission
   *   failure). Callers stay conservative: a restore is still attempted and a
   *   delete still attempted, so an unreadable file is never silently skipped.
   *
   * A `lossyText` source is compared with the same lossy decode the released
   * v1 build used (its original bytes cannot be recovered).
   */
  matches(source: ByteSource | null, path: string): Promise<boolean | undefined>
  /**
   * Stage a raw byte copy of the file at `path` into `dest` (the store's
   * rescue area) without loading it into memory.
   */
  copy(path: string, dest: string): Promise<CopyOutcome>
  /**
   * Byte size of the regular file at `path`, or `undefined` when absent or
   * unreadable. Consulted before any content comparison so an over-cap file is
   * skipped without being read. Optional; a missing accessor reads as "size
   * unknown", which never counts as "too big".
   */
  size?(path: string): Promise<number | undefined>
  /**
   * True when the path's final component is not a single regular file: a
   * symlink, a hard link (`nlink > 1`), a directory, a FIFO or a device. The
   * planner and the apply pass both refuse one — a link redirects the write,
   * a hard link shares the inode with other names, and a FIFO or device is
   * neither restorable nor safe to open.
   */
  isUnsafeTarget(path: string): Promise<boolean>
}

/** Result of staging one on-disk byte copy. */
export type CopyOutcome =
  | { readonly kind: 'copied'; readonly size: number }
  | { readonly kind: 'absent' }
  | { readonly kind: 'failed'; readonly message: string }

/** One restore action the planner derived from record + disk reconciliation. */
export type PlannedAction =
  | { readonly path: string; readonly action: 'restore'; readonly before: ByteSource; readonly mode?: number; readonly parent?: string }
  | { readonly path: string; readonly action: 'delete'; readonly parent?: string }

/** Sanitize a call id into a safe file name. */
export function safeFileId(callId: string): string {
  return callId.replace(/[^a-zA-Z0-9._-]/g, '_')
}

/**
 * Sanitize a session id into a safe path segment. Real ids are harness-minted
 * UUIDs (a no-op here), but a hostile or malformed id must never traverse out
 * of the snapshot root — `.` and `..` are the only bare values the charset
 * permits that would alias the root or its parent.
 */
export function safeSessionId(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9._-]/g, '_')
  return safe === '..' || safe === '.' ? 'session' : safe
}

const RESTORE_JOURNAL_STATES = new Set<RestoreJournalState>(['running', 'rollback-running', 'completed', 'rolled-back', 'recovery-required'])

/** True when a serialized journal reference has a readable shape. */
function isRawJournalRef(value: unknown): boolean {
  if (value === null) return true
  if (typeof value === 'string') return true
  if (typeof value !== 'object') return false
  const ref = value as Record<string, unknown>
  return typeof ref.blob === 'string' || typeof ref.text === 'string'
}

/**
 * Structural validation of a parsed journal. Unlike checkpoint entries (whose
 * corruption is silently skipped), a corrupt journal is reported
 * fail-loud by `reconcileRestores` — silently dropping it would silently
 * erase the ability to recover the interrupted restore.
 *
 * Accepts both formats: `version: 2` (byte references), the released
 * `version: 1` (inline strings) and the legacy prefix that carried no
 * `version` at all — but never best-effort-coerces a malformed action.
 */
export function isRestoreJournal(value: unknown): value is RestoreJournal {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (typeof v.id !== 'string' || typeof v.sessionId !== 'string' || typeof v.targetSeq !== 'number') return false
  if (v.version !== undefined && v.version !== 1 && v.version !== 2) return false
  if (typeof v.state !== 'string' || !RESTORE_JOURNAL_STATES.has(v.state as RestoreJournalState)) return false
  if (!Array.isArray(v.actions)) return false
  return v.actions.every(action => {
    if (typeof action !== 'object' || action === null) return false
    const a = action as Record<string, unknown>
    if (typeof a.path !== 'string' || (a.action !== 'restore' && a.action !== 'delete')) return false
    if (typeof a.done !== 'boolean') return false
    if (!isRawJournalRef(a.before) || !isRawJournalRef(a.rescue)) return false
    // A restore action must carry target content; a delete must not.
    if (a.action === 'restore' && a.before === null) return false
    return true
  })
}

/** Convert one serialized journal reference into an in-memory byte source. */
function refToSource(raw: unknown, sessionDir: string): ByteSource | null | undefined {
  if (raw === null) return null
  if (typeof raw === 'string') return textSourceOf(raw)
  if (typeof raw !== 'object') return undefined
  const ref = raw as Record<string, unknown>
  if (typeof ref.blob === 'string') {
    if (!isSafeBackupRef(ref.blob)) return undefined
    return { kind: 'blob', path: join(sessionDir, ref.blob) }
  }
  if (typeof ref.text === 'string') return textSourceOf(ref.text)
  return undefined
}

/**
 * Format a store-relative filesystem path as a serialized ref. Refs are always
 * POSIX-separated (`13/call.before`) even on Windows, where `relative()`
 * returns backslashes; the journal and link validators only accept `/`.
 */
export function sessionRelativeRef(sessionDir: string, file: string): string {
  return relative(sessionDir, file).split(sep).join('/')
}

/** Serialize one byte source as a session-relative journal reference. */
function sourceToRef(source: ByteSource | null, sessionDir: string, entryPath: string): unknown {
  if (source === null) return null
  if (source.kind === 'blob') {
    const blob = sessionRelativeRef(sessionDir, source.path)
    if (!isSafeBackupRef(blob)) throw new Error(`unsafe backup ref ${blob} for ${entryPath}`)
    return { blob }
  }
  return { text: source.kind === 'text' ? source.bytes.toString('utf8') : source.text }
}

/** Serialized (on-disk) form of a journal action. */
export function journalToJson(journal: RestoreJournal, sessionDir: string): Record<string, unknown> {
  return {
    version: 2,
    id: journal.id,
    sessionId: journal.sessionId,
    targetSeq: journal.targetSeq,
    startedAt: journal.startedAt,
    ...(journal.finishedAt !== undefined ? { finishedAt: journal.finishedAt } : {}),
    state: journal.state,
    actions: journal.actions.map(action => ({
      path: action.path,
      action: action.action,
      before: sourceToRef(action.before, sessionDir, action.path),
      rescue: sourceToRef(action.rescue, sessionDir, action.path),
      ...(action.rescueError !== undefined ? { rescueError: action.rescueError } : {}),
      ...(action.mode !== undefined ? { mode: action.mode } : {}),
      ...(action.rescueMode !== undefined ? { rescueMode: action.rescueMode } : {}),
      ...(action.parent !== undefined ? { parent: action.parent } : {}),
      done: action.done,
      ...(action.failed !== undefined ? { failed: action.failed } : {}),
    })),
    ...(journal.rollbackError !== undefined ? { rollbackError: journal.rollbackError } : {}),
  }
}

/** Parse a validated journal's raw shape into the in-memory form. */
export function journalFromJson(raw: Record<string, unknown>, sessionDir: string): RestoreJournal | undefined {
  const actions: RestoreJournalAction[] = []
  for (const value of raw.actions as Record<string, unknown>[]) {
    const before = refToSource(value.before, sessionDir)
    const rescue = refToSource(value.rescue, sessionDir)
    if (before === undefined || rescue === undefined) return undefined
    actions.push({
      path: value.path as string,
      action: value.action as 'restore' | 'delete',
      before: value.action === 'delete' ? null : before,
      rescue,
      ...(typeof value.rescueError === 'string' ? { rescueError: value.rescueError } : {}),
      ...(typeof value.mode === 'number' ? { mode: value.mode } : {}),
      ...(typeof value.rescueMode === 'number' ? { rescueMode: value.rescueMode } : {}),
      ...(typeof value.parent === 'string' && value.parent.length > 0 ? { parent: value.parent } : {}),
      done: value.done as boolean,
      ...(typeof value.failed === 'string' ? { failed: value.failed } : {}),
    })
  }
  const version = raw.version === 1 ? 1 : 2
  return {
    version,
    id: raw.id as string,
    sessionId: raw.sessionId as string,
    targetSeq: raw.targetSeq as number,
    startedAt: typeof raw.startedAt === 'number' ? raw.startedAt : 0,
    ...(typeof raw.finishedAt === 'number' ? { finishedAt: raw.finishedAt } : {}),
    state: raw.state as RestoreJournalState,
    actions,
    ...(typeof raw.rollbackError === 'string' ? { rollbackError: raw.rollbackError } : {}),
  }
}

/** True when a session-dir member is a restore journal (either prefix). */
export function isJournalName(name: string): boolean {
  if (!name.endsWith('.json')) return false
  return name.startsWith(JOURNAL_PREFIX) || name.startsWith(LEGACY_JOURNAL_PREFIX)
}

/** The op id encoded in a journal file name. */
export function journalOpIdOf(name: string): string {
  const prefix = name.startsWith(LEGACY_JOURNAL_PREFIX) ? LEGACY_JOURNAL_PREFIX : JOURNAL_PREFIX
  return name.slice(prefix.length, -'.json'.length)
}

/** The entry file name one call id maps to (the single naming function). */
export function entryFileName(callId: string): string {
  // The digest disambiguates call ids that `safeFileId` would collapse onto the
  // same name (`a:b` vs `a_b`). References always name a file explicitly and
  // readers never infer a name, so pre-digest entries keep working.
  return `${safeFileId(callId)}-${shortHash(callId)}.json`
}

/** Stable 8-hex digest of an arbitrary string (ids, paths, capture keys). */
export function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8)
}

/** The sidecar file name of one entry file (`<base>.json` → `<base>.before`). */
export function sidecarName(entryFile: string): string {
  return `${entryFile.slice(0, -'.json'.length)}${SIDECAR_SUFFIX}`
}

/** Anchor seq encoded in a link `ref` (`<anchorSeq>/<file>.json`). */
export function refAnchorOf(ref: string): number {
  const slash = ref.indexOf('/')
  return slash === -1 ? Number.NaN : Number(ref.slice(0, slash))
}

/** Serialize one in-memory entry for disk (the current byte format). */
export function entryToJson(entry: CheckpointEntry): Record<string, unknown> {
  const base = {
    store: 2,
    callId: entry.callId,
    file: entry.path,
    time: entry.time,
    ...(entry.parent !== undefined ? { parent: entry.parent } : {}),
    ...(entry.mode !== undefined ? { mode: entry.mode } : {}),
    ...(entry.lossy === true ? { lossy: true } : {}),
  }
  if (entry.before === null) return { ...base, blob: null, size: 0 }
  if (entry.before.kind !== 'blob') throw new Error(`entry for ${entry.path} is not blob-backed`)
  return { ...base, blob: basename(entry.before.path), size: entry.size }
}

/** Serialize one in-memory dedup link for disk (the current byte format). */
export function linkToJson(link: LinkEntry): Record<string, unknown> {
  return {
    store: 2,
    callId: link.callId,
    file: link.path,
    ref: link.ref,
    time: link.time,
    ...(link.parent !== undefined ? { parent: link.parent } : {}),
  }
}

/**
 * Read one committed entry, or undefined when missing/corrupt. Accepts both
 * formats: the current byte format (`store: 2`, `file`, `blob` + sidecar) and
 * the released v1 format (`anchorSeq` + inline `before` string).
 *
 * The byte format deliberately does NOT carry `anchorSeq` (it equals the
 * parent directory) and does NOT reuse the v1 key names — a downgraded v1
 * build rejects such an entry instead of reading it as "created", which is
 * what keeps a downgrade from deleting workspace files. See
 * `tests/downgrade-safety.test.ts`.
 */
export async function readEntry(file: string, anchorSeq: number): Promise<StoredEntry | undefined> {
  let parsed: Record<string, unknown>
  try {
    const value: unknown = JSON.parse(await readFile(file, 'utf8'))
    if (typeof value !== 'object' || value === null) return undefined
    parsed = value as Record<string, unknown>
  } catch {
    return undefined
  }
  // A newer format is NOT "no entry": refusing to guess keeps the caller from
  // planning anything against a shape it does not understand (fail-closed).
  if (typeof parsed.store === 'number' && parsed.store > CURRENT_STORE_VERSION) {
    throw new UnknownStoreVersionError(parsed.store, file)
  }
  const callId = String(parsed.callId ?? '')
  const time = typeof parsed.time === 'number' ? parsed.time : 0
  const origin = { file }
  if (parsed.store === 2) {
    if (typeof parsed.file !== 'string') return undefined
    // Optional metadata: a malformed pin is ignored (the path falls back to the
    // final-component check), never treated as corruption.
    const parent = typeof parsed.parent === 'string' && parsed.parent.length > 0 ? parsed.parent : undefined
    const base = { callId, anchorSeq, path: parsed.file, time, ...(parent !== undefined ? { parent } : {}), ...origin }
    if (typeof parsed.ref === 'string') return { ...base, ref: parsed.ref }
    if (parsed.blob === null) {
      // "Did not exist" is only meaningful with a zero size, and never with a
      // LOSSY flag (a record that lost bytes cannot also assert absence). A
      // contradiction is corruption, and guessing an entry's kind from a
      // corrupt field is exactly how a restore turns into a delete.
      if (parsed.lossy === true) return undefined
      if (typeof parsed.size === 'number' && parsed.size !== 0) return undefined
      return { ...base, before: null, size: 0 }
    }
    if (typeof parsed.blob !== 'string') return undefined
    // Invariant: the sidecar sits next to its entry, named after it.
    if (parsed.blob !== sidecarName(basename(file))) return undefined
    const size = typeof parsed.size === 'number' && parsed.size >= 0 ? parsed.size : 0
    const mode = typeof parsed.mode === 'number' ? parsed.mode : undefined
    if (parsed.lossy === true) {
      // The sidecar holds the UTF-8 re-encoding of a LOSSY v1 string: read it
      // back as that string so the planner can compare it but never write it.
      // An unreadable sidecar makes the entry unusable — skipped, never a
      // delete and never a whole-operation failure.
      try {
        const text = await readFile(join(dirname(file), parsed.blob), 'utf8')
        return { ...base, before: { kind: 'lossyText', text }, size, lossy: true, ...(mode !== undefined ? { mode } : {}) }
      } catch {
        return undefined
      }
    }
    return {
      ...base,
      before: { kind: 'blob', path: join(dirname(file), parsed.blob) },
      size,
      ...(mode !== undefined ? { mode } : {}),
    }
  }
  // Released v1: `path` + `anchorSeq`, content inline as a decoded string.
  if (typeof parsed.path !== 'string' || typeof parsed.anchorSeq !== 'number') return undefined
  const base = { callId, anchorSeq: parsed.anchorSeq, path: parsed.path, time, ...origin }
  if (typeof parsed.ref === 'string') return { ...base, ref: parsed.ref }
  // Never coerce a malformed `before` to null: null means "was created", and
  // guessing it from a corrupt field is how a restore turns into a delete.
  if (parsed.before !== null && typeof parsed.before !== 'string') return undefined
  if (parsed.before === null) return { ...base, before: null, size: 0 }
  return { ...base, before: textSourceOf(parsed.before), size: Buffer.byteLength(parsed.before, 'utf8') }
}

/**
 * True when a dedup-link `ref` is a SAFE relative reference to a checkpoint
 * entry — `<digits>/<callId>.json`, a single level below the session dir, with
 * no traversal or absolute segment. The plugin always writes refs this way
 * ({@link SnapshotStore.entryRefOf}); this validates a `ref` read back from
 * disk so a hostile or corrupt ref can never escape the store root when a
 * restore resolution or prune materialization follows it (mirrors the
 * `safeSessionId` / `safeFileId` containment guarantee).
 */
export function isSafeLinkRef(ref: string): boolean {
  return /^[0-9]+\/[a-zA-Z0-9._-]+\.json$/.test(ref)
}

/**
 * True when a journal's byte reference is SAFE and relative to the session
 * dir: either `<digits>/<name>.before` (an entry sidecar) or
 * `rescue/<opId>/<index>.before` (a rescue copy). Validated on both write and
 * read, so a corrupt or hostile journal can never point a restore or a
 * rollback outside the store (`..`, absolute paths and unknown roots are
 * rejected).
 */
export function isSafeBackupRef(ref: string): boolean {
  if (ref.length === 0 || ref.startsWith('/') || ref.includes('\\')) return false
  const segments = ref.split('/')
  if (segments.length !== 2 && segments.length !== 3) return false
  if (segments.length === 3 && segments[0] !== RESCUE_DIR) return false
  return segments.every(segment => segment !== '.' && segment !== '..' && /^[a-zA-Z0-9._-]+$/.test(segment))
}

/**
 * Result of a stale-session cleanup sweep ({@link SnapshotStore.pruneStale}).
 *
 * The sweep is ANTI-DELETE: it only ever removes WHOLE session directories
 * that have been idle past `maxAgeDays`. `scanned` counts every session dir
 * evaluated; `kept` + `skippedActive` + `deleted` sum to it. `remainingBytes`
 * is the total of directories that SURVIVE the policy (when `dryRun` it is the
 * would-be total, not the current on-disk total), so it is comparable across
 * dry and real runs.
 */
export interface PruneStaleReport {
  /** Number of session directories evaluated. */
  readonly scanned: number
  /** Session directories removed (would-be count when `dryRun`). */
  readonly deleted: number
  /** Bytes reclaimed (would-be bytes when `dryRun`). */
  readonly freedBytes: number
  /** Session directories retained (not past the cutoff, not the active one). */
  readonly kept: number
  /** Bytes across the retained + skipped-active directories. */
  readonly remainingBytes: number
  /** Directories skipped because they are the active session. */
  readonly skippedActive: number
  /** Whether nothing was really removed (the sweep only reported). */
  readonly dryRun: boolean
}

/**
 * Result of a manual whole-session clear ({@link SnapshotStore.clearSession}).
 *
 * Unlike the age-based sweep, a clear removes EVERY snapshot of ONE session
 * (all anchor groups, all checkpoint entries, all restore journals) on demand —
 * the active session the user is driving, to drop the rewind overhead or to
 * archive a conversation immediately. `dryRun` reports what would be removed
 * without touching disk or memory.
 */
export interface ClearSessionReport {
  /** The session whose records were (or would be) cleared. */
  readonly sessionId: string
  /** Number of anchor-group (user-message) directories present. */
  readonly anchorGroups: number
  /** Number of committed checkpoint entries (full backups + dedup links). */
  readonly entries: number
  /** Number of restore-journal files (terminal + pending). */
  readonly journals: number
  /** Bytes occupied by the session directory (the amount freed). */
  readonly bytes: number
  /** Whether nothing was really removed (the clear only reported). */
  readonly dryRun: boolean
}
