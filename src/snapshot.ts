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
 *   anchor seq: `<root>/<sessionId>/<anchorSeq>/<callId>.json`, carrying the
 *   path and the before content (`before: null` = the file was created).
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
 *  - Checkpoint commits are ATOMIC: the entry JSON is written to a sibling
 *    temp file and renamed over the target, so a host crash mid-write can
 *    never leave a readable half-written entry — at worst an inert `.tmp`
 *    leftover that the next commit of the same file overwrites and that no
 *    reader ever picks up.
 *  - Every restore pass is JOURNALED. Before mutating anything the store
 *    captures the pre-restore ("rescue") state of each planned path and
 *    persists an intent journal (`restore-journal-<op>.json` in the session
 *    dir), then marks each action done as it is applied. A crash at any point
 *    leaves the journal on disk; after a host restart
 *    `reconcileRestores(sessionId)` re-derives from the REAL disk which
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
 * @module dsh-rewind/snapshot
 */

import { createHash } from 'node:crypto'
import type { Stats } from 'node:fs'
import { lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** Sub-directory of the harness home holding this plugin's snapshots. */
const SNAPSHOT_DIR_NAME = 'rewind-snapshots'

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

/** One committed before-backup, keyed by tool call. */
export interface CheckpointEntry {
  readonly callId: string
  /** Seq of the user message anchoring the turn in which the change happened. */
  readonly anchorSeq: number
  /** Resolved display path (absolute) of the tracked file. */
  readonly path: string
  /** Full content before the change; null when the file was created. */
  readonly before: string | null
  /** Epoch ms the entry was committed (stable ordering within a group). */
  readonly time: number
}

/**
 * One in-place dedup link, keyed by tool call. When a tracked file is
 * recorded with a `before` content identical to the immediately-prior entry
 * for that path, the entry is stored as a LINK instead of a full copy: it
 * carries no `before`, only a `ref` naming the prior entry file
 * (`<anchorSeq>/<callId>.json`). The linear (predecessor-chained) ref makes
 * restore resolution and prune materialization rewrite-free.
 *
 * The real-entry format ({@link CheckpointEntry}) is unchanged so existing
 * data reads identically; links are a NEW entry kind only the current build
 * understands (old-build reads of links are explicitly out of scope).
 */
export interface LinkEntry {
  readonly callId: string
  readonly anchorSeq: number
  readonly path: string
  /** `<anchorSeq>/<callId>.json` of the immediately-prior entry for the path. */
  readonly ref: string
  readonly time: number
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
  readonly before: string | null
  /**
   * Pre-restore disk state ("rescue"): the content the file had right before
   * the restore started, or null when it was absent. Rollback writes this
   * back, so the pre-restore state is recoverable exactly.
   */
  readonly rescue: string | null
  /** Set when the rescue capture failed: rollback then skips this path. */
  rescueError?: string
  /** True once the action's fs op completed and was marked. */
  done: boolean
  /** Per-action failure message; the restore pass never aborts. */
  failed?: string
}

/** Durable journal for one attempted restore (written atomically). */
export interface RestoreJournal {
  readonly version: 1
  readonly id: string
  readonly sessionId: string
  readonly targetSeq: number
  readonly startedAt: number
  finishedAt?: number
  state: RestoreJournalState
  readonly actions: RestoreJournalAction[]
  /** Set when a rollback pass failed partway (state becomes `recovery-required`). */
  rollbackError?: string
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
 * Current-on-disk state probe used by restore planning. Injected so the plan
 * logic runs against a fake FS in tests; the production default reads the
 * real file system with plain `node:fs` (see {@link defaultProbe}).
 */
export interface DiskProbe {
  /**
   * Full text of the file, or undefined when the file does not exist.
   * Any thrown error is treated as a probe failure: restore planning then
   * conservatively treats the file as DIFFERING from its record (a restore
   * still attempts the write / a delete still attempts the unlink), so an
   * unreadable file is never silently skipped.
   */
  readText(path: string): Promise<string | undefined>
  /** True when the path is a symlink or a hard link (never planned/restored). */
  isLink(path: string): Promise<boolean>
}

/** One restore action the planner derived from record + disk reconciliation. */
export type PlannedAction =
  | { readonly path: string; readonly action: 'restore'; readonly before: string }
  | { readonly path: string; readonly action: 'delete' }

/** Production probe: real reads via node:fs, links detected by lstat + nlink. */
export const defaultProbe: DiskProbe = {
  async readText(path: string): Promise<string | undefined> {
    try {
      return await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
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

/**
 * Structural validation of a parsed journal. Unlike checkpoint entries (whose
 * corruption is silently skipped), a corrupt journal is reported
 * fail-loud by `reconcileRestores` — silently dropping it would silently
 * erase the ability to recover the interrupted restore.
 */
function isRestoreJournal(value: unknown): value is RestoreJournal {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (typeof v.id !== 'string' || typeof v.sessionId !== 'string' || typeof v.targetSeq !== 'number') return false
  if (typeof v.state !== 'string' || !RESTORE_JOURNAL_STATES.has(v.state as RestoreJournalState)) return false
  if (!Array.isArray(v.actions)) return false
  return v.actions.every(action => {
    if (typeof action !== 'object' || action === null) return false
    const a = action as Record<string, unknown>
    return typeof a.path === 'string'
      && (a.action === 'restore' || a.action === 'delete')
      && (typeof a.before === 'string' || a.before === null)
      && (typeof a.rescue === 'string' || a.rescue === null)
      && typeof a.done === 'boolean'
  })
}

/**
 * Read one committed entry, or undefined when missing/corrupt. Returns a
 * {@link LinkEntry} when the file carries `ref` (no `before`), else a
 * {@link CheckpointEntry} — a real entry whose `before` is a string (content)
 * or null (the file was created).
 */
async function readEntry(file: string): Promise<StoredEntry | undefined> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
    if (typeof parsed.path !== 'string' || typeof parsed.anchorSeq !== 'number') return undefined
    const base = {
      callId: String(parsed.callId ?? ''),
      anchorSeq: parsed.anchorSeq,
      path: parsed.path,
      time: typeof parsed.time === 'number' ? parsed.time : 0,
    }
    if (typeof parsed.ref === 'string') {
      return { ...base, ref: parsed.ref }
    }
    return {
      ...base,
      before: typeof parsed.before === 'string' ? parsed.before : null,
    }
  } catch {
    return undefined
  }
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
 * Thrown by {@link SnapshotStore.clearSession} when the session holds a
 * NON-TERMINAL restore journal (`running` / `rollback-running` /
 * `recovery-required`). The clear is refused because the journal is the only
 * record of how to finish or undo that interrupted restore; the caller renders
 * a human instruction instead of destroying it. There is no override.
 */
export class PendingRestoreError extends Error {
  readonly pending: number

  constructor(pending: number) {
    super(`session has ${pending} restore record(s) that are not cleanly complete`)
    this.name = 'PendingRestoreError'
    this.pending = pending
  }
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
      if (name.startsWith('.')) continue
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
   * `<sessionId>\0<path>`. Each value holds the entry's effective `before`
   * content and its own file ref, so a new record with the same content links
   * to the immediately-prior entry (linear chain). Seeded lazily per session
   * from the bounded on-disk window, so dedup survives a host restart.
   */
  private readonly lastEntry = new Map<string, { content: string | null; ref: string }>()

  /** Sessions whose dedup state has been seeded from disk this process. */
  private readonly seededSessions = new Set<string>()

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
    return `${anchorSeq}/${safeFileId(callId)}.json`
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
      // most recent one. Resolve a link to its effective content.
      for (const entry of await this.entriesAfter(sessionId, 0)) {
        const key = `${sessionId}\0${entry.path}`
        if (this.lastEntry.has(key)) continue
        const content = await this.resolveBefore(sessionId, entry)
        this.lastEntry.set(key, { content, ref: this.entryRefOf(sessionId, entry.callId, entry.anchorSeq) })
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
  ): Promise<string | null> {
    if (!isLinkEntry(entry)) return entry.before
    const key = `${entry.anchorSeq}:${entry.callId}`
    if (seen.has(key)) throw new Error(`link cycle at ${entry.path} (${key})`)
    seen.add(key)
    if (!isSafeLinkRef(entry.ref)) throw new Error(`unsafe link ref ${entry.ref} for ${entry.path}`)
    const referenced = await readEntry(join(this.sessionDir(sessionId), entry.ref))
    if (referenced === undefined) throw new Error(`dangling link ${entry.ref} for ${entry.path}`)
    return this.resolveBefore(sessionId, referenced, seen)
  }

  /** Commit one before-backup (or an in-place dedup link) under its anchor. */
  async recordEntry(
    sessionId: string,
    entry: Omit<CheckpointEntry, 'time'>,
    opts?: { readonly dedup?: boolean; readonly crash?: (point: CrashPoint) => void },
  ): Promise<void> {
    // Monotonic time (see lastEntryTime): strictly increasing per store
    // instance, so same-millisecond commits stay capture-ordered.
    const time = Math.max(Date.now(), this.lastEntryTime + 1)
    this.lastEntryTime = time
    await this.ensureDedupSeeded(sessionId)
    const dir = this.anchorDir(sessionId, entry.anchorSeq)
    await mkdir(dir, { recursive: true })
    const file = join(dir, `${safeFileId(entry.callId)}.json`)
    const selfRef = this.entryRefOf(sessionId, entry.callId, entry.anchorSeq)
    // Content dedup: when the new `before` equals the path's most recent
    // recorded content, store a LINK to that prior entry instead of dup content.
    // The prior entry is the immediately-preceding one, giving a linear chain.
    // `dedup: false` skips the comparison and always writes a full copy — used
    // by the boundary, which only records CHANGED files and so never links.
    const key = `${sessionId}\0${entry.path}`
    const prior = this.lastEntry.get(key)
    if (this.dedup && opts?.dedup !== false && prior !== undefined && prior.content === entry.before) {
      const committed: LinkEntry = {
        callId: entry.callId,
        anchorSeq: entry.anchorSeq,
        path: entry.path,
        ref: prior.ref,
        time,
      }
      await writeJsonAtomic(file, committed, () => opts?.crash?.('after-temp-write'))
      // The new link is now the most-recent entry for the path (same content).
      this.lastEntry.set(key, { content: prior.content, ref: selfRef })
    } else {
      const committed: CheckpointEntry = { ...entry, time }
      await writeJsonAtomic(file, committed, () => opts?.crash?.('after-temp-write'))
      this.lastEntry.set(key, { content: entry.before, ref: selfRef })
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
   * The effective content recorded by the path's MOST RECENT entry, or
   * undefined when the path has never been recorded (a fresh tracking sight).
   * This is the single in-memory "last known state" the boundary uses to
   * decide whether a tracked file changed — the same source `recordEntry`
   * dedups against, so there is one content copy and one comparison per
   * decision, not two. Seeding is idempotent (once per session from disk).
   */
  async lastKnownContent(sessionId: string, path: string): Promise<string | null | undefined> {
    await this.ensureDedupSeeded(sessionId)
    return this.lastEntry.get(`${sessionId}\0${path}`)?.content
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
        const entry = await readEntry(join(this.anchorDir(sessionId, anchorSeq), file))
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
   * - `before === 'X'` plans a `restore` ONLY when the current content
   *   differs from X (or the file is missing); identical content is a no-op
   *   — this keeps repeated rewinds idempotent.
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
    const actions: PlannedAction[] = []
    const skipped: string[] = []
    const failed: { path: string; message: string }[] = []
    for (const entry of (await this.earliestEntries(sessionId, targetSeq)).values()) {
      try {
        if (await probe.isLink(entry.path)) {
          skipped.push(entry.path)
          continue
        }
        // A dedup link resolves to its terminal real content; a dangling or
        // cyclic link is a per-file integrity failure, never a silent skip.
        let before: string | null
        try {
          before = await this.resolveBefore(sessionId, entry)
        } catch (error) {
          failed.push({ path: entry.path, message: error instanceof Error ? error.message : String(error) })
          continue
        }
        const current = await probe.readText(entry.path)
        if (before === null) {
          // The file was created at/after the target: delete it when it is
          // still present. An absent file already matches the target state.
          if (current !== undefined) actions.push({ path: entry.path, action: 'delete' })
        } else if (current !== before) {
          // The file differs from its pre-edit content (or is missing):
          // write the before content back. Identical content is a no-op.
          actions.push({ path: entry.path, action: 'restore', before })
        }
      } catch (error) {
        // Probe failure: conservative — treat as differing. A restore still
        // attempts the write, a delete still attempts the unlink (failures
        // surface per-file in the restore outcome, never silently skipped).
        let before: string | null
        try {
          before = await this.resolveBefore(sessionId, entry)
        } catch {
          before = null
        }
        if (before === null) {
          actions.push({ path: entry.path, action: 'delete' })
        } else {
          actions.push({ path: entry.path, action: 'restore', before })
        }
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
        applied = await this.applyActionToDisk(action.action, action.path, action.action === 'restore' ? action.before : null, deleteFile)
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

  /** Prefix of one restore-op journal file inside the session dir. */
  private static readonly JOURNAL_PREFIX = 'restore-journal-'

  /** Absolute path of one restore-op journal file. */
  private journalPath(sessionId: string, opId: string): string {
    return join(this.sessionDir(sessionId), `${SnapshotStore.JOURNAL_PREFIX}${safeFileId(opId)}.json`)
  }

  /**
   * Best-effort journal persist: journal IO failures are non-fatal by design —
   * a restore must never fail because its audit journal could not be written.
   * reconcileRestores() re-derives the true state from the disk, so a missing
   * or stale journal only loses the trail, never the recovery ability.
   */
  private async saveJournal(journal: RestoreJournal): Promise<void> {
    try {
      await writeJsonAtomic(this.journalPath(journal.sessionId, journal.id), journal)
    } catch {
      // Non-fatal (see above).
    }
  }

  /**
   * Journal one restore pass before mutating anything: capture the rescue
   * (pre-restore) state of every planned path and persist the intent
   * atomically. Returns the in-memory journal; a persist failure degrades to
   * a journal-less restore (non-fatal, see {@link saveJournal}).
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
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      // Session dir does not exist yet (no entries ever recorded): nothing
      // to recycle.
    }
    const journalActions: RestoreJournalAction[] = []
    for (const action of actions) {
      let rescue: string | null = null
      let rescueError: string | undefined
      try {
        rescue = (await probe.readText(action.path)) ?? null
      } catch (error) {
        // Rescue capture failed (e.g. an unreadable file): the restore still
        // proceeds exactly as before; rollback will skip this path and report
        // it instead of guessing.
        rescueError = error instanceof Error ? error.message : String(error)
      }
      const journalAction: RestoreJournalAction = {
        path: action.path,
        action: action.action,
        before: action.action === 'restore' ? action.before : null,
        rescue,
        done: false,
      }
      if (rescueError !== undefined) journalAction.rescueError = rescueError
      journalActions.push(journalAction)
    }
    const journal: RestoreJournal = {
      version: 1,
      id: `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
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
    const file = this.journalPath(sessionId, opId)
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      throw new Error(`restore journal ${file} is corrupt: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!isRestoreJournal(parsed)) throw new Error(`restore journal ${file} failed schema validation`)
    return parsed
  }

  /**
   * Every journal file of a session — valid ones plus corrupt ones with their
   * error — so reconciliation can report corruption instead of dropping it.
   */
  private async listJournals(sessionId: string): Promise<{ journals: RestoreJournal[]; corrupt: { file: string; message: string }[] }> {
    const sessionDir = this.sessionDir(sessionId)
    let names: string[]
    try {
      names = await readdir(sessionDir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { journals: [], corrupt: [] }
      throw error
    }
    const journals: RestoreJournal[] = []
    const corrupt: { file: string; message: string }[] = []
    for (const name of names) {
      if (!name.startsWith(SnapshotStore.JOURNAL_PREFIX) || !name.endsWith('.json')) continue
      try {
        const parsed: unknown = JSON.parse(await readFile(join(sessionDir, name), 'utf8'))
        if (!isRestoreJournal(parsed)) {
          corrupt.push({ file: name, message: 'journal failed schema validation' })
          continue
        }
        journals.push(parsed)
      } catch (error) {
        corrupt.push({ file: name, message: error instanceof Error ? error.message : String(error) })
      }
    }
    return { journals, corrupt }
  }

  /**
   * Execute ONE fs mutation with exactly the pre-journal semantics: a delete
   * runs through the injected deleteFile (ENOENT tolerated — the file is
   * already absent, i.e. the target state is reached), a restore is a plain
   * writeFile with a recursive mkdir of the parent. Returns how the outcome
   * should record it.
   */
  private async applyActionToDisk(
    kind: 'restore' | 'delete',
    path: string,
    content: string | null,
    deleteFile: DeleteFile,
  ): Promise<'restored' | 'deleted' | 'enoent'> {
    if (kind === 'delete') {
      try {
        await deleteFile(path)
        return 'deleted'
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        return 'enoent'
      }
    }
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content!, 'utf8')
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
   * @param sessionId - session whose journals to reconcile.
   * @param probe - current-disk state probe (defaults to the real FS).
   * @returns one report per non-terminal journal still needing attention.
   */
  async reconcileRestores(sessionId: string, probe: DiskProbe = defaultProbe): Promise<RestoreReconcileReport[]> {
    const { journals, corrupt } = await this.listJournals(sessionId)
    const reports: RestoreReconcileReport[] = []
    for (const bad of corrupt) {
      reports.push({
        opId: bad.file.slice(SnapshotStore.JOURNAL_PREFIX.length, -'.json'.length),
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
        const state = (await probe.readText(action.path)) ?? null
        const goal = rollbackPhase ? action.rescue : action.action === 'delete' ? null : action.before
        reached = state === goal
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
   * 补做 (redo) an interrupted restore: finish the op by applying every action
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
        const state = (await probe.readText(action.path)) ?? null
        reached = state === (action.action === 'delete' ? null : action.before)
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
        applied = await this.applyActionToDisk(action.action, action.path, action.action === 'restore' ? action.before : null, deleteFile)
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
   * 回滚 (roll back) an interrupted restore: undo every action whose disk
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
        const state = (await probe.readText(action.path)) ?? null
        reached = state === action.rescue
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
        applied = await this.applyActionToDisk(action.rescue === null ? 'delete' : 'restore', action.path, action.rescue, deleteFile)
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
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    // Journal recycling must run even when no anchor group is over the cap
    // (a restore-only session never overflows the 100 groups).
    await this.pruneTerminalJournals(sessionDir, names)
    const seqs = names.map(Number).filter(seq => Number.isSafeInteger(seq)).sort((a, b) => a - b)
    const excess = seqs.length - keep
    if (excess <= 0) return
    const doomed = new Set(seqs.slice(0, excess))
    // Materialize surviving links that reference a doomed group's real
    // snapshot. A link whose referent is ALREADY gone (dangling/corrupt) is
    // skipped — evicting cannot make it worse. But if a materialization WRITE
    // fails (transient IO or a crash), we abort prune BEFORE deleting anything,
    // so a still-needed real is never removed while a kept link references it.
    for (const seq of seqs.slice(excess)) {
      const files = await readdir(this.anchorDir(sessionId, seq)).catch(() => [] as string[])
      for (const file of files) {
        if (!file.endsWith('.json')) continue
        const entry = await readEntry(join(this.anchorDir(sessionId, seq), file))
        if (entry === undefined || !isLinkEntry(entry)) continue
        if (!isSafeLinkRef(entry.ref)) continue // unsafe/corrupt ref: never follow it
        const slash = entry.ref.indexOf('/')
        const refAnchor = slash === -1 ? Number.NaN : Number(entry.ref.slice(0, slash))
        if (!Number.isSafeInteger(refAnchor) || !doomed.has(refAnchor)) continue
        let before: string | null
        try {
          before = await this.resolveBefore(sessionId, entry)
        } catch {
          continue // already-dangling link: not caused by this eviction
        }
        const real: CheckpointEntry = {
          callId: entry.callId,
          anchorSeq: entry.anchorSeq,
          path: entry.path,
          before,
          time: entry.time,
        }
        await writeJsonAtomic(join(this.anchorDir(sessionId, seq), file), real, () => opts?.crash?.('after-temp-write'))
      }
    }
    for (const seq of doomed) {
      await rm(this.anchorDir(sessionId, seq), { recursive: true, force: true })
    }
  }

  /**
   * Recycle terminal restore journals (`completed` / `rolled-back`): once an
   * op finished, its journal's before + rescue content is dead weight that
   * would otherwise accumulate without bound (one journal per both-mode
   * rewind). Non-terminal journals (crashed ops awaiting reconcile /
   * continue / rollback) and unclassifiable (corrupt) ones are ALWAYS kept —
   * a recovery record that cannot be classified is never destroyed.
   */
  private async pruneTerminalJournals(sessionDir: string, names: readonly string[]): Promise<void> {
    for (const name of names) {
      if (!name.startsWith(SnapshotStore.JOURNAL_PREFIX) || !name.endsWith('.json')) continue
      const file = join(sessionDir, name)
      try {
        const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<RestoreJournal>
        if (parsed.state === 'completed' || parsed.state === 'rolled-back') {
          await rm(file, { force: true })
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
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
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
   *    temp left overs, so measurement stays inside the store root.
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
   * count, committed checkpoint-entry count, restore-journal count, and total
   * bytes. Walks with `lstat` (never follows a symlink, so a hostile symlink
   * cannot escape the store root or inflate the measurement) and skips
   * dot-prefixed temp leftovers and non-`.json` members — they are never
   * checkpoint entries.
   */
  private async sessionStats(sessionId: string): Promise<{ anchorGroups: number; entries: number; journals: number; bytes: number }> {
    const sessionDir = this.sessionDir(sessionId)
    let names: string[]
    try {
      names = await readdir(sessionDir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { anchorGroups: 0, entries: 0, journals: 0, bytes: 0 }
      throw error
    }
    let anchorGroups = 0
    let entries = 0
    let journals = 0
    let bytes = 0
    for (const name of names) {
      if (name.startsWith('.')) continue
      const full = join(sessionDir, name)
      let st: Stats
      try {
        st = await lstat(full)
      } catch {
        continue // raced away or unreadable: skip
      }
      if (st.isDirectory()) {
        if (!Number.isSafeInteger(Number(name))) continue
        anchorGroups++
        let files: string[]
        try {
          files = await readdir(full)
        } catch {
          continue
        }
        for (const file of files) {
          if (!file.endsWith('.json')) continue
          entries++
          const fileSt = await lstat(join(full, file)).catch(() => undefined)
          if (fileSt !== undefined) bytes += fileSt.size
        }
      } else if (name.startsWith(SnapshotStore.JOURNAL_PREFIX) && name.endsWith('.json')) {
        journals++
        bytes += st.size
      }
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
   * SAFETY:
   *  - Only the session dir is removed; dedup refs are session-relative, so
   *    there is no cross-session dangling to materialize (the same rationale as
   *    {@link pruneStale}'s whole-dir removal).
   *  - A NON-TERMINAL restore journal (`running` / `rollback-running` /
   *    `recovery-required`) REFUSES the clear: discarding it would orphan a
   *    half-applied restore whose rescue state — the only record of how to
   *    finish or undo it — lives in that journal. There is deliberately no
   *    override: finish or roll back the restore first.
   *  - The in-memory dedup state (`lastEntry` / `seededSessions`) is reset
   *    ONLY when entries are actually removed, so a dry-run leaves the store
   *    untouched and a later `recordEntry` never links to a deleted prior
   *    entry (no dangling ref).
   *
   * `dryRun` computes the report without touching disk or memory.
   */
  async clearSession(sessionId: string, opts?: { readonly dryRun?: boolean }): Promise<ClearSessionReport> {
    const dryRun = opts?.dryRun ?? false
    const stats = await this.sessionStats(sessionId)
    if (!dryRun) {
      // Refuse while the session holds a recovery record that is not a cleanly
      // terminal restore: a non-terminal journal (an in-progress restore whose
      // rescue state is the only way to finish or undo it) OR an unclassifiable
      // (corrupt) journal. Same fail-loud invariant as the store's journaling —
      // never silently destroy a recovery record we cannot classify.
      const { journals, corrupt } = await this.listJournals(sessionId)
      const pending = journals.filter(journal => journal.state !== 'completed' && journal.state !== 'rolled-back').length + corrupt.length
      if (pending > 0) {
        throw new PendingRestoreError(pending)
      }
      if (stats.anchorGroups > 0 || stats.journals > 0) {
        await rm(this.sessionDir(sessionId), { recursive: true, force: true })
      }
      // Always reset the in-memory dedup state on an apply — even when the dir
      // was already empty. A stale in-memory entry (e.g. a session whose dir was
      // removed out-of-band) would otherwise link a later recordEntry to a
      // deleted prior entry, leaving a dangling ref.
      this.seededSessions.delete(sessionId)
      for (const key of this.lastEntry.keys()) {
        if (key.startsWith(`${sessionId}\0`)) this.lastEntry.delete(key)
      }
    }
    return { sessionId, ...stats, dryRun }
  }
}

/** Short content hash used to key synthetic recheck entries. */
function hashPath(path: string): string {
  return createHash('sha256').update(path).digest('hex').slice(0, 8)
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
 * A probe failure skips the file with a warning-level no-op; it never
 * aborts the boundary pass.
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
  let recorded = 0
  for (const path of tracked) {
    try {
      if (await probe.isLink(path)) continue
      const current = await probe.readText(path)
      const state: string | null = current ?? null
      const last = await store.lastKnownContent(sessionId, path)
      if (last === undefined || last !== state) {
        await store.recordEntry(sessionId, {
          callId: `recheck-${anchorSeq}-${hashPath(path)}`,
          anchorSeq,
          path,
          before: state,
        }, { dedup: false })
        recorded++
      }
    } catch {
      // Probe failure: skip this file; the boundary pass never aborts.
    }
  }
  return recorded
}
