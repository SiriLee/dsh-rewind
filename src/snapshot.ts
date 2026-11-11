/**
 * Checkpoint store — the file-rewind backing for dsh-rewind.
 *
 * Each user message gets one dense manifest (`Checkpoint.files`) describing
 * every tracked path's state when that message's step began. Content bytes
 * live in shared version files; the manifest only holds references. A rewind
 * reads the target message's manifest, takes the earliest later row for a path
 * first tracked after the target (the v1 fallback), reconciles it against the
 * live disk, and applies only the differences with a per-file atomic replace
 * or delete.
 *
 * All mutations run under a per-session promise lock. The newest 100 manifests
 * are retained; versions referenced by none of them are deleted after each new
 * checkpoint and on load. Old per-call snapshot layouts are never read: their
 * members are only counted by whole-session cleanup and removed with the
 * entire session directory.
 *
 * @module dsh-rewind/snapshot
 */

import { constants, type Stats } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, readFile, readdir, rename, rm, stat, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import {
  CHECKPOINTS_DIR,
  CURRENT_STORE_VERSION,
  META_FILE,
  VERSIONS_DIR,
  UnknownStoreVersionError,
  checkpointFileName,
  checkpointToJson,
  metaToJson,
  parseCheckpoint,
  parseMeta,
  safeSessionId,
  versionFileName,
  type Checkpoint,
  type ClearSessionReport,
  type FileImpact,
  type FileState,
  type PlannedAction,
  type PruneStaleReport,
  type RestoreOutcome,
  type SkippedPath,
  type UncoveredPath,
} from './snapshot-format.ts'
import {
  dirBytes,
  dirSizeAndLastActive,
  isEnoent,
  isUnsafeTarget,
  locationPin,
  parentStillMatches,
  sameFileBytes,
  writeJsonAtomic,
} from './snapshot-fs.ts'

export {
  CURRENT_STORE_VERSION,
  UnknownStoreVersionError,
  type Checkpoint,
  type ClearSessionReport,
  type FileImpact,
  type FileState,
  type PlannedAction,
  type PruneStaleReport,
  type RestoreOutcome,
  type SkippedPath,
  type UncoveredPath,
} from './snapshot-format.ts'

/** Sub-directory of the harness home holding this plugin's snapshots. */
const SNAPSHOT_DIR_NAME = 'rewind-snapshots'

/**
 * A regular file larger than this is NOT versioned. The cap keeps one oversized
 * file from dominating the store: an over-cap state produces no new version, and
 * a restore skips it while it stays over the cap. Exposed as the `maxFileBytes`
 * config field (`0` disables it).
 */
export const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024

/** Newest checkpoints kept per session (also the rewind candidate window). */
export const RETAINED_CHECKPOINTS = 100

/** Test-only seams; the production constructor never sets them. */
export interface CheckpointStoreHooks {
  /** Runs after the restore temp file is complete, before its rename. */
  readonly beforeRestoreRename?: () => void | Promise<void>
}

/** The session facts loading needs; kept structural so the store stays host-free. */
export interface StoreSession {
  readonly id: string
  /** DSH session format (`session.header.version`). */
  readonly version: number
  /** Every `user/message` id currently in the session log. */
  readonly messageIds: readonly string[]
}

/** One loaded manifest plus its absolute file name. */
interface StoredCheckpoint extends Checkpoint {
  readonly file: string
}

/** Per-session in-memory state. */
interface SessionState {
  readonly sessionId: string
  loaded: boolean
  unavailable?: UnknownStoreVersionError
  /** Retained manifests by absolute file name. */
  checkpoints: Map<string, StoredCheckpoint>
  /** Retained manifests in ascending `time` order. */
  order: StoredCheckpoint[]
  /** The last pre-step batch's newest manifest, for first-touch rows. */
  current?: StoredCheckpoint
  /** Paths in the newest manifest. */
  tracked: Set<string>
  /** Newest manifest time, for the monotonic clock. */
  lastTime: number
  /** Tail of the per-session mutation queue. */
  lock: Promise<unknown>
}

/** Options for {@link SnapshotStore}. */
export interface SnapshotStoreOptions {
  readonly dshHome?: string
  /** Per-file cap in bytes; `<= 0` disables it. */
  readonly maxFileBytes?: number
  /** Test-only seams. */
  readonly testHooks?: CheckpointStoreHooks
}

/** One restore plan. */
interface RestorePlan {
  readonly actions: PlannedAction[]
  readonly skipped: SkippedPath[]
  readonly failed: { readonly path: string; readonly message: string }[]
  readonly uncovered: UncoveredPath[]
  readonly noCheckpoint: boolean
}

/** On-disk checkpoint store. Every write goes through `node:fs`. */
export class SnapshotStore {
  /** Resolved store root (absolute). */
  readonly root: string

  private readonly maxFileBytes: number
  private readonly hooks: CheckpointStoreHooks

  private readonly sessions = new Map<string, SessionState>()
  private readonly legacyWarned = new Set<string>()

  constructor(root?: string, opts?: SnapshotStoreOptions) {
    this.maxFileBytes = opts?.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
    this.hooks = opts?.testHooks ?? {}
    this.root = root ?? join(resolveDshHome(opts?.dshHome), SNAPSHOT_DIR_NAME)
  }

  /** Absolute path of one session's store directory. */
  sessionDir(sessionId: string): string {
    return join(this.root, safeSessionId(sessionId))
  }

  /** True when `size` is over the per-file cap. */
  isOverFileCap(size: number | undefined): boolean {
    return this.maxFileBytes > 0 && size !== undefined && size > this.maxFileBytes
  }

  /** The cap in force, for reporting (0 = unlimited). */
  get fileCapBytes(): number {
    return this.maxFileBytes
  }

  /** Whether this store has already loaded `sessionId`. */
  isLoaded(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.loaded === true
  }

  /** True when a path exists on disk. */
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
   * Load (or reload) one session: read meta, drop corrupt/orphan manifests,
   * retain the newest 100, and GC. Returns one-time warnings for the caller to
   * log. A newer store sets the session unavailable instead of throwing.
   */
  async loadSession(session: StoreSession, opts?: { readonly force?: boolean }): Promise<{ warnings: string[] }> {
    return await this.withLock(session.id, async (state) => {
      if (state.loaded && opts?.force !== true) return { warnings: [] }
      this.resetState(state)
      const warnings: string[] = []
      await this.loadLocked(state, session, warnings)
      state.loaded = true
      return { warnings }
    })
  }

  /**
   * Create one dense checkpoint per user message in `messageIds`, all with the
   * same pre-step file states and increasing times; the last becomes current.
   * Returns per-file warnings; the caller logs them without blocking the step.
   */
  async createCheckpoints(
    sessionId: string,
    sessionVersion: number,
    messageIds: readonly string[],
  ): Promise<{ warnings: string[] }> {
    if (messageIds.length === 0) return { warnings: [] }
    return await this.withLock(sessionId, async (state) => {
      this.assertUsable(state)
      // A failed creation leaves no current checkpoint: later first touches in
      // this turn must not migrate into the previous message's manifest.
      state.current = undefined
      const warnings: string[] = []
      const previous = state.order.at(-1)
      const files = previous === undefined ? {} : await this.scanFiles(sessionId, previous.files, warnings)
      const created: StoredCheckpoint[] = []
      let lastTime = state.lastTime
      await this.ensureMeta(sessionId, sessionVersion)
      try {
        for (const messageId of messageIds) {
          const time = Math.max(Date.now(), lastTime + 1)
          lastTime = time
          const checkpoint: StoredCheckpoint = {
            store: CURRENT_STORE_VERSION,
            messageId,
            time,
            files: { ...files },
            file: join(this.checkpointsDir(sessionId), checkpointFileName(messageId)),
          }
          await writeJsonAtomic(checkpoint.file, checkpointToJson(checkpoint))
          created.push(checkpoint)
        }
      } catch (error) {
        for (const checkpoint of created) await rm(checkpoint.file, { force: true })
        throw error
      }
      for (const checkpoint of created) {
        state.checkpoints.set(checkpoint.file, checkpoint)
        state.order.push(checkpoint)
      }
      state.lastTime = lastTime
      state.current = created.at(-1)
      state.tracked = new Set(Object.keys(state.current!.files))
      this.trimRetained(state)
      try {
        warnings.push(...await this.gc(sessionId, state))
      } catch (error) {
        warnings.push(`checkpoint GC failed: ${messageOf(error)}`)
      }
      return { warnings }
    })
  }

  /**
   * Drop the current checkpoint reference without touching disk. Used when a
   * step's batch could not be checkpointed: first touches in the rest of that
   * turn are skipped instead of landing in the previous message's manifest.
   */
  async abandonCurrent(sessionId: string): Promise<void> {
    await this.withLock(sessionId, async (state) => {
      state.current = undefined
    })
  }

  /**
   * Record the pre-touch state of a path the current step has not seen yet.
   * A missing current checkpoint means the plugin mounted mid-turn: skip, so
   * later rows can never migrate into the previous message's manifest.
   */
  async captureFirstTouch(sessionId: string, path: string): Promise<{ recorded: boolean; warnings: string[] }> {
    return await this.withLock(sessionId, async (state) => {
      if (!state.loaded) throw new Error(`checkpoint store for ${sessionId} is not loaded`)
      if (state.unavailable !== undefined) throw state.unavailable
      const current = state.current
      if (current === undefined) return { recorded: false, warnings: [] }
      if (Object.hasOwn(current.files, path)) return { recorded: false, warnings: [] }
      const warnings: string[] = []
      let live: Stats | undefined
      try {
        live = await lstat(path)
      } catch (error) {
        if (!isEnoent(error)) {
          warnings.push(`first-touch probe failed for ${path}: ${messageOf(error)}`)
          return { recorded: false, warnings }
        }
      }
      const parent = await locationPin(path)
      if (parent === undefined) {
        warnings.push(`first-touch skipped ${path}: no location pin`)
        return { recorded: false, warnings }
      }
      let row: FileState
      if (live === undefined) {
        row = { v: 1, blob: null, parent }
      } else {
        if (!live.isFile() || live.nlink > 1) return { recorded: false, warnings }
        if (this.isOverFileCap(live.size)) return { recorded: false, warnings }
        let written: { name: string; size: number }
        try {
          written = await this.writeVersion(sessionId, path, 1)
        } catch (error) {
          warnings.push(`first-touch copy failed for ${path}: ${messageOf(error)}`)
          return { recorded: false, warnings }
        }
        row = { v: 1, blob: written.name, size: written.size, mode: live.mode & 0o7777, parent }
      }
      current.files[path] = row
      try {
        await writeJsonAtomic(current.file, checkpointToJson(current))
      } catch (error) {
        delete current.files[path]
        throw error
      }
      state.tracked.add(path)
      return { recorded: true, warnings }
    })
  }

  /**
   * Compute one target's preview in a single plan pass: the actions that would
   * change the disk and the tracked paths currently over the per-file cap.
   */
  async preview(sessionId: string, messageId: string): Promise<{
    readonly files: readonly FileImpact[]
    readonly uncovered: readonly UncoveredPath[]
  }> {
    return await this.withLock(sessionId, async (state) => {
      this.assertUsable(state)
      const plan = await this.planLocked(state, messageId)
      return {
        files: plan.actions
          .map(action => ({ path: action.path, action: action.action }))
          .sort((a, b) => a.path.localeCompare(b.path)),
        uncovered: plan.uncovered,
      }
    })
  }

  /** Restore the workspace to one message's checkpoint. */
  async restoreAfter(sessionId: string, messageId: string): Promise<RestoreOutcome> {
    return await this.withLock(sessionId, async (state) => {
      this.assertUsable(state)
      const plan = await this.planLocked(state, messageId)
      const restored: string[] = []
      const deleted: string[] = []
      const skipped: SkippedPath[] = [...plan.skipped]
      const failed: { path: string; message: string }[] = [...plan.failed]
      if (plan.noCheckpoint) {
        return { restored, deleted, skipped, failed, noCheckpoint: true }
      }
      for (const action of plan.actions) {
        if (!(await parentStillMatches(action.path, action.parent))) {
          skipped.push({ path: action.path, reason: 'parent' })
          continue
        }
        if (await isUnsafeTarget(action.path)) {
          skipped.push({ path: action.path, reason: 'unsafe' })
          continue
        }
        if (action.action === 'delete') {
          try {
            await unlink(action.path)
            deleted.push(action.path)
          } catch (error) {
            if (!isEnoent(error)) failed.push({ path: action.path, message: messageOf(error) })
          }
          continue
        }
        try {
          await this.applyRestore(action)
          restored.push(action.path)
        } catch (error) {
          failed.push({ path: action.path, message: messageOf(error) })
        }
      }
      return { restored, deleted, skipped, failed, noCheckpoint: false }
    })
  }


  /** Read the store format marker, or `null` when absent/unreadable. */
  async readStoreVersion(sessionId: string): Promise<number | null> {
    try {
      const raw = JSON.parse(await readFile(join(this.sessionDir(sessionId), META_FILE), 'utf8')) as unknown
      return parseMeta(raw)?.store ?? null
    } catch {
      return null
    }
  }

  /** Remove one session's entire directory and reset its in-memory state. */
  async clearSession(sessionId: string, opts?: { readonly dryRun?: boolean }): Promise<ClearSessionReport> {
    const dryRun = opts?.dryRun ?? false
    return await this.withLock(sessionId, async (state) => {
      const entries = await this.countCheckpoints(sessionId)
      const bytes = await dirBytes(this.sessionDir(sessionId))
      if (!dryRun) {
        await rm(this.sessionDir(sessionId), { recursive: true, force: true })
        this.resetState(state)
      }
      return { sessionId, entries, bytes, dryRun }
    })
  }

  /** Remove idle session directories, keeping the active one. */
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
      if (isEnoent(error)) return report()
      throw error
    }
    for (const name of names) {
      const full = join(this.root, name)
      const st = await lstat(full).catch(() => undefined)
      if (st === undefined || !st.isDirectory()) continue
      scanned++
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
    if (!dryRun) await this.forgetMissingSessions()
    return report()
  }

  /**
   * Number of snapshots in one session directory for the clear report: current
   * manifests plus legacy per-call entry JSONs (whole-session cleanup reports
   * everything it removes). Legacy members are counted by name only; their
   * contents are never read.
   */
  private async countCheckpoints(sessionId: string): Promise<number> {
    let count = (await readdir(this.checkpointsDir(sessionId)).catch(() => [] as string[]))
      .filter(name => name.endsWith('.json')).length
    const legacyDirs = (await readdir(this.sessionDir(sessionId)).catch(() => [] as string[]))
      .filter(name => /^\d+$/.test(name))
    for (const name of legacyDirs) {
      count += (await readdir(join(this.sessionDir(sessionId), name)).catch(() => [] as string[]))
        .filter(file => file.endsWith('.json')).length
    }
    return count
  }

  /** Store directories for one session. */
  private checkpointsDir(sessionId: string): string {
    return join(this.sessionDir(sessionId), CHECKPOINTS_DIR)
  }

  private versionsDir(sessionId: string): string {
    return join(this.sessionDir(sessionId), VERSIONS_DIR)
  }

  /** Create the per-session meta file at the first checkpoint. */
  private async ensureMeta(sessionId: string, sessionVersion: number): Promise<void> {
    const dir = this.sessionDir(sessionId)
    const metaPath = join(dir, META_FILE)
    // A valid meta from an earlier run can outlive a removed checkpoints dir
    // (out-of-band cleanup); every checkpoint write needs its parent.
    await mkdir(this.checkpointsDir(sessionId), { recursive: true })
    try {
      await stat(metaPath)
      return
    } catch (error) {
      if (!isEnoent(error)) throw error
    }
    await mkdir(dir, { recursive: true })
    await writeJsonAtomic(metaPath, metaToJson({ store: CURRENT_STORE_VERSION, sessionFormat: sessionVersion }))
  }

  /** Re-read every tracked path for one new message boundary. */
  private async scanFiles(
    sessionId: string,
    previous: Record<string, FileState>,
    warnings: string[],
  ): Promise<Record<string, FileState>> {
    const next: Record<string, FileState> = {}
    for (const [path, row] of Object.entries(previous)) {
      next[path] = await this.recheckRow(sessionId, path, row, warnings)
    }
    return next
  }

  /** Reconcile one path's recorded row against the live disk. */
  private async recheckRow(
    sessionId: string,
    path: string,
    previous: FileState,
    warnings: string[],
  ): Promise<FileState> {
    let live: Stats | undefined
    try {
      live = await lstat(path)
    } catch (error) {
      if (!isEnoent(error)) {
        warnings.push(`checkpoint probe failed for ${path}: ${messageOf(error)}`)
        return previous
      }
    }
    const parent = await locationPin(path)
    if (live === undefined) {
      if (previous.blob === null) return previous
      if (parent === undefined) {
        warnings.push(`checkpoint skipped ${path}: no location pin`)
        return previous
      }
      return { v: previous.v + 1, blob: null, parent }
    }
    if (!live.isFile() || live.nlink > 1) return previous
    if (this.isOverFileCap(live.size)) return previous
    if (parent === undefined) {
      warnings.push(`checkpoint skipped ${path}: no location pin`)
      return previous
    }
    const same = await this.contentUnchanged(sessionId, path, previous, live)
    if (same) {
      return { ...previous, mode: live.mode & 0o7777, parent }
    }
    let written: { name: string; size: number }
    try {
      written = await this.writeVersion(sessionId, path, previous.v + 1)
    } catch (error) {
      warnings.push(`checkpoint copy failed for ${path}: ${messageOf(error)}`)
      return previous
    }
    return {
      v: previous.v + 1,
      blob: written.name,
      size: written.size,
      mode: live.mode & 0o7777,
      parent,
    }
  }

  /** `(size, mtime)` fast path, then a streaming byte compare. */
  private async contentUnchanged(
    sessionId: string,
    path: string,
    previous: FileState,
    live: Stats,
  ): Promise<boolean> {
    if (previous.blob === null || previous.size === undefined) return false
    const versionPath = join(this.versionsDir(sessionId), previous.blob)
    const version = await lstat(versionPath).catch(() => undefined)
    if (version === undefined || !version.isFile() || version.size !== previous.size) return false
    if (live.size === previous.size && live.mtimeMs < version.mtimeMs) return true
    try {
      return await sameFileBytes(versionPath, path)
    } catch {
      return false
    }
  }

  /** Copy current bytes into a version file (temp + rename). */
  private async writeVersion(sessionId: string, path: string, v: number): Promise<{ name: string; size: number }> {
    const dir = this.versionsDir(sessionId)
    await mkdir(dir, { recursive: true })
    const name = versionFileName(path, v)
    const dest = join(dir, name)
    const temp = `${dest}.tmp`
    try {
      // A crash leftover is inert; EXCL also refuses a symlink planted at the
      // temp name instead of following it.
      await rm(temp, { force: true }).catch(() => undefined)
      await copyFile(path, temp, constants.COPYFILE_EXCL)
      const copied = await stat(temp)
      await rename(temp, dest)
      return { name, size: copied.size }
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined)
      throw error
    }
  }

  /** Compute the restore plan while holding the session lock. */
  private async planLocked(state: SessionState, messageId: string): Promise<RestorePlan> {
    const target = state.order.find(checkpoint => checkpoint.messageId === messageId)
    if (target === undefined || state.order.length === 0) {
      return { actions: [], skipped: [], failed: [], uncovered: [], noCheckpoint: true }
    }
    const latest = state.order[state.order.length - 1]!
    const actions: PlannedAction[] = []
    const skipped: SkippedPath[] = []
    const failed: { path: string; message: string }[] = []
    const uncovered: UncoveredPath[] = []
    for (const path of Object.keys(latest.files)) {
      const row = Object.hasOwn(target.files, path)
        ? target.files[path]!
        : this.firstRowAfter(state, target.time, path)
      if (row === undefined) {
        skipped.push({ path, reason: 'missing' })
        continue
      }
      if (row.parent === undefined) {
        skipped.push({ path, reason: 'parent' })
        continue
      }
      if (row.blob === null) {
        const live = await lstat(path).catch((error: unknown) => {
          if (!isEnoent(error)) return undefined
          return null
        })
        if (live === null) continue
        if (live !== undefined && live.isFile() && this.isOverFileCap(live.size)) {
          uncovered.push({ path, size: live.size })
        }
        if (live !== undefined && !(await parentStillMatches(path, row.parent))) {
          skipped.push({ path, reason: 'parent' })
          continue
        }
        if (await isUnsafeTarget(path)) {
          skipped.push({ path, reason: 'unsafe' })
          continue
        }
        actions.push({ path, action: 'delete', parent: row.parent })
        continue
      }
      const source = join(this.versionsDir(state.sessionId), row.blob)
      const version = await lstat(source).catch(() => undefined)
      if (version === undefined || !version.isFile() || version.size !== row.size) {
        failed.push({ path, message: 'recorded version is missing or has the wrong size' })
        continue
      }
      if (!(await parentStillMatches(path, row.parent))) {
        skipped.push({ path, reason: 'parent' })
        continue
      }
      if (await isUnsafeTarget(path)) {
        skipped.push({ path, reason: 'unsafe' })
        continue
      }
      const live = await lstat(path).catch(() => undefined)
      if (live !== undefined && live.isFile() && this.isOverFileCap(live.size)) {
        uncovered.push({ path, size: live.size })
        skipped.push({ path, reason: 'oversized' })
        continue
      }
      if (live !== undefined && live.isFile() && live.size === row.size && live.mtimeMs < version.mtimeMs) {
        continue
      }
      if (live !== undefined && live.isFile()) {
        let same: boolean
        try {
          same = await sameFileBytes(source, path)
        } catch (error) {
          failed.push({ path, message: messageOf(error) })
          continue
        }
        if (same) continue
      }
      actions.push({
        path,
        action: 'restore',
        source,
        size: row.size!,
        ...(row.mode !== undefined ? { mode: row.mode } : {}),
        parent: row.parent,
      })
    }
    actions.sort((a, b) => a.path.localeCompare(b.path))
    uncovered.sort((a, b) => a.path.localeCompare(b.path))
    return { actions, skipped, failed, uncovered, noCheckpoint: false }
  }

  /** Earliest retained row containing `path` strictly after `time`. */
  private firstRowAfter(state: SessionState, time: number, path: string): FileState | undefined {
    for (const checkpoint of state.order) {
      if (checkpoint.time <= time) continue
      if (Object.hasOwn(checkpoint.files, path)) return checkpoint.files[path]
    }
    return undefined
  }

  /** Atomically replace one target with a version file. */
  private async applyRestore(action: Extract<PlannedAction, { action: 'restore' }>): Promise<void> {
    await mkdir(dirname(action.path), { recursive: true })
    const temp = `${action.path}.rewind-tmp`
    try {
      // The target directory is workspace-writable; never follow a symlink an
      // attacker planted at the temp name. EXCL refuses an existing entry.
      await rm(temp, { force: true }).catch(() => undefined)
      await copyFile(action.source, temp, constants.COPYFILE_EXCL)
      const copied = await stat(temp)
      if (copied.size !== action.size) throw new Error(`version ${basename(action.source)} changed size during restore`)
      await this.hooks.beforeRestoreRename?.()
      try {
        await rename(temp, action.path)
      } catch (error) {
        // A read-only target can block replacement on some filesystems. The
        // content is already complete in the temp file; widening the target
        // for the rename never exposes a half-written file.
        const current = await stat(action.path).catch(() => undefined)
        if (current === undefined || (current.mode & 0o200) !== 0) throw error
        await chmod(action.path, current.mode | 0o200).catch(() => undefined)
        await rename(temp, action.path)
      }
      if (action.mode !== undefined) await chmod(action.path, action.mode).catch(() => undefined)
    } finally {
      await rm(temp, { force: true }).catch(() => undefined)
    }
  }

  /** Load one session's retained manifests and GC. */
  private async loadLocked(state: SessionState, session: StoreSession, warnings: string[]): Promise<void> {
    const dir = this.sessionDir(session.id)
    let names: string[]
    try {
      names = await readdir(dir)
    } catch (error) {
      if (isEnoent(error)) return
      throw error
    }
    if (this.hasLegacyMembers(names) && !this.legacyWarned.has(session.id)) {
      this.legacyWarned.add(session.id)
      warnings.push(`legacy snapshot data ignored for ${session.id}`)
    }
    const metaPath = join(dir, META_FILE)
    let raw: string
    try {
      raw = await readFile(metaPath, 'utf8')
    } catch (error) {
      if (!isEnoent(error)) throw error
      if (names.includes(CHECKPOINTS_DIR) || names.includes(VERSIONS_DIR)) {
        warnings.push(`checkpoint metadata missing for ${session.id}; discarded new storage`)
        await this.discardNewStorage(session.id)
      }
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      warnings.push(`checkpoint metadata corrupt for ${session.id}; discarded new storage`)
      await this.discardNewStorage(session.id)
      return
    }
    const meta = parseMeta(parsed)
    if (meta === undefined) {
      warnings.push(`checkpoint metadata corrupt for ${session.id}; discarded new storage`)
      await this.discardNewStorage(session.id)
      return
    }
    if (meta.store > CURRENT_STORE_VERSION) {
      state.unavailable = new UnknownStoreVersionError(meta.store, metaPath)
      warnings.push(`file restore disabled for ${session.id}: ${state.unavailable.message}`)
      return
    }
    if (meta.store !== CURRENT_STORE_VERSION) {
      warnings.push(`checkpoint storage for ${session.id} discarded: store format ${meta.store} is not supported`)
      await this.discardNewStorage(session.id)
      return
    }
    if (meta.sessionFormat !== session.version) {
      warnings.push(`checkpoint storage for ${session.id} discarded: session format ${session.version} does not match stored ${meta.sessionFormat}`)
      await this.discardNewStorage(session.id)
      return
    }
    const messageIds = new Set(session.messageIds)
    let checkpointNames: string[]
    try {
      checkpointNames = await readdir(this.checkpointsDir(session.id))
    } catch (error) {
      if (!isEnoent(error)) throw error
      checkpointNames = []
    }
    for (const name of checkpointNames) {
      if (!name.endsWith('.json')) continue
      const file = join(this.checkpointsDir(session.id), name)
      const info = await lstat(file).catch(() => undefined)
      if (info === undefined || !info.isFile()) {
        warnings.push(`corrupt checkpoint ${name} discarded for ${session.id}`)
        await rm(file, { recursive: true, force: true }).catch(() => undefined)
        continue
      }
      let raw: string
      try {
        raw = await readFile(file, 'utf8')
      } catch (error) {
        if (isEnoent(error)) continue
        throw error
      }
      let checkpoint: Checkpoint | undefined
      try {
        checkpoint = parseCheckpoint(JSON.parse(raw) as unknown)
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error
        checkpoint = undefined
      }
      if (checkpoint === undefined) {
        warnings.push(`corrupt checkpoint ${name} discarded for ${session.id}`)
        await rm(file, { force: true }).catch(() => undefined)
        continue
      }
      if (!messageIds.has(checkpoint.messageId) || name !== checkpointFileName(checkpoint.messageId)) {
        await rm(file, { force: true }).catch(() => undefined)
        continue
      }
      state.checkpoints.set(file, { ...checkpoint, file })
    }
    state.order = [...state.checkpoints.values()].sort((a, b) => a.time - b.time || a.file.localeCompare(b.file))
    this.trimRetained(state)
    if (state.order.length > 0) {
      const latest = state.order[state.order.length - 1]!
      state.lastTime = latest.time
      state.tracked = new Set(Object.keys(latest.files))
    }
    state.current = undefined
    try {
      warnings.push(...await this.gc(session.id, state))
    } catch (error) {
      warnings.push(`checkpoint GC failed for ${session.id}: ${messageOf(error)}`)
    }
  }

  /** True when a legacy per-call snapshot member is present. */
  private hasLegacyMembers(names: readonly string[]): boolean {
    return names.some(name =>
      /^\d+$/.test(name)
      || name === 'store'
      || name === 'format'
      || name === 'rescue'
      || name === '.pending'
      || name.startsWith('journal-')
      || name.startsWith('restore-journal-'))
  }

  /** Delete only the new storage; legacy members are left untouched. */
  private async discardNewStorage(sessionId: string): Promise<void> {
    const dir = this.sessionDir(sessionId)
    for (const name of [META_FILE, CHECKPOINTS_DIR, VERSIONS_DIR]) {
      await rm(join(dir, name), { recursive: true, force: true }).catch(() => undefined)
    }
  }

  /** Keep the newest {@link RETAINED_CHECKPOINTS} manifests in memory. */
  private trimRetained(state: SessionState): void {
    if (state.order.length <= RETAINED_CHECKPOINTS) return
    const evicted = state.order.slice(0, state.order.length - RETAINED_CHECKPOINTS)
    for (const checkpoint of evicted) state.checkpoints.delete(checkpoint.file)
    state.order = state.order.slice(-RETAINED_CHECKPOINTS)
  }

  /** Delete unreferenced versions and non-retained manifests. */
  private async gc(sessionId: string, state: SessionState): Promise<string[]> {
    const warnings: string[] = []
    const retained = state.order.slice(-RETAINED_CHECKPOINTS)
    const retainedFiles = new Set(retained.map(checkpoint => checkpoint.file))
    const keep = new Set<string>()
    for (const checkpoint of retained) {
      for (const row of Object.values(checkpoint.files)) {
        if (row.blob !== null) keep.add(row.blob)
      }
    }
    const checkpointNames = await readdir(this.checkpointsDir(sessionId)).catch(() => [] as string[])
    for (const name of checkpointNames) {
      if (!name.endsWith('.json') && !name.endsWith('.tmp')) continue
      const file = join(this.checkpointsDir(sessionId), name)
      if (!name.endsWith('.tmp') && retainedFiles.has(file)) continue
      await rm(file, { force: true }).catch(error => warnings.push(`failed to remove ${file}: ${messageOf(error)}`))
    }
    const versionNames = await readdir(this.versionsDir(sessionId)).catch(() => [] as string[])
    for (const name of versionNames) {
      if (!name.endsWith('.tmp') && keep.has(name)) continue
      const file = join(this.versionsDir(sessionId), name)
      await rm(file, { force: true }).catch(error => warnings.push(`failed to remove ${file}: ${messageOf(error)}`))
    }
    await rm(join(this.sessionDir(sessionId), `${META_FILE}.tmp`), { force: true }).catch(() => undefined)
    return warnings
  }

  /** Drop in-memory state after a clear or a removed directory. */
  private resetState(state: SessionState): void {
    state.loaded = false
    state.unavailable = undefined
    state.checkpoints.clear()
    state.order = []
    state.current = undefined
    state.tracked.clear()
    state.lastTime = 0
  }

  /** Drop state for sessions whose directory disappeared out of band. */
  private async forgetMissingSessions(): Promise<void> {
    for (const [sessionId, state] of this.sessions) {
      const present = await this.exists(this.sessionDir(sessionId)).catch(() => true)
      if (!present) {
        this.resetState(state)
        this.sessions.delete(sessionId)
      }
    }
  }

  /** Throw the stored unavailable error, if any. */
  private assertUsable(state: SessionState): void {
    if (!state.loaded) throw new Error('checkpoint store session is not loaded')
    if (state.unavailable !== undefined) throw state.unavailable
  }

  /** Run `fn` after every earlier mutation of this session. */
  private async withLock<T>(sessionId: string, fn: (state: SessionState) => Promise<T>): Promise<T> {
    const state = this.stateOf(sessionId)
    const run = state.lock.then(() => fn(state))
    state.lock = run.then(() => undefined, () => undefined)
    return await run
  }

  private stateOf(sessionId: string): SessionState {
    let state = this.sessions.get(sessionId)
    if (state === undefined) {
      state = {
        sessionId,
        loaded: false,
        checkpoints: new Map(),
        order: [],
        tracked: new Set(),
        lastTime: 0,
        lock: Promise.resolve(),
      } satisfies SessionState
      this.sessions.set(sessionId, state)
    }
    return state
  }
}

/** Error text for a caught value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
