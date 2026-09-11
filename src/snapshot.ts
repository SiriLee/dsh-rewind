/**
 * Checkpoint store — the Claude Code style file-rewind backing for dsh-rewind.
 *
 * Claude Code's checkpointing (see README) works like this: it creates a
 * BACKUP of a file BEFORE every tracked modification, groups those backups by
 * the user message they belong to (a "checkpoint"), and rewinding to a
 * checkpoint restores every backup recorded at or after it — modified files
 * are written back to their pre-edit content, files created after the target
 * are deleted. This module is the same design, persisted on disk:
 *
 * - `tools/execute` captures the BEFORE state of each tracked write/edit call
 *   (or "created" when the file did not exist) — the capture happens at the
 *   around-dispatch stage, so an approval `ask` short-circuit cannot skip it
 *   and a denied call never records.
 * - The entry is committed to disk at `tools/post-execute` under the turn's
 *   anchor seq: `<root>/<sessionId>/<anchorSeq>/<callId>.json` carries the
 *   metadata, and the before content lives beside it as a RAW BYTE sidecar
 *   (`<callId>.before`, copied with `copyFile`). Content never travels through
 *   a JS string, so binary and non-UTF-8 files round-trip byte-exactly.
 * - Because entries live on disk under the dsh data directory, they survive a
 *   host restart, are bounded (the newest 100 anchor groups per session are
 *   kept), and restores read/write the real file system with plain `node:fs`
 *   — independent of the fs service.
 *
 * Security note: this `node:fs` authority is the DSH host authority every host
 * plugin holds — the model-facing fences constrain the model's tools, not this
 * code. The store stays bounded to the model-touched paths, so excluding a
 * file (e.g. `.env`) is a model-permission concern (see `SECURITY.md`).
 *
 * Crash safety (this module's own engineering asset):
 *  - Checkpoint commits are ATOMIC: the sidecar is fully written first, then
 *    the entry JSON is written to a sibling temp file and renamed over the
 *    target, so a host crash mid-write can never leave a readable entry
 *    without its bytes — at worst an unreferenced orphan sidecar, or an inert
 *    `.tmp` leftover that the next commit of the same file overwrites and that
 *    no reader ever picks up.
 *  - Every restore pass is JOURNALED. Before mutating anything the store
 *    captures the pre-restore ("rescue") state of each planned path as a raw
 *    byte copy and persists an intent journal (`journal-<op>.json` in the
 *    session dir) holding only references, then marks each action done as it
 *    is applied. A crash at any point leaves the journal on disk; after a host
 *    restart `reconcileRestores(sessionId)` re-derives from the REAL disk which
 *    paths already match the target and which are still pending (reporting
 *    "restored up to where, what changed"), auto-heals journals whose goal is
 *    already reached, and `continueRestore` / `rollbackRestore` finish the
 *    interrupted op or undo it back to the exact pre-restore state.
 *  - Journal IO is best-effort and never fails a restore: if the journal
 *    cannot be written the restore proceeds exactly like the pre-journal code
 *    (crash safety degrades, behavior does not).
 *
 * Restore semantics (identical to Claude Code): for every path with entries
 * anchored at or after the target message, apply the EARLIEST entry — write
 * the before content back, or delete the file when that entry recorded a
 * creation. Symlinked and hard-linked paths are skipped and reported, never
 * written through.
 *
 * Format compatibility: entries written before this module stored bytes
 * (released v1: `{callId, anchorSeq, path, before: string | null}` plus the
 * `restore-journal-` prefix) are still READ — their string content is the
 * exact UTF-8 bytes it always was, except for records that were decoded
 * lossily (they contain U+FFFD: comparable, but never written back). New
 * writes are always the byte format; the marker contract that keeps a
 * downgraded v1 build from touching the workspace lives in
 * `tests/downgrade-safety.test.ts`.
 *
 * @module dsh-rewind/snapshot
 */

import { createHash } from 'node:crypto'
import type { Stats } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** Sub-directory of the harness home holding this plugin's snapshots. */
const SNAPSHOT_DIR_NAME = 'rewind-snapshots'

/** Suffix of the raw byte copy holding one entry's before-content. */
const SIDECAR_SUFFIX = '.before'

/** Session-dir sub-directory holding captures that are staged but not committed. */
const PENDING_DIR = '.pending'

/** Session-dir sub-directory holding one pre-restore ("rescue") copy per op. */
const RESCUE_DIR = 'rescue'

/** Journal-file prefix of the current format. */
const JOURNAL_PREFIX = 'journal-'

/** Journal-file prefix written by the released v1 build (read-only compatibility). */
const LEGACY_JOURNAL_PREFIX = 'restore-journal-'

/** Age after which an uncommitted `.pending/` capture is collected by `prune`. */
const PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000

/** Chunk size of the streaming byte comparisons (never load a whole file). */
const COMPARE_CHUNK_BYTES = 64 * 1024

/** The Unicode replacement character a lossy UTF-8 decode produces. */
const REPLACEMENT_CHAR = '\uFFFD'

/**
 * Default store root: `<harness home>/rewind-snapshots`. Resolved through
 * {@link resolveDshHome} so the plugin follows `$DSH_HOME` (or a configured
 * harness home) rather than hardcoding `~/.dsh` — matching the other
 * first-party DSH packages. See `SECURITY.md` "Sensitive files".
 */
export const DEFAULT_SNAPSHOT_ROOT = join(resolveDshHome(), SNAPSHOT_DIR_NAME)

/** Environment variable overriding the store root (tests, exotic homes). */
export const SNAPSHOT_ROOT_ENV = 'DSH_REWIND_SNAPSHOT_DIR'

/** Number of newest anchor groups (user messages) kept per session. */
export const MAX_ANCHOR_GROUPS = 100

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
function textSourceOf(text: string): ByteSource {
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
   * Checkpoint-time location pin: the `realpath` of `dirname(path)` at the
   * moment the entry was committed. A restore refuses the path when its parent
   * directory no longer resolves there, because a repointed or moved ancestor
   * would otherwise redirect the write (or the unlink) outside the recorded
   * location — only the path's FINAL component is link-checked. Absent means
   * "no pin": a released-v1 entry, a v2 entry written before this field
   * existed, or a commit whose parent could not be resolved; the restore then
   * falls back to the final-component check alone.
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

/** Per-file restore impact preview (`/rewind preview @seq both`). */
export interface FileImpact {
  readonly path: string
  /** `restore` = write the before content back; `delete` = remove the file. */
  readonly action: 'restore' | 'delete'
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
  /** True when the path is a symlink or a hard link (never planned/restored). */
  isLink(path: string): Promise<boolean>
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

/** Streaming byte equality of two files (never loads either one whole). */
async function sameFileBytes(aPath: string, bPath: string): Promise<boolean> {
  const sizes = await Promise.all([stat(aPath), stat(bPath)])
  if (sizes[0].size !== sizes[1].size) return false
  const [a, b] = await Promise.all([open(aPath, 'r'), open(bPath, 'r')])
  try {
    const aChunk = Buffer.allocUnsafe(COMPARE_CHUNK_BYTES)
    const bChunk = Buffer.allocUnsafe(COMPARE_CHUNK_BYTES)
    for (;;) {
      const [ra, rb] = await Promise.all([
        a.read(aChunk, 0, COMPARE_CHUNK_BYTES, null),
        b.read(bChunk, 0, COMPARE_CHUNK_BYTES, null),
      ])
      if (ra.bytesRead !== rb.bytesRead) return false
      if (ra.bytesRead === 0) return true
      if (!aChunk.subarray(0, ra.bytesRead).equals(bChunk.subarray(0, rb.bytesRead))) return false
    }
  } finally {
    await Promise.all([a.close(), b.close()])
  }
}

/** Streaming byte equality of a file against an in-memory buffer. */
async function sameFileBuffer(path: string, bytes: Buffer): Promise<boolean> {
  const st = await stat(path)
  if (st.size !== bytes.length) return false
  const handle = await open(path, 'r')
  try {
    const chunk = Buffer.allocUnsafe(COMPARE_CHUNK_BYTES)
    let offset = 0
    for (;;) {
      const read = await handle.read(chunk, 0, Math.min(COMPARE_CHUNK_BYTES, bytes.length - offset), offset)
      if (read.bytesRead === 0) return offset === bytes.length
      if (!chunk.subarray(0, read.bytesRead).equals(bytes.subarray(offset, offset + read.bytesRead))) return false
      offset += read.bytesRead
    }
  } finally {
    await handle.close()
  }
}

/** True when the error means "the path does not exist". */
function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

/** Production probe: real byte comparisons via node:fs, links via lstat + nlink. */
export const defaultProbe: DiskProbe = {
  async matches(source: ByteSource | null, path: string): Promise<boolean | undefined> {
    try {
      if (source === null) {
        // A "created" record matches when the file is still absent.
        await stat(path)
        return false
      }
      if (source.kind === 'blob') return await sameFileBytes(path, source.path)
      if (source.kind === 'text') return await sameFileBuffer(path, source.bytes)
      // Legacy lossy string: compare with the same decode the v1 build used.
      return (await readFile(path)).toString('utf8') === source.text
    } catch (error) {
      // A missing file differs from any recorded content, but is exactly what a
      // `null` source records; anything else is an undecidable probe failure.
      if (isEnoent(error)) return source === null ? true : false
      return undefined
    }
  },
  async copy(path: string, dest: string): Promise<CopyOutcome> {
    try {
      await copyFile(path, dest)
      const st = await stat(dest)
      return { kind: 'copied', size: st.size }
    } catch (error) {
      if (isEnoent(error)) {
        // ENOENT covers two very different cases: the SOURCE is gone (nothing
        // to rescue — "absent") or `dest`'s parent directory does not exist (a
        // real failure). Only a missing source is "absent".
        const source = await stat(path).catch(() => undefined)
        if (source === undefined) return { kind: 'absent' }
      }
      return { kind: 'failed', message: error instanceof Error ? error.message : String(error) }
    }
  },
  isLink: isLinkPath,
}

/** Sanitize a call id into a safe file name. */
function safeFileId(callId: string): string {
  return callId.replace(/[^a-zA-Z0-9._-]/g, '_')
}

/**
 * Sanitize a session id into a safe path segment. Real ids are harness-minted
 * UUIDs (a no-op here), but a hostile or malformed id must never traverse out
 * of the snapshot root — `.` and `..` are the only bare values the charset
 * permits that would alias the root or its parent.
 */
function safeSessionId(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9._-]/g, '_')
  return safe === '..' || safe === '.' ? 'session' : safe
}

/**
 * Atomic JSON file write: serialize to a sibling temp file, then rename over
 * the target. A crash between the two steps leaves only the temp — never a
 * readable half-written target — and rename is atomic, so readers always see
 * either the old file or the complete new one. The temp name is deterministic
 * (`<target>.tmp`): a crash-leftover temp is overwritten by the next write of
 * the same target and is never picked up by readers (it does not end in
 * `.json`). `afterTempWrite` is the test-only crash seam between the steps.
 */
async function writeJsonAtomic(file: string, data: unknown, afterTempWrite?: () => void): Promise<void> {
  const tmp = `${file}.tmp`
  await writeFile(tmp, JSON.stringify(data), 'utf8')
  afterTempWrite?.()
  await rename(tmp, file)
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
function isRestoreJournal(value: unknown): value is RestoreJournal {
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

/** Serialize one byte source as a session-relative journal reference. */
function sourceToRef(source: ByteSource | null, sessionDir: string, entryPath: string): unknown {
  if (source === null) return null
  if (source.kind === 'blob') {
    const blob = relative(sessionDir, source.path)
    if (!isSafeBackupRef(blob)) throw new Error(`unsafe backup ref ${blob} for ${entryPath}`)
    return { blob }
  }
  return { text: source.kind === 'text' ? source.bytes.toString('utf8') : source.text }
}

/** Serialized (on-disk) form of a journal action. */
function journalToJson(journal: RestoreJournal, sessionDir: string): Record<string, unknown> {
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
function journalFromJson(raw: Record<string, unknown>, sessionDir: string): RestoreJournal | undefined {
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
function isJournalName(name: string): boolean {
  if (!name.endsWith('.json')) return false
  return name.startsWith(JOURNAL_PREFIX) || name.startsWith(LEGACY_JOURNAL_PREFIX)
}

/** The op id encoded in a journal file name. */
function journalOpIdOf(name: string): string {
  const prefix = name.startsWith(LEGACY_JOURNAL_PREFIX) ? LEGACY_JOURNAL_PREFIX : JOURNAL_PREFIX
  return name.slice(prefix.length, -'.json'.length)
}

/** The entry file name one call id maps to (the single naming function). */
function entryFileName(callId: string): string {
  // The digest disambiguates call ids that `safeFileId` would collapse onto the
  // same name (`a:b` vs `a_b`). References always name a file explicitly and
  // readers never infer a name, so pre-digest entries keep working.
  return `${safeFileId(callId)}-${shortHash(callId)}.json`
}

/** Stable 8-hex digest of an arbitrary string (ids, paths, capture keys). */
function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8)
}

/** The sidecar file name of one entry file (`<base>.json` → `<base>.before`). */
function sidecarName(entryFile: string): string {
  return `${entryFile.slice(0, -'.json'.length)}${SIDECAR_SUFFIX}`
}

/** Anchor seq encoded in a link `ref` (`<anchorSeq>/<file>.json`). */
function refAnchorOf(ref: string): number {
  const slash = ref.indexOf('/')
  return slash === -1 ? Number.NaN : Number(ref.slice(0, slash))
}

/** Serialize one in-memory entry for disk (the current byte format). */
function entryToJson(entry: CheckpointEntry): Record<string, unknown> {
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
function linkToJson(link: LinkEntry): Record<string, unknown> {
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
async function readEntry(file: string, anchorSeq: number): Promise<StoredEntry | undefined> {
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

/** Recursive byte total of a directory tree (never follows symlinks). */
async function dirBytes(dir: string): Promise<number> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return 0
  }
  let total = 0
  for (const name of names) {
    const full = join(dir, name)
    const st = await lstat(full).catch(() => undefined)
    if (st === undefined) continue
    if (st.isDirectory()) total += await dirBytes(full)
    else if (st.isFile()) total += st.size
  }
  return total
}

/**
 * True when the path is a symlink or a hard link (nlink > 1) — both are never
 * written through on restore: a symlink would redirect the write to its target
 * (bypassing the checkpoint), and a hard link would clobber every other name
 * pointing at the same inode (e.g. pnpm-installed files). Mirrors Claude Code's
 * "symlinked and hard-linked paths not restored".
 */
async function isLinkPath(path: string): Promise<boolean> {
  try {
    const stat = await lstat(path)
    return stat.isSymbolicLink() || stat.nlink > 1
  } catch {
    return false
  }
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
function isSafeLinkRef(ref: string): boolean {
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
function isSafeBackupRef(ref: string): boolean {
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

/**
 * Walk one directory tree and compute the total size (regular files only) and
 * the newest stamp (max `lstat.mtimeMs` over every member, directories
 * included). `lstat` never follows a symlink, so a hostile symlink inside the
 * store cannot escape the root or inflate the measurement; a symlink is
 * counted as one file's own metadata and not descended into. Directory members
 * beginning with `.` (atomic-write temp leftovers, editor droppings) are
 * skipped — they are never checkpoint entries.
 */
async function dirSizeAndLastActive(dir: string): Promise<{ size: number; lastActiveMs: number }> {
  let size = 0
  let lastActiveMs = 0
  const visit = async (current: string): Promise<void> => {
    let st: Stats
    try {
      st = await lstat(current)
    } catch {
      return // already gone or unreadable: skip
    }
    if (st.mtimeMs > lastActiveMs) lastActiveMs = st.mtimeMs
    if (!st.isDirectory()) {
      size += st.size
      return
    }
    let names: string[]
    try {
      names = await readdir(current)
    } catch {
      return
    }
    for (const name of names) {
      // Dot-prefixed leftovers are never store members; `.pending/` is the
      // exception, and it must be visited so a staged capture counts as both
      // activity and bytes (otherwise a session whose only recent write is a
      // staged capture looks idle and is swept, and its size is under-reported).
      if (name.startsWith('.') && name !== PENDING_DIR) continue
      await visit(join(current, name))
    }
  }
  await visit(dir)
  return { size, lastActiveMs }
}

/**
 * On-disk checkpoint store. Every write goes straight through `node:fs`, so a
 * restore reliably lands on the real file system.
 */
export class SnapshotStore {
  /** Debounce window for the per-commit prune (keeps the readdir+sort off the hot path). */
  private static readonly PRUNE_INTERVAL_MS = 1000

  /** Session-format-version marker file inside the session dir. Non-`.json`, so it never counts as a checkpoint entry. */
  private static readonly FORMAT_FILE = 'format'

  /** Plugin STORE-format marker file inside the session dir (non-`.json`, same reasoning). */
  private static readonly STORE_FILE = 'store'

  private lastPruneAt = 0

  /**
   * Monotonic entry clock. Date.now() has 1ms precision, so back-to-back
   * commits in the same millisecond would TIE on the entry `time` field and
   * entriesAfter's (anchorSeq, time) sort would fall back to the readdir
   * order — filesystem-dependent, so a re-read could pick the WRONG "earliest"
   * version for a path. Bumping past the previous commit keeps the capture
   * order reproducible after a re-read. The read-modify-write below is
   * synchronous (before the first await), so concurrent commits can never
   * observe the same value. Across restarts wall-clock monotonicity holds
   * (restart gaps dwarf 1ms); a backwards NTP step is the only way to break
   * it, and even then the in-process order still holds.
   */
  private lastEntryTime = 0

  /** Store options; `dedup` toggles in-place content dedup (default on). */
  private readonly dedup: boolean

  /** Resolved checkpoint store root (absolute); see the constructor's fallback. */
  readonly root: string

  /**
   * In-memory per-path "most recent entry" for content dedup, keyed by
   * `<sessionId>\0<path>`. Each value holds the entry's effective byte source
   * (a handle, not a copy) and its own file ref, so a new record with the same
   * content links to the immediately-prior entry (linear chain). Seeded lazily
   * per session from the bounded on-disk window, so dedup survives a host
   * restart. A handle whose bytes vanished (pruned out of band) is treated as
   * "never recorded" — dedup then stores MORE, never less.
   */
  private readonly lastEntry = new Map<string, { source: ByteSource | null; ref: string }>()

  /** Sessions whose dedup state has been seeded from disk this process. */
  private readonly seededSessions = new Set<string>()

  /** Sessions whose store-format marker this process has already stamped. */
  private readonly storeStamped = new Set<string>()

  /**
   * Session-format version snapshots are anchored under, stamped into each
   * session's `format` marker when an entry is recorded. `null` until the host
   * sets it (from `agent/session-start`), so a session that never records is
   * never materialized and a marker is only written where snapshots exist.
   */
  private formatVersion: number | null = null

  constructor(
    root?: string,
    opts?: { readonly dedup?: boolean; readonly dshHome?: string },
  ) {
    this.dedup = opts?.dedup ?? true
    // Deterministic store-root fallback (highest first): an explicit root
    // (config `snapshotDir`) → `DSH_REWIND_SNAPSHOT_DIR` env → the harness-home
    // base derived from `config.dshHome` (via resolveDshHome: config.dshHome >
    // `$DSH_HOME` > `~/.dsh`) plus `rewind-snapshots`.
    this.root = root
      ?? process.env[SNAPSHOT_ROOT_ENV]
      ?? join(resolveDshHome(opts?.dshHome), SNAPSHOT_DIR_NAME)
  }

  /** Absolute path of one session's snapshot directory (id sanitized). */
  sessionDir(sessionId: string): string {
    return join(this.root, safeSessionId(sessionId))
  }

  /** Absolute path of one anchor group directory. */
  anchorDir(sessionId: string, anchorSeq: number): string {
    return join(this.sessionDir(sessionId), String(anchorSeq))
  }

  /** Absolute file ref (relative to the session dir) of an entry. */
  private entryRefOf(sessionId: string, callId: string, anchorSeq: number): string {
    return `${anchorSeq}/${entryFileName(callId)}`
  }

  /**
   * The session-relative ref of an entry READ from disk: the file that really
   * holds it. A v1 entry keeps its released name, so recomputing the name from
   * the call id would produce a dangling reference.
   */
  private refOfRead(sessionId: string, entry: StoredEntry): string {
    if (entry.file !== undefined) return relative(this.sessionDir(sessionId), entry.file)
    return this.entryRefOf(sessionId, entry.callId, entry.anchorSeq)
  }

  /** Drop every in-memory trace of one session (its directory is gone). */
  private forgetSession(sessionId: string): void {
    this.seededSessions.delete(sessionId)
    this.storeStamped.delete(sessionId)
    for (const key of [...this.lastEntry.keys()]) {
      if (key.startsWith(`${sessionId}\0`)) this.lastEntry.delete(key)
    }
  }

  /**
   * Forget in-memory state for sessions whose directory no longer exists —
   * after a sweep, or after the user removed a session dir out of band. A
   * stale handle is SAFE (dedup and the boundary both fail toward storing
   * more), but keeping it means the store holds state for a session it deleted
   * and skips re-stamping that session's `format`/`store` markers.
   */
  private async forgetMissingSessions(): Promise<void> {
    const known = new Set<string>([...this.seededSessions, ...this.storeStamped])
    for (const key of this.lastEntry.keys()) {
      const separator = key.indexOf('\0')
      if (separator !== -1) known.add(key.slice(0, separator))
    }
    for (const sessionId of known) {
      // "Cannot tell" keeps the (safe) state rather than failing the sweep
      // whose deletions already happened.
      const present = await this.exists(this.sessionDir(sessionId)).catch(() => true)
      if (!present) this.forgetSession(sessionId)
    }
  }

  /**
   * Stage a capture slot for one tool call: create the session's `.pending/`
   * area and return the absolute path the caller copies the before-bytes into
   * (never through memory). The slot lives inside the session dir so the
   * commit can `rename` it into the anchor group atomically; a slot that is
   * never committed is either unlinked by its caller or collected by `prune`.
   */
  async stageCapture(sessionId: string, key: string): Promise<string> {
    const dir = join(this.sessionDir(sessionId), PENDING_DIR)
    await mkdir(dir, { recursive: true })
    // The digest disambiguates two keys that `safeFileId` would collapse onto
    // the same staged name (a collision would let the second capture overwrite
    // the first one's bytes before either is committed).
    return join(dir, `${safeFileId(key)}-${shortHash(key)}${SIDECAR_SUFFIX}`)
  }

  /**
   * Seed a session's dedup state from the existing (bounded) on-disk window:
   * scan entries newest-first and record the most recent entry per path. This
   * makes content dedup survive a host restart within the session window. A
   * no-op after the first seed (or when `dedup` is disabled).
   */
  private async ensureDedupSeeded(sessionId: string): Promise<void> {
    if (!this.dedup || this.seededSessions.has(sessionId)) return
    this.seededSessions.add(sessionId)
    try {
      // entriesAfter returns newest-first; the first entry per path is its
      // most recent one. Resolve a link to its effective byte source.
      for (const entry of await this.entriesAfter(sessionId, 0)) {
        const key = `${sessionId}\0${entry.path}`
        if (this.lastEntry.has(key)) continue
        const source = await this.resolveBefore(sessionId, entry)
        this.lastEntry.set(key, { source, ref: this.refOfRead(sessionId, entry) })
      }
    } catch {
      // Seeding is best-effort: an unreadable/corrupt session simply starts
      // with an empty dedup state (redundant but correct, like a cold start).
      this.seededSessions.delete(sessionId)
    }
  }

  /**
   * Resolve an entry's effective `before` content, following a link chain to
   * its terminal real snapshot. Refs are strictly backward in
   * `(anchorSeq, time)`, so the chain is acyclic and finite. A dangling or
   * cyclic link throws — callers fail per-file (never silently dropping the
   * path from a restore).
   */
  private async resolveBefore(
    sessionId: string,
    entry: StoredEntry,
    seen = new Set<string>(),
  ): Promise<ByteSource | null> {
    if (!isLinkEntry(entry)) return this.validatedSource(entry)
    const key = `${entry.anchorSeq}:${entry.callId}`
    if (seen.has(key)) throw new Error(`link cycle at ${entry.path} (${key})`)
    seen.add(key)
    if (!isSafeLinkRef(entry.ref)) throw new Error(`unsafe link ref ${entry.ref} for ${entry.path}`)
    const referenced = await readEntry(join(this.sessionDir(sessionId), entry.ref), refAnchorOf(entry.ref))
    if (referenced === undefined) throw new Error(`dangling link ${entry.ref} for ${entry.path}`)
    return this.resolveBefore(sessionId, referenced, seen)
  }

  /**
   * Validate a real entry's byte source against the store's own files: a
   * sidecar that is missing, not a regular file, or a different size than the
   * metadata records is an INTEGRITY failure (thrown), never a silent skip and
   * never a fallback to "the file was created" — a restore must not delete a
   * file whose backup it cannot read.
   */
  private async validatedSource(entry: CheckpointEntry): Promise<ByteSource | null> {
    const source = entry.before
    if (source === null || source.kind !== 'blob') return source
    const st = await stat(source.path).catch((error: unknown) => {
      if (isEnoent(error)) throw new Error(`missing backup sidecar ${source.path} for ${entry.path}`)
      throw error
    })
    if (!st.isFile()) throw new Error(`backup sidecar is not a file: ${source.path}`)
    if (st.size !== entry.size) {
      throw new Error(`backup sidecar size mismatch for ${entry.path} (recorded ${entry.size}, found ${st.size})`)
    }
    return source
  }

  /**
   * True when two recorded byte sources are the same content. Comparison is
   * STREAMING (size first, then chunks) so large files never enter memory.
   * Any unreadable handle — or any legacy lossy source, whose original bytes
   * are unknowable — answers `false`: dedup must fail toward storing more,
   * never toward claiming "unchanged".
   */
  private async sourcesMatch(a: ByteSource | null, b: ByteSource | null): Promise<boolean> {
    if (a === null || b === null) return a === null && b === null
    try {
      if (a.kind === 'blob' && b.kind === 'blob') return await sameFileBytes(a.path, b.path)
      if (a.kind === 'text' && b.kind === 'text') return a.bytes.equals(b.bytes)
      if (a.kind === 'blob' && b.kind === 'text') return await sameFileBuffer(a.path, b.bytes)
      if (a.kind === 'text' && b.kind === 'blob') return await sameFileBuffer(b.path, a.bytes)
      return false
    } catch {
      return false
    }
  }

  /**
   * Write raw bytes to a sidecar path atomically (temp + rename): a crash
   * between the steps leaves only a `.tmp` that no reader picks up.
   */
  private async writeSidecar(dest: string, source: ByteSource): Promise<void> {
    const tmp = `${dest}.tmp`
    if (source.kind === 'blob') await copyFile(source.path, tmp)
    else if (source.kind === 'text') await writeFile(tmp, source.bytes)
    else await writeFile(tmp, Buffer.from(source.text, 'utf8'))
    await rename(tmp, dest)
  }

  /**
   * Place one entry's sidecar next to its entry file: MOVE a staged capture
   * (same filesystem, atomic) or write the bytes from a source. Returns the
   * blob source and its size, or null for a created file. The sidecar is
   * always complete before the entry JSON is written.
   */
  private async placeSidecar(
    entryFile: string,
    content: { readonly source: ByteSource | null; readonly staged?: { readonly file: string } },
  ): Promise<{ readonly source: ByteSource; readonly size: number } | null> {
    if (content.source === null) return null
    const dest = join(dirname(entryFile), sidecarName(basename(entryFile)))
    if (content.staged !== undefined) await rename(content.staged.file, dest)
    else await this.writeSidecar(dest, content.source)
    const st = await stat(dest)
    return { source: { kind: 'blob', path: dest }, size: st.size }
  }

  /**
   * Commit one entry (a full before-backup or an in-place dedup link) under
   * its anchor group.
   */
  private async commit(
    sessionId: string,
    entry: { readonly callId: string; readonly anchorSeq: number; readonly path: string },
    content: {
      readonly source: ByteSource | null
      readonly staged?: { readonly file: string }
      readonly mode?: number
    },
    opts?: { readonly dedup?: boolean; readonly crash?: (point: CrashPoint) => void },
  ): Promise<void> {
    // Monotonic time (see lastEntryTime): strictly increasing per store
    // instance, so same-millisecond commits stay capture-ordered.
    const time = Math.max(Date.now(), this.lastEntryTime + 1)
    this.lastEntryTime = time
    // The location pin: where this path's directory resolved at commit time.
    // Best-effort — an unresolvable parent simply means "no pin" (legacy
    // behavior), never a failed commit.
    const parent = await realpath(dirname(entry.path)).catch(() => undefined)
    await this.ensureDedupSeeded(sessionId)
    // Never write into a store a newer build owns: the marker would be
    // overwritten and the formats mixed. The failure is loud (the host logs
    // the failed commit) and costs snapshots, never workspace data.
    await this.assertKnownStoreVersion(sessionId)
    const dir = this.anchorDir(sessionId, entry.anchorSeq)
    await mkdir(dir, { recursive: true })
    const file = join(dir, entryFileName(entry.callId))
    const selfRef = this.entryRefOf(sessionId, entry.callId, entry.anchorSeq)
    // Content dedup: when the new content equals the path's most recent
    // recorded content, store a LINK to that prior entry instead of a second
    // copy. The prior entry is the immediately-preceding one (linear chain).
    // `dedup: false` skips the comparison and always writes a full copy — used
    // by the boundary, which only records CHANGED files and so never links.
    const key = `${sessionId}\0${entry.path}`
    const prior = this.lastEntry.get(key)
    // A staged capture is already a byte file, so it can be compared directly.
    const incoming: ByteSource | null = content.source === null
      ? null
      : content.staged !== undefined ? { kind: 'blob', path: content.staged.file } : content.source
    const link = this.dedup && opts?.dedup !== false && prior !== undefined
      && await this.sourcesMatch(prior.source, incoming)
    if (link) {
      const committed: LinkEntry = {
        callId: entry.callId,
        anchorSeq: entry.anchorSeq,
        path: entry.path,
        ref: prior.ref,
        ...(parent !== undefined ? { parent } : {}),
        time,
      }
      // The staged copy is redundant now: drop it before publishing the link
      // (a crash in between leaves an inert orphan, never a lost backup).
      if (content.staged !== undefined) await rm(content.staged.file, { force: true })
      await writeJsonAtomic(file, linkToJson(committed), () => opts?.crash?.('after-temp-write'))
      this.lastEntry.set(key, { source: prior.source, ref: selfRef })
    } else {
      const placed = await this.placeSidecar(file, content)
      const committed: CheckpointEntry = {
        callId: entry.callId,
        anchorSeq: entry.anchorSeq,
        path: entry.path,
        before: placed?.source ?? null,
        size: placed?.size ?? 0,
        // Content that was already lossy when it reached the store (a v1
        // string, or a materialized link to one) stays marked, so a later
        // reader cannot mistake its re-encoded bytes for a faithful backup.
        ...(incoming?.kind === 'lossyText' ? { lossy: true } : {}),
        ...(content.mode !== undefined ? { mode: content.mode } : {}),
        ...(parent !== undefined ? { parent } : {}),
        time,
      }
      await writeJsonAtomic(file, entryToJson(committed), () => opts?.crash?.('after-temp-write'))
      this.lastEntry.set(key, { source: committed.before, ref: selfRef })
    }
    // Stamp the session-format marker so this session's snapshots record the
    // session-format version they were written under — the value the
    // `agent/session-start` reconcile compares against on the next load — and
    // the plugin's own store-format marker, so a future format bump can fail
    // closed before reading any entry.
    if (this.formatVersion !== null) {
      await this.markFormatVersion(sessionId, this.formatVersion)
    }
    // The store-format marker only ever moves to the CURRENT version in this
    // build, so stamp it once per process per session.
    if (!this.storeStamped.has(sessionId)) {
      await this.markStoreVersion(sessionId, CURRENT_STORE_VERSION)
      this.storeStamped.add(sessionId)
    }
    // Prune at most once per interval: a turn with many writes would otherwise
    // pay a readdir + sort on every commit. The 100-group cap still holds —
    // the debounce only skips redundant scans within a burst.
    const now = Date.now()
    if (now - this.lastPruneAt >= SnapshotStore.PRUNE_INTERVAL_MS) {
      this.lastPruneAt = now
      await this.prune(sessionId)
    }
  }

  /**
   * Commit one before-backup whose content the caller already holds as raw
   * text (the boundary-friendly API: tests, synthetic records). The bytes are
   * encoded UTF-8, exactly as the released v1 build did for text content.
   */
  async recordEntry(
    sessionId: string,
    entry: {
      readonly callId: string
      readonly anchorSeq: number
      readonly path: string
      readonly before: string | null
    },
    opts?: { readonly dedup?: boolean; readonly crash?: (point: CrashPoint) => void },
  ): Promise<void> {
    await this.commit(sessionId, entry, {
      source: entry.before === null ? null : textSourceOf(entry.before),
    }, opts)
  }

  /**
   * Commit one before-backup whose content is an existing byte file (the
   * capture and boundary paths): `backup.file` is MOVED into the anchor group
   * (same filesystem, so this is atomic), or `null` when the file did not
   * exist — a creation.
   */
  async recordBackup(
    sessionId: string,
    entry: { readonly callId: string; readonly anchorSeq: number; readonly path: string },
    backup: PendingBackup | null,
    opts?: { readonly dedup?: boolean; readonly crash?: (point: CrashPoint) => void },
  ): Promise<void> {
    await this.commit(sessionId, entry, {
      source: backup === null ? null : { kind: 'blob', path: backup.file },
      ...(backup !== null ? { staged: { file: backup.file } } : {}),
      ...(backup?.mode !== undefined ? { mode: backup.mode } : {}),
    }, opts)
  }

  /**
   * The byte source recorded by the path's MOST RECENT entry, or undefined
   * when the path has never been recorded (a fresh tracking sight). This is
   * the single in-memory "last known state" the boundary compares the disk
   * against — the same source `recordEntry` dedups against, so there is one
   * handle and one comparison per decision, not two. Seeding is idempotent
   * (once per session from disk).
   */
  async lastKnownContent(sessionId: string, path: string): Promise<ByteSource | null | undefined> {
    await this.ensureDedupSeeded(sessionId)
    return this.lastEntry.get(`${sessionId}\0${path}`)?.source
  }

  /**
   * All committed entries anchored at or after `targetSeq`, newest first (for
   * preview ordering). The boundary is inclusive: rewinding to a message also
   * reverts the changes its own turn caused (the rewind cut removes that
   * turn's assistant response and tool calls), so only entries anchored at
   * earlier messages survive.
   */
  async entriesAfter(sessionId: string, targetSeq: number): Promise<StoredEntry[]> {
    const sessionDir = this.sessionDir(sessionId)
    let names: string[]
    try {
      names = await readdir(sessionDir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const entries: StoredEntry[] = []
    for (const name of names) {
      const anchorSeq = Number(name)
      if (!Number.isSafeInteger(anchorSeq) || anchorSeq < targetSeq) continue
      const files = await readdir(this.anchorDir(sessionId, anchorSeq)).catch(() => [] as string[])
      for (const file of files) {
        if (!file.endsWith('.json')) continue
        const entry = await readEntry(join(this.anchorDir(sessionId, anchorSeq), file), anchorSeq)
        if (entry !== undefined) entries.push(entry)
      }
    }
    return entries.sort((a, b) => b.anchorSeq - a.anchorSeq || b.time - a.time)
  }

  /**
   * Per-path EARLIEST committed entry anchored at or after the target — the
   * single source of truth for both restore and impact preview.
   */
  private async earliestEntries(sessionId: string, targetSeq: number): Promise<Map<string, StoredEntry>> {
    const earliest = new Map<string, StoredEntry>()
    for (const entry of await this.entriesAfter(sessionId, targetSeq)) {
      const current = earliest.get(entry.path)
      if (current === undefined || entry.anchorSeq < current.anchorSeq || (entry.anchorSeq === current.anchorSeq && entry.time < current.time)) {
        earliest.set(entry.path, entry)
      }
    }
    return earliest
  }

  /**
   * The single source of truth for BOTH the impact preview and the restore
   * pass: reconcile the earliest recorded entry per path (at/after the
   * target) against the CURRENT on-disk state, and plan only the actions
   * that would actually change the disk. This is the Claude Code model —
   * `fileHistoryGetDiffStats` / `applySnapshot` both compare against the
   * live filesystem (`checkOriginFileChanged`) and count only real
   * differences, so a rewind whose target state already matches the disk is
   * a no-op with zero impact.
   *
   * - `before === null` (the file did not exist at the target) plans a
   *   `delete` ONLY when the file currently exists; an already-absent file
   *   is a no-op — this kills the "ghost impact" of replaying an entry a
   *   previous rewind already consumed.
   * - a recorded byte source plans a `restore` ONLY when the current bytes
   *   differ from it (or the file is missing); identical bytes are a no-op —
   *   this keeps repeated rewinds idempotent.
   * - A released-v1 record that lost bytes to a lossy decode (`lossyText`) is
   *   compared with the same lossy decode but NEVER written back: a skip is
   *   reported instead of destroying live bytes with U+FFFD content.
   * - An unreadable / unresolvable record is a per-file FAILURE, never a
   *   delete: planning a delete for a file we cannot restore is the one
   *   mistake that loses data.
   * - Symlinked / hard-linked paths are never planned (they are reported as
   *   skipped by the restore pass, never written through).
   * - A probe failure (e.g. a permission error reading the file) plans the
   *   action conservatively as if the file differed, so an unreadable file
   *   is never silently dropped from the restore.
   *
   * @param sessionId - session whose snapshot store to plan against.
   * @param targetSeq - rewind target; entries anchored at/after it apply.
   * @param probe - current-disk state probe (defaults to the real FS).
   * @returns the planned actions, the link paths skipped, and per-file failures.
   */
  private async planRestore(
    sessionId: string,
    targetSeq: number,
    probe: DiskProbe,
  ): Promise<{ actions: PlannedAction[]; skipped: string[]; failed: { path: string; message: string }[] }> {
    // Whole-operation fail-closed for a store this build does not understand:
    // a partial restore of a half-known format is worse than no restore.
    await this.assertKnownStoreVersion(sessionId)
    const actions: PlannedAction[] = []
    const skipped: string[] = []
    const failed: { path: string; message: string }[] = []
    for (const entry of (await this.earliestEntries(sessionId, targetSeq)).values()) {
      // A dedup link resolves to its terminal real content; a dangling link,
      // an unreadable sidecar and a corrupt record are all per-file integrity
      // failures, never a silent skip and never a delete.
      let source: ByteSource | null
      try {
        source = await this.resolveBefore(sessionId, entry)
      } catch (error) {
        failed.push({ path: entry.path, message: error instanceof Error ? error.message : String(error) })
        continue
      }
      try {
        if (await probe.isLink(entry.path)) {
          skipped.push(entry.path)
          continue
        }
        if (source !== null && source.kind === 'lossyText') {
          // A legacy record that lost bytes: comparable, never writable.
          const same = await probe.matches(source, entry.path)
          if (same !== true) skipped.push(entry.path)
          continue
        }
        const same = await probe.matches(source, entry.path)
        if (same === true) continue // identical content (or still absent): a no-op
        const pin = entry.parent !== undefined ? { parent: entry.parent } : {}
        if (source === null) actions.push({ path: entry.path, action: 'delete', ...pin })
        else {
          // `mode` never MAKES an action (a mode-only difference is a no-op),
          // but restoring content also restores the recorded permissions.
          const mode = isLinkEntry(entry) ? undefined : entry.mode
          actions.push({
            path: entry.path,
            action: 'restore',
            before: source,
            ...(mode !== undefined ? { mode } : {}),
            ...pin,
          })
        }
      } catch {
        // Probe failure: conservative — treat as differing. A restore still
        // attempts the write, a delete still attempts the unlink (failures
        // surface per-file in the restore outcome, never silently skipped).
        const pin = entry.parent !== undefined ? { parent: entry.parent } : {}
        if (source === null) actions.push({ path: entry.path, action: 'delete', ...pin })
        else actions.push({ path: entry.path, action: 'restore', before: source, ...pin })
      }
    }
    return { actions, skipped, failed }
  }

  /** Per-file restore impact: only actions that would actually change the disk. */
  async impactsAfter(
    sessionId: string,
    targetSeq: number,
    probe: DiskProbe = defaultProbe,
  ): Promise<FileImpact[]> {
    const { actions } = await this.planRestore(sessionId, targetSeq, probe)
    return actions
      .sort((a, b) => a.path.localeCompare(b.path))
      .map(action => ({ path: action.path, action: action.action }))
  }

  /**
   * Restore the workspace to the target message's checkpoint: execute exactly
   * the actions {@link planRestore} derived from the record + current disk
   * reconciliation — write the before content back, or delete the file when
   * it was created after the target and still exists. Symlinked and
   * hard-linked paths are skipped (reported, never written through); a
   * restored file's parent directory is created when it was deleted after
   * the backup; a delete whose file is ALREADY absent is a silent no-op (not
   * a failure — the target state is already reached). Failures are per-file
   * and never abort the pass.
   *
   * The pass is journaled for crash safety: the pre-restore ("rescue") state
   * of every planned path is captured and an intent journal persisted BEFORE
   * any mutation, then each action is marked done as it is applied. A host
   * crash at any point leaves the journal on disk; after a restart
   * {@link reconcileRestores} reports where the restore stopped,
   * {@link continueRestore} finishes it and {@link rollbackRestore} undoes it
   * back to the exact pre-restore state. Journal IO itself never fails the
   * restore (it degrades to a journal-less pass).
   */
  async restoreAfter(
    sessionId: string,
    targetSeq: number,
    deleteFile: DeleteFile,
    probe: DiskProbe = defaultProbe,
    opts?: RestoreRunOptions,
  ): Promise<RestoreOutcome> {
    const restored: string[] = []
    const deleted: string[] = []
    const skipped: string[] = []
    const failed: { path: string; message: string }[] = []
    const { actions, skipped: skippedPaths, failed: planFailed } = await this.planRestore(sessionId, targetSeq, probe)
    skipped.push(...skippedPaths)
    failed.push(...planFailed)
    // Nothing to do: no journal, no extra IO — exactly the pre-journal no-op.
    if (actions.length === 0) return { restored, deleted, skipped, failed }

    const journal = await this.beginRestore(sessionId, targetSeq, actions, probe)
    for (let i = 0; i < actions.length; i++) {
      const action = actions[i]!
      opts?.crash?.('before-action', i) // test-only: crash before the fs op
      const journalAction = journal.actions[i]!
      let applied: 'restored' | 'deleted' | 'enoent'
      try {
        applied = await this.applyActionToDisk(
          action.action,
          action.path,
          action.action === 'restore' ? action.before : null,
          deleteFile,
          action.action === 'restore' ? action.mode : undefined,
        )
        if (applied === 'enoent') {
          // Already absent: the delete is already done — the target state is
          // reached. Mark the action and count nothing (Claude Code tolerates
          // the same).
          journalAction.done = true
          await this.saveJournal(journal)
          continue
        }
      } catch (error) {
        // Per-file failure, never aborting the pass (unchanged semantics).
        journalAction.failed = error instanceof Error ? error.message : String(error)
        await this.saveJournal(journal)
        failed.push({ path: action.path, message: journalAction.failed })
        continue
      }
      // Test-only crash: right after the fs op, before the done-mark — the
      // journal then shows done=false while the disk may already match, which
      // reconciliation resolves from the REAL disk (disk is truth).
      opts?.crash?.('after-action', i)
      journalAction.done = true
      await this.saveJournal(journal)
      if (applied === 'restored') restored.push(action.path)
      else deleted.push(action.path)
    }
    if (failed.length === 0) {
      journal.state = 'completed'
      journal.finishedAt = Date.now()
    }
    await this.saveJournal(journal)
    return { restored, deleted, skipped, failed }
  }

  /** Absolute path of one restore-op journal file (the current prefix). */
  private journalPath(sessionId: string, opId: string): string {
    return join(this.sessionDir(sessionId), `${JOURNAL_PREFIX}${safeFileId(opId)}.json`)
  }

  /**
   * Locate an existing journal file for an op: the current prefix first, then
   * the prefix the released v1 build wrote (a restore interrupted before the
   * upgrade must still be continuable / rollbackable).
   */
  private async findJournalFile(sessionId: string, opId: string): Promise<string | undefined> {
    const dir = this.sessionDir(sessionId)
    for (const name of [`${JOURNAL_PREFIX}${safeFileId(opId)}.json`, `${LEGACY_JOURNAL_PREFIX}${safeFileId(opId)}.json`]) {
      const file = join(dir, name)
      try {
        await stat(file)
        return file
      } catch {
        continue
      }
    }
    return undefined
  }

  /**
   * Best-effort journal persist: journal IO failures are non-fatal by design —
   * a restore must never fail because its audit journal could not be written.
   * reconcileRestores() re-derives the true state from the disk, so a missing
   * or stale journal only loses the trail, never the recovery ability.
   *
   * A journal read back from a legacy file is rewritten IN PLACE (same file),
   * so a redo / rollback of a pre-upgrade op never leaves two divergent
   * versions of the same op on disk.
   */
  private async saveJournal(journal: RestoreJournal): Promise<void> {
    try {
      const file = journal.sourceFile ?? this.journalPath(journal.sessionId, journal.id)
      await writeJsonAtomic(file, journalToJson(journal, this.sessionDir(journal.sessionId)))
    } catch {
      // Non-fatal (see above).
    }
  }

  /**
   * Journal one restore pass before mutating anything: capture the rescue
   * (pre-restore) state of every planned path as a raw byte copy and persist
   * the intent (references only) atomically. Returns the in-memory journal; a
   * persist failure degrades to a journal-less restore (non-fatal, see
   * {@link saveJournal}).
   */
  private async beginRestore(
    sessionId: string,
    targetSeq: number,
    actions: PlannedAction[],
    probe: DiskProbe,
  ): Promise<RestoreJournal> {
    // Recycle terminal journals from earlier restores before persisting the
    // new intent: a restore-only session never runs recordEntry's prune
    // pass, so this is what bounds the journal accumulation there.
    const sessionDir = this.sessionDir(sessionId)
    try {
      await this.pruneTerminalJournals(sessionDir, await readdir(sessionDir))
    } catch (error) {
      if (!isEnoent(error)) throw error
      // Session dir does not exist yet (no entries ever recorded): nothing
      // to recycle.
    }
    const id = `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    const rescueDir = join(sessionDir, RESCUE_DIR, safeFileId(id))
    let rescueDirReady = false
    const journalActions: RestoreJournalAction[] = []
    for (const [index, action] of actions.entries()) {
      let rescue: ByteSource | null = null
      let rescueError: string | undefined
      const dest = join(rescueDir, `${index}${SIDECAR_SUFFIX}`)
      try {
        if (!rescueDirReady) {
          await mkdir(rescueDir, { recursive: true })
          rescueDirReady = true
        }
        const copied = await probe.copy(action.path, dest)
        if (copied.kind === 'copied') rescue = { kind: 'blob', path: dest }
        else if (copied.kind === 'failed') rescueError = copied.message
        // 'absent': the file is gone — rescue stays null, which is exactly
        // what rollback should restore (an absent path).
      } catch (error) {
        // The restore still proceeds exactly as before; rollback will skip
        // this path and report it instead of guessing.
        rescueError = error instanceof Error ? error.message : String(error)
      }
      // Pre-restore permissions (best-effort): a rollback must be able to put
      // back what the restore found, including a read-only file's bits.
      const rescueMode = (await stat(action.path).catch(() => undefined))?.mode
      const journalAction: RestoreJournalAction = {
        path: action.path,
        action: action.action,
        before: action.action === 'restore' ? action.before : null,
        rescue,
        ...(action.action === 'restore' && action.mode !== undefined ? { mode: action.mode } : {}),
        ...(action.parent !== undefined ? { parent: action.parent } : {}),
        ...(rescueMode !== undefined ? { rescueMode: rescueMode & 0o7777 } : {}),
        done: false,
      }
      if (rescueError !== undefined) journalAction.rescueError = rescueError
      journalActions.push(journalAction)
    }
    const journal: RestoreJournal = {
      version: 2,
      id,
      sessionId,
      targetSeq,
      startedAt: Date.now(),
      state: 'running',
      actions: journalActions,
    }
    await this.saveJournal(journal)
    return journal
  }

  /**
   * Read one journal by op id; undefined when it does not exist. A corrupt
   * journal THROWS (fail-loud): unlike checkpoint entries, silently dropping
   * a journal would silently erase the interrupted restore's recovery record.
   */
  private async readJournal(sessionId: string, opId: string): Promise<RestoreJournal | undefined> {
    const file = await this.findJournalFile(sessionId, opId)
    if (file === undefined) return undefined
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(file, 'utf8'))
    } catch (error) {
      throw new Error(`restore journal ${file} is corrupt: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!isRestoreJournal(parsed)) throw new Error(`restore journal ${file} failed schema validation`)
    const journal = journalFromJson(parsed as unknown as Record<string, unknown>, this.sessionDir(sessionId))
    if (journal === undefined) throw new Error(`restore journal ${file} failed schema validation`)
    journal.sourceFile = file
    return journal
  }

  /**
   * Every journal file of a session (both prefixes) — valid ones plus corrupt
   * ones with their error — so reconciliation can report corruption instead of
   * dropping it.
   */
  private async listJournals(sessionId: string): Promise<{ journals: RestoreJournal[]; corrupt: { file: string; message: string }[] }> {
    const sessionDir = this.sessionDir(sessionId)
    let names: string[]
    try {
      names = await readdir(sessionDir)
    } catch (error) {
      if (isEnoent(error)) return { journals: [], corrupt: [] }
      throw error
    }
    const journals: RestoreJournal[] = []
    const corrupt: { file: string; message: string }[] = []
    for (const name of names) {
      if (!isJournalName(name)) continue
      try {
        const parsed: unknown = JSON.parse(await readFile(join(sessionDir, name), 'utf8'))
        if (!isRestoreJournal(parsed)) {
          corrupt.push({ file: name, message: 'journal failed schema validation' })
          continue
        }
        const journal = journalFromJson(parsed as unknown as Record<string, unknown>, sessionDir)
        if (journal === undefined) {
          corrupt.push({ file: name, message: 'journal references are invalid' })
          continue
        }
        journal.sourceFile = join(sessionDir, name)
        journals.push(journal)
      } catch (error) {
        corrupt.push({ file: name, message: error instanceof Error ? error.message : String(error) })
      }
    }
    return { journals, corrupt }
  }

  /**
   * Execute ONE fs mutation with exactly the pre-journal semantics: a delete
   * runs through the injected deleteFile (ENOENT tolerated — the file is
   * already absent, i.e. the target state is reached), a restore copies the
   * recorded bytes back over the file (creating the parent if needed).
   *
   * This is the only place the store writes restored content to the real FS,
   * and it is deliberately raw `copyFile`/`writeFile`/`unlink` rather than the
   * fs service: the caller only ever hands it a path from `planRestore` — one
   * the session's own write-class tool call recorded and resolved (never a
   * symlink/hard link) and only when it differs from the live disk. So no
   * arbitrary path, no model input, never automatic.
   *
   * The write is IN PLACE (no temp + rename): it keeps the file's inode and
   * thus its xattrs/ACL, and crash safety is provided by the journal plus disk
   * reconciliation instead (a half-written file simply does not match the
   * goal, so a redo rewrites it).
   *
   * Permissions are best-effort (ADR-9/R3): the mode is only ever applied as
   * part of a CONTENT restore (never as a reason to plan one), and a chmod
   * failure never fails the restore.
   */
  private async applyActionToDisk(
    kind: 'restore' | 'delete',
    path: string,
    content: ByteSource | null,
    deleteFile: DeleteFile,
    mode?: number,
  ): Promise<'restored' | 'deleted' | 'enoent'> {
    if (kind === 'delete') {
      try {
        await deleteFile(path)
        return 'deleted'
      } catch (error) {
        if (!isEnoent(error)) throw error
        return 'enoent'
      }
    }
    if (content === null) throw new Error(`restore of ${path} has no recorded content`)
    // A `lossyText` target only occurs when CONTINUING a legacy journal: the
    // released build had already decided to write that content, and refusing
    // now would strand a half-restored workspace. A legacy ENTRY is never
    // written back (see `planRestore`), which is where the choice matters.
    await mkdir(dirname(path), { recursive: true })
    // A read-only target cannot be written: add owner-write for the attempt
    // and take it back afterwards (R3).
    const current = (await stat(path).catch(() => undefined))?.mode
    let widened = false
    if (current !== undefined && (current & 0o200) === 0) {
      await chmod(path, current | 0o200).catch(() => undefined)
      widened = true
    }
    try {
      if (content.kind === 'blob') await copyFile(content.path, path)
      else if (content.kind === 'text') await writeFile(path, content.bytes)
      else await writeFile(path, Buffer.from(content.text, 'utf8'))
    } catch (error) {
      if (widened && current !== undefined) await chmod(path, current).catch(() => undefined)
      throw error
    }
    // Best-effort: a filesystem that refuses chmod must never fail a restore
    // whose bytes landed (Windows permission bits, exotic mounts, …).
    if (mode !== undefined) await chmod(path, mode).catch(() => undefined)
    // No recorded mode (a legacy entry, or a link materialized without one):
    // the live bits are not ours to change, so only undo the widening.
    else if (widened && current !== undefined) await chmod(path, current).catch(() => undefined)
    return 'restored'
  }

  /**
   * Reconcile the session's restore journals against the real disk — the
   * "host restart" account: for every interrupted op, report which paths
   * already match its goal (restored) and which are still pending, and expose
   * any recorded failures. Journals whose goal is already fully reached on
   * disk (e.g. a later rewind completed the work) are auto-healed to their
   * terminal state and not reported. A corrupt journal is reported
   * `recovery-required` — never silently dropped.
   *
   * Deliberately NOT gated on the session's `store` marker: a journal is fully
   * self-describing (`version` plus byte references), and refusing to finish an
   * interrupted op merely because the SESSION marker looks newer would strand a
   * half-restored workspace — the outcome the legacy-journal support exists to
   * prevent. A reference the newer build moved shows up as a per-file failure,
   * never as a silent write.
   *
   * @param sessionId - session whose journals to reconcile.
   * @param probe - current-disk state probe (defaults to the real FS).
   * @returns one report per non-terminal journal still needing attention.
   */
  async reconcileRestores(sessionId: string, probe: DiskProbe = defaultProbe): Promise<RestoreReconcileReport[]> {
    const { journals, corrupt } = await this.listJournals(sessionId)
    const reports: RestoreReconcileReport[] = []
    for (const bad of corrupt) {
      reports.push({
        opId: journalOpIdOf(bad.file),
        state: 'recovery-required',
        journalState: 'recovery-required',
        targetSeq: 0,
        startedAt: 0,
        restored: [],
        pending: [],
        failed: [],
        corrupt: bad.message,
      })
    }
    for (const journal of journals) {
      if (journal.state === 'completed' || journal.state === 'rolled-back') continue
      const report = await this.reconcileJournal(journal, probe)
      if (report !== undefined) reports.push(report)
    }
    return reports.sort((a, b) => a.startedAt - b.startedAt || a.opId.localeCompare(b.opId))
  }

  /**
   * Reconcile ONE non-terminal journal against the real disk. Returns
   * undefined when the op's goal is already fully reached (auto-heals to the
   * terminal state); otherwise a report of restored/pending/failed paths.
   * For `running` journals the goal is the restore target; for
   * `rollback-running` / `recovery-required` journals it is the rescue
   * (pre-restore) state.
   */
  private async reconcileJournal(journal: RestoreJournal, probe: DiskProbe): Promise<RestoreReconcileReport | undefined> {
    const rollbackPhase = journal.state === 'rollback-running' || journal.state === 'recovery-required'
    const restored: string[] = []
    const pending: string[] = []
    const failed: { path: string; message: string }[] = []
    let allReached = true
    for (const action of journal.actions) {
      if (action.failed !== undefined) {
        // A recorded failure keeps the op non-terminal until a redo retries it.
        failed.push({ path: action.path, message: action.failed })
        allReached = false
        continue
      }
      let reached: boolean
      try {
        const goal = rollbackPhase ? action.rescue : action.action === 'delete' ? null : action.before
        reached = await probe.matches(goal, action.path) === true
      } catch {
        reached = false // probe failure: conservative — never silently dropped
      }
      if (reached) restored.push(action.path)
      else pending.push(action.path)
      if (!reached) allReached = false
    }
    if (allReached && failed.length === 0) {
      // The op's goal is already fully reached on disk: heal it to its
      // terminal state so it stops appearing as an interruption.
      if (rollbackPhase) journal.state = 'rolled-back'
      else journal.state = 'completed'
      journal.finishedAt = Date.now()
      await this.saveJournal(journal)
      return undefined
    }
    return {
      opId: journal.id,
      state: journal.state === 'recovery-required' ? 'recovery-required' : 'interrupted',
      journalState: journal.state,
      targetSeq: journal.targetSeq,
      startedAt: journal.startedAt,
      restored,
      pending,
      failed,
      ...(journal.rollbackError === undefined ? {} : { rollbackError: journal.rollbackError }),
    }
  }

  /**
   * Continue (redo) an interrupted restore: finish the op by applying every action
   * whose disk state does not yet match its goal — the restore target for
   * `running` journals. Actions are decided by the REAL disk (the same "disk
   * is truth" rule as reconciliation), so a crash between an fs op and its
   * done-mark is completed deterministically and a path the user already
   * fixed is marked done without being rewritten. Failed actions are retried;
   * a re-failure re-records the failure. The journal becomes `completed` once
   * every action reaches the target.
   */
  async continueRestore(
    sessionId: string,
    opId: string,
    deleteFile: DeleteFile,
    probe: DiskProbe = defaultProbe,
    opts?: RestoreRunOptions,
  ): Promise<RestoreOutcome> {
    const journal = await this.readJournal(sessionId, opId)
    if (journal === undefined) throw new Error(`restore journal ${opId} not found for session ${sessionId}`)
    if (journal.state !== 'running') {
      throw new Error(`restore journal ${opId} is in state ${journal.state}; only a running restore can be continued`)
    }
    const restored: string[] = []
    const deleted: string[] = []
    const failed: { path: string; message: string }[] = []
    for (let i = 0; i < journal.actions.length; i++) {
      const action = journal.actions[i]!
      opts?.crash?.('before-action', i) // test-only: crash before the fs op
      let reached: boolean
      try {
        const goal = action.action === 'delete' ? null : action.before
        reached = await probe.matches(goal, action.path) === true
      } catch {
        reached = false // probe failure: conservatively attempt the apply
      }
      if (reached) {
        // Already at the target (applied before the crash, or user-fixed):
        // mark it done without touching the disk.
        action.done = true
        delete action.failed
        await this.saveJournal(journal)
        continue
      }
      let applied: 'restored' | 'deleted' | 'enoent'
      try {
        applied = await this.applyActionToDisk(
          action.action,
          action.path,
          action.action === 'restore' ? action.before : null,
          deleteFile,
          action.action === 'restore' ? action.mode : undefined,
        )
        if (applied === 'enoent') {
          action.done = true
          await this.saveJournal(journal)
          continue
        }
      } catch (error) {
        action.failed = error instanceof Error ? error.message : String(error)
        await this.saveJournal(journal)
        failed.push({ path: action.path, message: action.failed })
        continue
      }
      opts?.crash?.('after-action', i) // test-only: crash before the done-mark
      action.done = true
      delete action.failed
      await this.saveJournal(journal)
      if (applied === 'restored') restored.push(action.path)
      else deleted.push(action.path)
    }
    if (journal.actions.every(action => action.done) && !journal.actions.some(action => action.failed !== undefined)) {
      journal.state = 'completed'
      journal.finishedAt = Date.now()
      await this.saveJournal(journal)
    }
    return { restored, deleted, skipped: [], failed }
  }

  /**
   * Roll back an interrupted restore: undo every action whose disk
   * state does not match its rescue (pre-restore) record, returning the
   * workspace to the exact state it had before the restore started. Decided
   * by the REAL disk, so actions the crash left applied-but-unmarked are
   * undone too, and a path already back at its rescue state is skipped —
   * the pass is idempotent across crashes (a retry finishes the remaining
   * actions). The journal moves `running` → `rollback-running` → `rolled-back`;
   * a failed undo leaves it `recovery-required` (retryable), and paths whose
   * rescue capture failed are reported and left untouched.
   */
  async rollbackRestore(
    sessionId: string,
    opId: string,
    deleteFile: DeleteFile,
    probe: DiskProbe = defaultProbe,
    opts?: RestoreRunOptions,
  ): Promise<RestoreOutcome> {
    const journal = await this.readJournal(sessionId, opId)
    if (journal === undefined) throw new Error(`restore journal ${opId} not found for session ${sessionId}`)
    if (journal.state === 'completed' || journal.state === 'rolled-back') {
      throw new Error(`restore journal ${opId} is already ${journal.state}`)
    }
    // A rollback is in flight: a crash between this write and the last rescue
    // application leaves the journal in 'rollback-running'; the pass is
    // idempotent, so a retry simply finishes the remaining actions.
    if (journal.state !== 'rollback-running') {
      journal.state = 'rollback-running'
      await this.saveJournal(journal)
    }
    const restored: string[] = []
    const deleted: string[] = []
    const failed: { path: string; message: string }[] = []
    let rollbackFailed = false
    for (let i = 0; i < journal.actions.length; i++) {
      const action = journal.actions[i]!
      if (action.rescueError !== undefined) {
        // The pre-restore state was never captured: this path cannot be
        // undone — report it and leave it untouched (recovery-required).
        journal.rollbackError = `rescue unavailable for ${action.path}: ${action.rescueError}`
        journal.state = 'recovery-required'
        await this.saveJournal(journal)
        failed.push({ path: action.path, message: journal.rollbackError })
        rollbackFailed = true
        continue
      }
      opts?.crash?.('before-action', i) // test-only: crash before the fs op
      let reached: boolean
      try {
        reached = await probe.matches(action.rescue, action.path) === true
      } catch {
        reached = false // probe failure: conservatively attempt the undo
      }
      if (reached) {
        // Already back at its pre-restore state: mark it undone.
        action.done = false
        await this.saveJournal(journal)
        continue
      }
      let applied: 'restored' | 'deleted' | 'enoent'
      try {
        applied = await this.applyActionToDisk(
          action.rescue === null ? 'delete' : 'restore',
          action.path,
          action.rescue,
          deleteFile,
          action.rescueMode,
        )
        if (applied === 'enoent') {
          action.done = false
          await this.saveJournal(journal)
          continue
        }
      } catch (error) {
        journal.rollbackError = error instanceof Error ? error.message : String(error)
        journal.state = 'recovery-required'
        await this.saveJournal(journal)
        failed.push({ path: action.path, message: journal.rollbackError })
        rollbackFailed = true
        continue
      }
      opts?.crash?.('after-action', i) // test-only: crash before the done-mark
      action.done = false
      await this.saveJournal(journal)
      if (applied === 'restored') restored.push(action.path)
      else deleted.push(action.path)
    }
    if (!rollbackFailed) {
      journal.state = 'rolled-back'
      journal.finishedAt = Date.now()
      await this.saveJournal(journal)
    }
    return { restored, deleted, skipped: [], failed }
  }

  /**
   * Drop the session's oldest anchor groups beyond `keep` (default
   * {@link MAX_ANCHOR_GROUPS}), deleting their whole directories. Also
   * recycles terminal restore journals (see {@link pruneTerminalJournals}),
   * so the per-commit cap bounds BOTH the checkpoint entries and the journal
   * accumulation.
   *
   * Because dedup links reference prior entries, eviction is LINK-AWARE: before
   * deleting the oldest groups, any SURVIVING (kept-group) link whose `ref`
   * lands on a real snapshot inside a doomed group is MATERIALIZED (rewritten
   * as a real snapshot carrying the resolved content), so no kept link is left
   * dangling. Links form a linear predecessor chain, so materializing the first
   * link after each doomed real is enough — later links already point at that
   * materialized entry (or at other kept links), requiring no rewrite.
   *
   * `opts.crash` is the test-only seam: a crash fired inside a materialization
   * write (between its temp write and rename) leaves ONLY a `.tmp` — the doomed
   * real is still on disk and the kept link still resolves, so nothing dangles
   * and a later prune simply re-materializes.
   */
  async prune(sessionId: string, keep = MAX_ANCHOR_GROUPS, opts?: { readonly crash?: (point: CrashPoint) => void }): Promise<void> {
    const sessionDir = this.sessionDir(sessionId)
    let names: string[]
    try {
      names = await readdir(sessionDir)
    } catch (error) {
      if (isEnoent(error)) return
      throw error
    }
    // Journal recycling and staged-capture collection must run even when no
    // anchor group is over the cap (a restore-only session never overflows the
    // 100 groups).
    await this.pruneTerminalJournals(sessionDir, names)
    await this.prunePendingCaptures(join(sessionDir, PENDING_DIR))
    const seqs = names.map(Number).filter(seq => Number.isSafeInteger(seq)).sort((a, b) => a - b)
    const excess = seqs.length - keep
    if (excess <= 0) return
    const doomed = new Set(seqs.slice(0, excess))
    // A NON-TERMINAL journal still needs the sidecars its actions reference:
    // evicting them would make the advertised "continue finishes the
    // interrupted op" impossible (the redo would fail per file). Those groups
    // are pinned, so the effective window may exceed `keep` until the op is
    // resolved — bounded by the number of unresolved journals.
    for (const seq of await this.pinnedAnchors(sessionDir, names)) doomed.delete(seq)
    if (doomed.size === 0) return
    // Materialize surviving links that reference a doomed group's real
    // snapshot. A link whose referent is ALREADY gone (dangling/corrupt) is
    // skipped — evicting cannot make it worse. But if a materialization WRITE
    // fails (transient IO or a crash), we abort prune BEFORE deleting anything,
    // so a still-needed real is never removed while a kept link references it.
    for (const seq of seqs.slice(excess)) {
      const files = await readdir(this.anchorDir(sessionId, seq)).catch(() => [] as string[])
      for (const file of files) {
        if (!file.endsWith('.json')) continue
        const entryFile = join(this.anchorDir(sessionId, seq), file)
        let entry: StoredEntry | undefined
        try {
          entry = await readEntry(entryFile, seq)
        } catch {
          // A newer-format entry (or an unreadable one): never touch it and
          // never let it abort the prune of unrelated groups.
          continue
        }
        if (entry === undefined || !isLinkEntry(entry)) continue
        if (!isSafeLinkRef(entry.ref)) continue // unsafe/corrupt ref: never follow it
        const refAnchor = refAnchorOf(entry.ref)
        if (!Number.isSafeInteger(refAnchor) || !doomed.has(refAnchor)) continue
        let source: ByteSource | null
        try {
          source = await this.resolveBefore(sessionId, entry)
        } catch (error) {
          if (error instanceof UnknownStoreVersionError) throw error
          continue // already-dangling link: not caused by this eviction
        }
        // NOTE: the materialized entry keeps the BYTES, not the resolved
        // entry's `mode` (a link carries no metadata of its own). A later
        // restore therefore treats the file's live permissions as its own —
        // the safe default — rather than replaying a mode it only inferred.
        // The link's own location pin DOES travel with it: dropping it would
        // silently re-open the repointed-ancestor hole for every entry prune
        // has materialized.
        const pin = entry.parent !== undefined ? { parent: entry.parent } : {}
        let real: CheckpointEntry
        if (source === null) {
          real = {
            callId: entry.callId,
            anchorSeq: entry.anchorSeq,
            path: entry.path,
            before: null,
            size: 0,
            ...pin,
            time: entry.time,
          }
        } else {
          // The bytes live in the doomed group: copy them next to the kept
          // entry as a sidecar of its own before publishing the real entry.
          const dest = join(dirname(entryFile), sidecarName(basename(entryFile)))
          await this.writeSidecar(dest, source)
          const st = await stat(dest)
          real = {
            callId: entry.callId,
            anchorSeq: entry.anchorSeq,
            path: entry.path,
            before: { kind: 'blob', path: dest },
            size: st.size,
            ...(source.kind === 'lossyText' ? { lossy: true } : {}),
            ...pin,
            time: entry.time,
          }
        }
        await writeJsonAtomic(entryFile, entryToJson(real), () => opts?.crash?.('after-temp-write'))
      }
    }
    for (const seq of doomed) {
      await rm(this.anchorDir(sessionId, seq), { recursive: true, force: true })
    }
    // Dropping groups can invalidate in-memory dedup handles that pointed into
    // them: forget this session's dedup state so the next commit re-seeds from
    // the surviving window instead of linking to a deleted sidecar (R1).
    this.seededSessions.delete(sessionId)
    for (const key of [...this.lastEntry.keys()]) {
      if (key.startsWith(`${sessionId}\0`)) this.lastEntry.delete(key)
    }
  }

  /**
   * Collect staged captures that were never committed and are older than
   * {@link PENDING_MAX_AGE_MS}: a crash between `tools/execute` and
   * `tools/post-execute` can leak one, and the process that would have
   * unlinked it is gone.
   */
  private async prunePendingCaptures(pendingDir: string): Promise<void> {
    let names: string[]
    try {
      names = await readdir(pendingDir)
    } catch {
      return
    }
    const cutoff = Date.now() - PENDING_MAX_AGE_MS
    for (const name of names) {
      const file = join(pendingDir, name)
      const st = await lstat(file).catch(() => undefined)
      if (st === undefined || !st.isFile() || st.mtimeMs >= cutoff) continue
      await rm(file, { force: true })
    }
  }

  /**
   * Anchor groups a NON-TERMINAL journal still depends on — the groups holding
   * the sidecars its actions restore from. `prune` must not evict them while
   * the op can still be finished. Rescue copies live under `rescue/`, never in
   * an anchor group, so only `before` references matter; a group is pinned only
   * for a well-formed, safe reference (a corrupt journal pins nothing).
   */
  private async pinnedAnchors(sessionDir: string, names: readonly string[]): Promise<Set<number>> {
    const pinned = new Set<number>()
    for (const name of names) {
      if (!isJournalName(name)) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(await readFile(join(sessionDir, name), 'utf8'))
      } catch {
        continue // unreadable: nothing to pin, and never a reason to fail prune
      }
      if (!isRestoreJournal(parsed)) continue
      const journal = journalFromJson(parsed as unknown as Record<string, unknown>, sessionDir)
      if (journal === undefined) continue
      if (journal.state === 'completed' || journal.state === 'rolled-back') continue
      for (const action of journal.actions) {
        const source = action.before
        if (source === null || source.kind !== 'blob') continue
        const ref = relative(sessionDir, source.path)
        // A byte reference (`<seq>/<base>.before`), not a link ref (`*.json`).
        if (!isSafeBackupRef(ref)) continue
        const anchor = refAnchorOf(ref)
        if (Number.isSafeInteger(anchor)) pinned.add(anchor)
      }
    }
    return pinned
  }

  /**
   * Recycle terminal restore journals (`completed` / `rolled-back`): once an
   * op finished, its journal and its rescue bytes are dead weight that would
   * otherwise accumulate without bound (one journal per both-mode rewind).
   * Non-terminal journals (crashed ops awaiting reconcile / continue /
   * rollback) and unclassifiable (corrupt) ones are ALWAYS kept — a recovery
   * record that cannot be classified is never destroyed.
   */
  private async pruneTerminalJournals(sessionDir: string, names: readonly string[]): Promise<void> {
    for (const name of names) {
      if (!isJournalName(name)) continue
      const file = join(sessionDir, name)
      try {
        const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<RestoreJournal>
        if (parsed.state === 'completed' || parsed.state === 'rolled-back') {
          await rm(file, { force: true })
          // A legacy journal has no rescue directory: force:true is a no-op.
          await rm(join(sessionDir, RESCUE_DIR, safeFileId(journalOpIdOf(name))), { recursive: true, force: true })
        }
      } catch {
        // Corrupt or unreadable: keep — never destroy a recovery record we
        // cannot classify.
      }
    }
  }

  /** True when a path exists on disk (used by tests and diagnostics). */
  async exists(path: string): Promise<boolean> {
    try {
      await stat(path)
      return true
    } catch (error) {
      if (isEnoent(error)) return false
      throw error
    }
  }

  /**
   * Cross-session retention sweep: remove WHOLE session directories whose
   * newest member stamp is older than `maxAgeDays` days of idle, keeping the
   * active session (`keepActiveId`) untouched. This is the anti-growth policy
   * for finished sessions (rewind only ever reads the active session, so a
   * finished session's backups are provably dead weight).
   *
   * SAFETY:
   *  - Only whole session directories are removed (dedup refs are
   *    session-relative, so there is no cross-session dangling to materialize);
   *  - the active session is never targeted (`keepActiveId`), and everything
   *    else is protected by its own mtime — a session that is still written to
   *    keeps scrolling its newest member stamp forward, so it is never old
   *    enough to be pruned;
   *  - a non-positive `maxAgeDays` throws instead of degenerating into a
   *    mass-destructive `cutoff` in the far future;
   *  - the walk uses `lstat` (no symlink following) and skips dot-prefixed
   *    temp left overs — except the real `.pending/` area, whose staged bytes
   *    are content and whose freshness is activity — so measurement stays
   *    inside the store root.
   *
   * `dryRun` computes and reports exactly what would be removed without
   * deleting anything — the `/snapshot-auto-cleanup run` preview.
   */
  async pruneStale(opts: { readonly keepActiveId?: string; readonly maxAgeDays: number; readonly dryRun?: boolean }): Promise<PruneStaleReport> {
    const { keepActiveId, dryRun = false } = opts
    const maxAgeDays = opts.maxAgeDays
    if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) {
      throw new RangeError('pruneStale: maxAgeDays must be a positive finite number')
    }
    const cutoffMs = Date.now() - maxAgeDays * 86_400_000
    let scanned = 0
    let deleted = 0
    let freedBytes = 0
    let kept = 0
    let skippedActive = 0
    let remainingBytes = 0
    const report = (): PruneStaleReport => ({ scanned, deleted, freedBytes, kept, remainingBytes, skippedActive, dryRun })

    let names: string[]
    try {
      names = await readdir(this.root)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return report()
      throw error
    }
    for (const name of names) {
      if (name.startsWith('.')) continue
      const full = join(this.root, name)
      let st: Stats
      try {
        st = await lstat(full)
      } catch {
        continue // raced away or unreadable: skip
      }
      if (!st.isDirectory()) continue
      scanned++

      // Active-session guard: never delete the session the caller is driving.
      if (keepActiveId !== undefined && safeSessionId(keepActiveId) === name) {
        skippedActive++
        remainingBytes += (await dirSizeAndLastActive(full)).size
        continue
      }
      const { size, lastActiveMs } = await dirSizeAndLastActive(full)
      if (lastActiveMs < cutoffMs) {
        deleted++
        freedBytes += size
        if (!dryRun) await rm(full, { recursive: true, force: true })
      } else {
        kept++
        remainingBytes += size
      }
    }
    // A dry run must not touch memory (its contract): only a real sweep drops
    // the in-memory state of the sessions it removed.
    if (!dryRun) await this.forgetMissingSessions()
    return report()
  }

  /**
   * All distinct paths ever recorded for a session — the "tracked files"
   * set. Mirrors Claude Code's global `trackedFiles` collection (files stay
   * tracked once a write-class tool touched them), derived from the disk
   * entries so no extra persistence is needed.
   */
  async trackedPaths(sessionId: string): Promise<Set<string>> {
    const paths = new Set<string>()
    for (const entry of await this.entriesAfter(sessionId, 0)) {
      paths.add(entry.path)
    }
    return paths
  }

  /**
   * Summarize a session's on-disk footprint for a clear dry-run: anchor-group
   * count, committed checkpoint-entry count (one per `.json` in an anchor
   * group), restore-journal count (both journal prefixes), and the total bytes
   * the session dir occupies — entry JSONs, raw byte sidecars, `rescue/**` and
   * the staged `.pending/**` copies alike, so the number matches what a `du` of
   * that directory reports.
   *
   * Walks with `lstat` (never follows a symlink, so a hostile symlink cannot
   * escape the store root or inflate the measurement) and skips dot-prefixed
   * temp leftovers (the one exception is `.pending/`, whose staged bytes are
   * real store content).
   */
  private async sessionStats(sessionId: string): Promise<{ anchorGroups: number; entries: number; journals: number; bytes: number }> {
    const sessionDir = this.sessionDir(sessionId)
    let names: string[]
    try {
      names = await readdir(sessionDir)
    } catch (error) {
      if (isEnoent(error)) return { anchorGroups: 0, entries: 0, journals: 0, bytes: 0 }
      throw error
    }
    let anchorGroups = 0
    let entries = 0
    let journals = 0
    let bytes = 0
    for (const name of names) {
      // Dot-prefixed temp leftovers are never store members; `.pending/` (and
      // the `rescue/` tree below) is the exception — staged and rescue bytes
      // are real store content.
      if (name.startsWith('.') && name !== PENDING_DIR) continue
      const full = join(sessionDir, name)
      const st = await lstat(full).catch(() => undefined)
      if (st === undefined) continue // raced away or unreadable: skip
      if (st.isDirectory()) {
        // Staged captures and pre-restore rescue copies are real store content:
        // they have no entry/journal count, but their bytes belong in the total.
        if (name === PENDING_DIR || name === RESCUE_DIR) {
          bytes += await dirBytes(full)
          continue
        }
        if (!Number.isSafeInteger(Number(name))) continue
        anchorGroups++
        for (const file of await readdir(full).catch(() => [] as string[])) {
          if (file.endsWith('.json')) entries++
        }
        // Count EVERY member (entry JSONs and raw byte sidecars alike) so the
        // reported footprint matches what the session dir actually occupies.
        bytes += await dirBytes(full)
        continue
      }
      if (!st.isFile()) continue
      if (isJournalName(name)) journals++
      bytes += st.size
    }
    return { anchorGroups, entries, journals, bytes }
  }

  /**
   * Remove a session's ENTIRE snapshot directory — every anchor group, every
   * checkpoint entry, and every restore journal — and reset the store's
   * in-memory dedup state so the session starts recording fresh from the
   * current workspace state. This is the manual "get rid of this session's
   * records NOW" action on the ACTIVE session the user is driving (it is never
   * targetable by id; that is a directory-manipulation concern the user can do
   * directly).
   *
   * SEMANTICS — clearing is an explicit abandonment: issuing the command means
   * the user accepts that this session's snapshot archive goes away. It is
   * therefore NOT gated on the state of any restore journal. A clear and a
   * restore are both slash commands the host runs to completion for an agent,
   * so they never interleave — any non-terminal journal present on disk is a
   * stale orphan from a previous (crashed) process, and discarding it is the
   * correct, safe resolution of that abandoned restore.
   *
   * SAFETY (this module's real concern is the plugin's ongoing BEHAVIOR, not
   * losing snapshots):
   *  - Only the session dir is removed; dedup refs are session-relative, so
   *    there is no cross-session dangling to materialize (the same rationale as
   *    {@link pruneStale}'s whole-dir removal).
   *  - The in-memory dedup state (`lastEntry` / `seededSessions`) is ALWAYS
   *    reset on an apply — even when the dir was already empty. A stale
   *    in-memory entry (e.g. a session whose dir was removed out-of-band) would
   *    otherwise link a later `recordEntry` to a deleted prior entry, leaving a
   *    dangling ref that breaks restore resolution. This is the primary
   *    correctness guarantee.
   *
   * `dryRun` computes the report without touching disk or memory.
   */
  async clearSession(sessionId: string, opts?: { readonly dryRun?: boolean }): Promise<ClearSessionReport> {
    const dryRun = opts?.dryRun ?? false
    const stats = await this.sessionStats(sessionId)
    if (!dryRun) {
      // Any store member means the dir is worth removing: entries, journals,
      // and the byte-only members `sessionStats` counts (a staged capture, a
      // rescue copy, a marker). `bytes > 0` covers the latter, so a dir that
      // holds ONLY staged bytes does not survive the clear that just reported
      // freeing them.
      if (stats.anchorGroups > 0 || stats.journals > 0 || stats.bytes > 0) {
        await rm(this.sessionDir(sessionId), { recursive: true, force: true })
      }
      // Always reset the in-memory dedup state on an apply — even when the dir
      // was already empty. A stale in-memory entry (e.g. a session whose dir was
      // removed out-of-band) would otherwise link a later recordEntry to a
      // deleted prior entry, leaving a dangling ref.
      this.forgetSession(sessionId)
    }
    return { sessionId, ...stats, dryRun }
  }

  /**
   * Read the session-format version marker recorded for a session, or `null`
   * when there is no marker — a pre-marker, legacy snapshot dir, or a session
   * that never materialized a dir.
   */
  private async readFormatVersion(sessionId: string): Promise<number | null> {
    try {
      const raw = await readFile(join(this.sessionDir(sessionId), SnapshotStore.FORMAT_FILE), 'utf8')
      const parsed = Number(raw.trim())
      return Number.isFinite(parsed) ? parsed : null
    } catch {
      return null
    }
  }

  /**
   * Record the session-format version a session's snapshots are anchored under
   * (`session.header.version`: 2 for the v2 format, 3 for the v3 format). The
   * marker is a tiny non-`.json` file, so it never counts as a checkpoint
   * entry in `sessionStats`/`clearSession`. Written atomically (temp + rename)
   * like every other persisted marker, so a crash mid-write can only leave an
   * inert `format.tmp` — never a partial marker that a later reconcile could
   * misread as a version mismatch and wrongly clear.
   */
  async markFormatVersion(sessionId: string, sessionVersion: number): Promise<void> {
    const dir = this.sessionDir(sessionId)
    await mkdir(dir, { recursive: true })
    const file = join(dir, SnapshotStore.FORMAT_FILE)
    const tmp = `${file}.tmp`
    await writeFile(tmp, `${sessionVersion}`, 'utf8')
    await rename(tmp, file)
  }

  /**
   * Set the session-format version the store stamps onto every snapshot it
   * records. The host sets this once per process from `agent/session-start`
   * (`agent.session.header.version`), so a marker is only materialized for a
   * session that actually records a snapshot.
   */
  setFormatVersion(sessionVersion: number): void {
    this.formatVersion = sessionVersion
  }

  /**
   * Read the plugin's STORE-format marker for a session, or null when there is
   * none (a released-v1 dir, or a session that never recorded a snapshot). The
   * marker is a quick session-level signal; every entry and journal is also
   * self-describing (`store` / `version`), so a missing marker never changes
   * how an entry is read.
   */
  async readStoreVersion(sessionId: string): Promise<number | null> {
    try {
      const raw = await readFile(join(this.sessionDir(sessionId), SnapshotStore.STORE_FILE), 'utf8')
      const parsed = Number(raw.trim())
      return Number.isFinite(parsed) ? parsed : null
    } catch {
      return null
    }
  }

  /**
   * Stamp the store-format marker (atomically, like `format`). Written
   * alongside every byte-format entry, so a session that only ever holds the
   * released string format keeps no marker and is read as v1.
   */
  async markStoreVersion(sessionId: string, storeVersion: number): Promise<void> {
    const dir = this.sessionDir(sessionId)
    await mkdir(dir, { recursive: true })
    const file = join(dir, SnapshotStore.STORE_FILE)
    const tmp = `${file}.tmp`
    await writeFile(tmp, `${storeVersion}`, 'utf8')
    await rename(tmp, file)
  }

  /**
   * Refuse to plan against (or write into) a session whose store format is
   * NEWER than this build understands (ADR-10): the caller reports it and
   * changes nothing — no partial restore, no clear, no v2 entry written into a
   * v3 store. Checked before any entry is read, so the marker alone is enough
   * to fail closed.
   */
  async assertKnownStoreVersion(sessionId: string): Promise<void> {
    const version = await this.readStoreVersion(sessionId)
    if (version !== null && version > CURRENT_STORE_VERSION) {
      throw new UnknownStoreVersionError(version, join(this.sessionDir(sessionId), SnapshotStore.STORE_FILE))
    }
  }

  /**
   * Session-format-version guard: clear a session's snapshot dir when the
   * format its snapshots were anchored under differs from the current session
   * format, so seq-anchored references can never survive a format migration
   * mis-mapped. Runs at `agent/session-start` — after DSH has migrated/loaded
   * the session, so `sessionVersion` is the post-migration value.
   *
   * Conservative rule (per the "delete stale snapshots" policy): a session
   * with no recorded marker but with snapshot content is treated as legacy and
   * cleared; a session whose marker differs from `sessionVersion` is cleared.
   * A matching version — or an untouched session with nothing to protect — is
   * left alone. The marker is re-stamped to the current version afterward so a
   * FUTURE format change is detected on the next start.
   *
   * @returns whether a session snapshot dir was cleared.
   */
  async reconcileFormatVersion(sessionId: string, sessionVersion: number): Promise<{ cleared: boolean }> {
    const stored = await this.readFormatVersion(sessionId)
    if (stored === sessionVersion) return { cleared: false }
    const stats = await this.sessionStats(sessionId)
    const hasContent = stats.anchorGroups > 0 || stats.journals > 0
    if (hasContent) {
      await this.clearSession(sessionId)
    }
    // Re-stamp only when there was something worth protecting (snapshots or a
    // prior marker) — never materialize a session dir for an untouched one.
    if (hasContent || stored !== null) {
      await this.markFormatVersion(sessionId, sessionVersion)
    }
    return { cleared: hasContent }
  }
}

/** Short content hash used to key synthetic recheck entries. */
function hashPath(path: string): string {
  return shortHash(path)
}

/**
 * Re-check every tracked file at a user-message boundary and record the
 * current on-disk state for any file whose state changed since it was last
 * seen — Claude Code's `fileHistoryMakeSnapshot` re-stats every tracked file
 * at each user message and snapshots the new state (changed files get a new
 * backup version, deleted files a null marker). Here the "new version" is a
 * plain before-backup entry anchored at the boundary message, so an EXTERNAL
 * edit or deletion (never seen by the write-class tool capture) enters the
 * record and can be restored by a later rewind.
 *
 * Semantics: the recorded `before` is the file's state at the boundary —
 * the state the boundary message's turn starts from, exactly like the
 * tool-captured entries. An entry is written only when the state differs
 * from the path's most-recent recorded content (`lastKnownContent`); a fresh
 * sighting (never recorded) always records. The state is compared against the
 * SAME single in-memory source `recordEntry` dedups against, so there is one
 * content copy and one comparison — not the two (a boundary map plus the
 * dedup map) the previous model held. Only CHANGED files are recorded, and
 * each is a full snapshot (`dedup: false`): a changed state always differs
 * from the recent record, so the link decision would never apply there.
 *
 * Symlinked / hard-linked paths are never re-checked (restores skip them).
 * A probe failure skips the file with a warning-level no-op; it never aborts
 * the boundary pass, and it never records the path as absent.
 *
 * @param store - the session's snapshot store.
 * @param sessionId - session whose tracked files to re-check.
 * @param anchorSeq - the boundary user-message seq (entry anchor).
 * @param tracked - the session's tracked path set (read-only here).
 * @param probe - current-disk state probe (defaults to the real FS).
 * @returns the number of entries recorded.
 */
export async function reconcileTracked(
  store: SnapshotStore,
  sessionId: string,
  anchorSeq: number,
  tracked: ReadonlySet<string>,
  probe: DiskProbe = defaultProbe,
): Promise<number> {
  try {
    await store.assertKnownStoreVersion(sessionId)
  } catch {
    // Snapshots written by a newer build: record nothing rather than mixing
    // formats into a store this build does not fully understand.
    return 0
  }
  let recorded = 0
  for (const path of tracked) {
    try {
      if (await probe.isLink(path)) continue
      const last = await store.lastKnownContent(sessionId, path)
      // A legacy record whose bytes were lost cannot be byte-compared: treat it
      // as "never recorded" and take a faithful byte copy (ADR-12: any doubt
      // fails toward storing MORE — and it heals the path for later rewinds).
      if (last !== undefined && last !== null && last.kind !== 'lossyText') {
        const same = await probe.matches(last, path)
        // Undecidable (IO failure): leave the file alone rather than guess.
        if (same === undefined || same) continue
      }
      // Changed (or never recorded): capture the current bytes as they are —
      // through a byte copy, so a binary file is recorded FAITHFULLY instead
      // of being decoded into U+FFFD or mistaken for an absent file.
      const callId = `recheck-${anchorSeq}-${hashPath(path)}`
      const staged = await store.stageCapture(sessionId, callId)
      const copied = await probe.copy(path, staged)
      if (copied.kind === 'failed') {
        await rm(staged, { force: true })
        continue
      }
      await store.recordBackup(sessionId, { callId, anchorSeq, path },
        copied.kind === 'absent' ? null : { file: staged, size: copied.size },
        { dedup: false })
      recorded++
    } catch {
      // Probe failure (unreadable file, IO error): skip this file; the
      // boundary pass never aborts, and `before: null` is only ever recorded
      // for a copy that proved the file is gone.
    }
  }
  return recorded
}
