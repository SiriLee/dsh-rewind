/**
 * In-memory change ledger: records every write-class tool mutation that
 * happened while the plugin was running, so a "rewind conversation and code"
 * can reverse the changes that followed a target message.
 *
 * Scope (v0.1): the ledger covers only `write` / `edit` / `str_replace_editor`
 * mutations observed through the tools pipeline while the plugin is loaded.
 * Changes made by bash or external programs are not recorded and cannot be
 * restored; a git-first snapshot layer is a v2 option.
 *
 * @module dsh-rewind/ledger
 */

import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { sessionCwd } from './session-cwd.ts'

/** One recorded write-class mutation. */
export interface LedgerEntry {
  /** Tool that made the change: `write` | `edit` | `str_replace_editor`. */
  readonly toolName: string
  /** Seq of the user message anchoring the turn in which the change happened. */
  readonly anchorSeq: number
  /** Display path (model/UI-facing), as resolved at record time. */
  readonly path: string
  /** Full file content before the change; undefined when the file was created. */
  readonly before: string | undefined
  /** Full file content after the change. */
  readonly after: string
}

/** Unique per-file impact of rewinding past a target message. */
export interface FileImpact {
  readonly path: string
  /** `restore` = the file existed before the target; `delete` = created after it. */
  readonly action: 'restore' | 'delete'
}

/** Result of one reverse restore pass. */
export interface RestoreOutcome {
  readonly restored: readonly string[]
  readonly deleted: readonly string[]
  readonly failed: readonly { path: string; message: string }[]
}

/** Deletes one file by its process path (the host supplies the backend-appropriate delete). */
export type DeleteFile = (processPath: string) => Promise<void>

/**
 * Per-session cap on recorded entries. The ledger is intentionally bounded so
 * an extremely long session cannot grow one entry list without limit; the
 * oldest entries are dropped first, so rewinds to very early messages in a
 * pathological session may lose the earliest file history (a declared
 * tradeoff, see README).
 */
export const MAX_LEDGER_ENTRIES = 2000

/**
 * Append-only change ledger. Entries are recorded in commit order; a rewind
 * replays them in reverse for the affected range. Bounded per session to
 * {@link MAX_LEDGER_ENTRIES} (oldest dropped first).
 */
export class RewindLedger {
  private readonly entries: LedgerEntry[] = []

  /** Record one committed mutation, dropping the oldest entry when over the cap. */
  record(entry: LedgerEntry): void {
    this.entries.push(entry)
    if (this.entries.length > MAX_LEDGER_ENTRIES) this.entries.shift()
  }

  /**
   * All entries anchored at or after `targetSeq`, newest first. The boundary
   * is inclusive: rewinding to a message also reverts the changes its own
   * turn caused (the rewind cut removes that turn's assistant response and
   * tool calls), so only changes anchored at earlier messages survive.
   */
  changesAfter(targetSeq: number): readonly LedgerEntry[] {
    const after: LedgerEntry[] = []
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i]!
      if (entry.anchorSeq >= targetSeq) after.push(entry)
    }
    return after
  }

  /**
   * Unique per-file impact for preview. A file whose earliest affected change
   * created it (`before === undefined`) is deleted on restore; any other file
   * is written back to its pre-target content.
   */
  impactsAfter(targetSeq: number): readonly FileImpact[] {
    const byPath = new Map<string, FileImpact>()
    for (const entry of this.entries) {
      if (entry.anchorSeq < targetSeq) continue
      if (byPath.has(entry.path)) continue
      byPath.set(entry.path, { path: entry.path, action: entry.before === undefined ? 'delete' : 'restore' })
    }
    return [...byPath.values()]
  }

  /**
   * Reverse every change anchored at or after `targetSeq`. Each entry writes
   * its pre-change content back; a file that did not exist before the target
   * is deleted instead. Failures are collected per file and never abort the pass.
   * @param fs - the filesystem service (resolve/readText/writeText/processPath).
   * @param deleteFile - backend-appropriate file deletion by process path.
   * @param targetSeq - the rewind target; only later changes are reverted.
   * @param options - session workspace cwd (relative ledger paths resolve
   *   against it, mirroring the fs tools) and an optional abort signal.
   */
  async restoreAfter(
    fs: FileSystem,
    deleteFile: DeleteFile,
    targetSeq: number,
    options: { cwd?: string; signal?: AbortSignal } = {},
  ): Promise<RestoreOutcome> {
    const restored: string[] = []
    const deleted: string[] = []
    const failed: { path: string; message: string }[] = []
    const restoredSet = new Set<string>()
    const deletedSet = new Set<string>()
    for (const entry of this.changesAfter(targetSeq)) {
      try {
        const cwd = sessionCwd(options.cwd, entry.path)
        const target = await fs.resolve(entry.path, {
          ...cwd !== undefined ? { cwd } : {},
          signal: options.signal,
        })
        if (entry.before === undefined) {
          await deleteFile(fs.processPath(target))
          if (!deletedSet.has(entry.path)) {
            deletedSet.add(entry.path)
            deleted.push(entry.path)
          }
        } else {
          await fs.writeText(target, entry.before, undefined, options.signal)
          if (!restoredSet.has(entry.path)) {
            restoredSet.add(entry.path)
            restored.push(entry.path)
          }
        }
      } catch (error) {
        failed.push({
          path: entry.path,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return { restored, deleted, failed }
  }
}
