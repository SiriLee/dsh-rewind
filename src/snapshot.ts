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
 * Restore semantics (identical to Claude Code): for every path with entries
 * anchored at or after the target message, apply the EARLIEST entry — write
 * the before content back, or delete the file when that entry recorded a
 * creation. Symlinked and hard-linked paths are skipped and reported, never
 * written through.
 *
 * @module dsh-rewind/snapshot
 */

import { lstat, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

/** Default store root: the dsh data directory. */
export const DEFAULT_SNAPSHOT_ROOT = join(homedir(), '.dsh', 'rewind-snapshots')

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

/** Read one committed entry, or undefined when missing/corrupt. */
async function readEntry(file: string): Promise<CheckpointEntry | undefined> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<CheckpointEntry>
    if (typeof parsed.path !== 'string' || typeof parsed.anchorSeq !== 'number') return undefined
    return {
      callId: String(parsed.callId ?? ''),
      anchorSeq: parsed.anchorSeq,
      path: parsed.path,
      before: typeof parsed.before === 'string' ? parsed.before : null,
      time: typeof parsed.time === 'number' ? parsed.time : 0,
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
 * On-disk checkpoint store. Every write goes straight through `node:fs`, so a
 * restore reliably lands on the real file system.
 */
export class SnapshotStore {
  /** Debounce window for the per-commit prune (keeps the readdir+sort off the hot path). */
  private static readonly PRUNE_INTERVAL_MS = 1000

  private lastPruneAt = 0

  constructor(readonly root: string = process.env[SNAPSHOT_ROOT_ENV] ?? DEFAULT_SNAPSHOT_ROOT) {}

  /** Absolute path of one session's snapshot directory (id sanitized). */
  sessionDir(sessionId: string): string {
    return join(this.root, safeSessionId(sessionId))
  }

  /** Absolute path of one anchor group directory. */
  anchorDir(sessionId: string, anchorSeq: number): string {
    return join(this.sessionDir(sessionId), String(anchorSeq))
  }

  /** Commit one before-backup under its turn's anchor group. */
  async recordEntry(
    sessionId: string,
    entry: Omit<CheckpointEntry, 'time'>,
  ): Promise<void> {
    const dir = this.anchorDir(sessionId, entry.anchorSeq)
    await mkdir(dir, { recursive: true })
    const committed: CheckpointEntry = { ...entry, time: Date.now() }
    await writeFile(join(dir, `${safeFileId(entry.callId)}.json`), JSON.stringify(committed), 'utf8')
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
   * All committed entries anchored at or after `targetSeq`, newest first (for
   * preview ordering). The boundary is inclusive: rewinding to a message also
   * reverts the changes its own turn caused (the rewind cut removes that
   * turn's assistant response and tool calls), so only entries anchored at
   * earlier messages survive.
   */
  async entriesAfter(sessionId: string, targetSeq: number): Promise<CheckpointEntry[]> {
    const sessionDir = this.sessionDir(sessionId)
    let names: string[]
    try {
      names = await readdir(sessionDir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const entries: CheckpointEntry[] = []
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
  private async earliestEntries(sessionId: string, targetSeq: number): Promise<Map<string, CheckpointEntry>> {
    const earliest = new Map<string, CheckpointEntry>()
    for (const entry of await this.entriesAfter(sessionId, targetSeq)) {
      const current = earliest.get(entry.path)
      if (current === undefined || entry.anchorSeq < current.anchorSeq || (entry.anchorSeq === current.anchorSeq && entry.time < current.time)) {
        earliest.set(entry.path, entry)
      }
    }
    return earliest
  }

  /** Per-file restore impact for the earliest entry at/after the target. */
  async impactsAfter(sessionId: string, targetSeq: number): Promise<FileImpact[]> {
    return [...(await this.earliestEntries(sessionId, targetSeq)).values()]
      .sort((a, b) => a.path.localeCompare(b.path))
      .map(entry => ({
        path: entry.path,
        action: entry.before === null ? 'delete' : 'restore',
      }))
  }

  /**
   * Restore the workspace to the target message's checkpoint: for every path
   * with entries anchored at or after it, apply the EARLIEST entry — write the
   * before content back, or delete the file when it was created after the
   * target. Symlinked and hard-linked paths are skipped (reported, never
   * written through); a restored file's parent directory is created when it
   * was deleted after the backup. Failures are per-file and never abort the
   * pass.
   */
  async restoreAfter(sessionId: string, targetSeq: number, deleteFile: DeleteFile): Promise<RestoreOutcome> {
    const restored: string[] = []
    const deleted: string[] = []
    const skipped: string[] = []
    const failed: { path: string; message: string }[] = []
    for (const entry of (await this.earliestEntries(sessionId, targetSeq)).values()) {
      try {
        if (await isLinkPath(entry.path)) {
          skipped.push(entry.path)
          continue
        }
        if (entry.before === null) {
          await deleteFile(entry.path)
          deleted.push(entry.path)
        } else {
          await mkdir(dirname(entry.path), { recursive: true })
          await writeFile(entry.path, entry.before, 'utf8')
          restored.push(entry.path)
        }
      } catch (error) {
        failed.push({ path: entry.path, message: error instanceof Error ? error.message : String(error) })
      }
    }
    return { restored, deleted, skipped, failed }
  }

  /**
   * Drop the session's oldest anchor groups beyond `keep` (default
   * {@link MAX_ANCHOR_GROUPS}), deleting their whole directories.
   */
  async prune(sessionId: string, keep = MAX_ANCHOR_GROUPS): Promise<void> {
    const sessionDir = this.sessionDir(sessionId)
    let names: string[]
    try {
      names = await readdir(sessionDir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const seqs = names.map(Number).filter(seq => Number.isSafeInteger(seq)).sort((a, b) => a - b)
    const excess = seqs.length - keep
    if (excess <= 0) return
    for (const seq of seqs.slice(0, excess)) {
      await rm(this.anchorDir(sessionId, seq), { recursive: true, force: true })
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
}
