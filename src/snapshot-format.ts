/**
 * On-disk checkpoint format — the single source of truth for the store layout.
 *
 * A session directory holds three members and nothing else that this build
 * reads:
 *
 * - `meta.json` — `{ store, sessionFormat }`; a newer `store` makes the whole
 *   file store fail closed, and a different `sessionFormat` discards the new
 *   storage (the old layout is never touched);
 * - `checkpoints/<safe(messageId)>-<hash8>.json` — one dense
 *   `path → FileState` manifest per user message;
 * - `versions/<pathHash>@v<N>` — raw content bytes, shared by manifests.
 *
 * This module is stateless: naming, JSON codecs and structural validation. The
 * byte-level guarantees (atomic writes, containment, location pins) live in
 * `snapshot-fs.ts`; the lifecycle lives in `snapshot.ts`.
 *
 * @module dsh-rewind/snapshot-format
 */

import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'

/** Current on-disk store format. A higher value is newer than this build. */
export const CURRENT_STORE_VERSION = 3

/** Session-dir member holding one dense manifest per user message. */
export const CHECKPOINTS_DIR = 'checkpoints'

/** Session-dir member holding shared raw content versions. */
export const VERSIONS_DIR = 'versions'

/** Session-dir metadata file. */
export const META_FILE = 'meta.json'

/** Thrown when a store is newer than this build understands. */
export class UnknownStoreVersionError extends Error {
  constructor(
    /** The version found on disk. */
    readonly version: number,
    /** Where it was found. */
    readonly source: string,
  ) {
    super(`checkpoint store version ${version} is newer than this plugin understands (${source})`)
    this.name = 'UnknownStoreVersionError'
  }
}

/** `meta.json` as written by this build. */
export interface StoreMeta {
  /** Store format; higher than {@link CURRENT_STORE_VERSION} is fail-closed. */
  readonly store: number
  /** DSH session format the manifests were anchored under. */
  readonly sessionFormat: number
}

/** One path's state at a checkpoint. */
export interface FileState {
  /** Per-path version, monotonic and never reused, including `null` states. */
  readonly v: number
  /** Version file name (`<hash>@v<N>`), or `null` when the file did not exist. */
  readonly blob: string | null
  /** Content size; present exactly when `blob` is non-null. */
  readonly size?: number
  /** Captured permission bits (`mode & 0o7777`). */
  readonly mode?: number
  /** Parent-directory realpath captured at capture time (location pin). */
  readonly parent?: string
}

/** One user message's dense file-state manifest. */
export interface Checkpoint {
  readonly store: typeof CURRENT_STORE_VERSION
  readonly messageId: string
  /** Monotonic epoch-ms order key. */
  readonly time: number
  readonly files: Record<string, FileState>
}

/** One action the restore plan would apply to the live disk. */
export type PlannedAction =
  | {
    readonly path: string
    readonly action: 'restore'
    /** Absolute version-file path. */
    readonly source: string
    readonly size: number
    readonly mode?: number
    /** Location pin captured with the row. */
    readonly parent: string
  }
  | {
    readonly path: string
    readonly action: 'delete'
    readonly parent: string
  }

/** Why a path was skipped rather than restored or deleted. */
export type SkipReason = 'oversized' | 'unsafe' | 'parent' | 'missing'

/** One path the restore left alone. */
export interface SkippedPath {
  readonly path: string
  readonly reason: SkipReason
}

/** Per-file impact shown in the preview. */
export interface FileImpact {
  readonly path: string
  readonly action: 'restore' | 'delete'
}

/** A tracked path whose current size is over the per-file cap. */
export interface UncoveredPath {
  readonly path: string
  readonly size?: number
}

/** Result of one restore pass; `noCheckpoint` means no file operation ran. */
export interface RestoreOutcome {
  readonly restored: string[]
  readonly deleted: string[]
  readonly skipped: SkippedPath[]
  readonly failed: { readonly path: string; readonly message: string }[]
  readonly noCheckpoint: boolean
}

/** Result of a stale-session sweep. */
export interface PruneStaleReport {
  readonly scanned: number
  readonly deleted: number
  readonly freedBytes: number
  readonly kept: number
  readonly remainingBytes: number
  readonly skippedActive: number
  readonly dryRun: boolean
}

/** Result of a whole-session clear. */
export interface ClearSessionReport {
  readonly sessionId: string
  /** Snapshot count in the whole session directory (manifests + legacy entries). */
  readonly entries: number
  /** Bytes occupied by the session directory. */
  readonly bytes: number
  readonly dryRun: boolean
}

/** Sanitize a message id into a safe path segment. */
export function safeFileId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_')
}

/**
 * Sanitize a session id into a safe path segment. Real ids are harness-minted
 * UUIDs; a hostile id must never traverse out of the store root. Bare `.` and
 * `..` are the only values the charset permits that alias the root or parent.
 */
export function safeSessionId(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9._-]/g, '_')
  return safe === '' || safe === '..' || safe === '.' ? 'session' : safe
}

/** First 8 hex digits of a SHA-256 digest. */
export function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8)
}

/** `16`-hex path hash used in version names. */
export function pathHash(path: string): string {
  return createHash('sha256').update(path).digest('hex').slice(0, 16)
}

/** The checkpoint file name for one message id. */
export function checkpointFileName(messageId: string): string {
  return `${safeFileId(messageId)}-${shortHash(messageId)}.json`
}

/** Version file name for `path` at version `v`. */
export function versionFileName(path: string, v: number): string {
  return `${pathHash(path)}@v${v}`
}

const VERSION_NAME = /^[0-9a-f]{16}@v[1-9][0-9]*$/

/** Whether `name` is a valid version file name written by this build. */
export function isVersionFileName(name: string): boolean {
  return VERSION_NAME.test(name)
}

/** Serialize meta for disk. */
export function metaToJson(meta: StoreMeta): Record<string, unknown> {
  return { store: meta.store, sessionFormat: meta.sessionFormat }
}

/** Parse `meta.json`; `undefined` for malformed content. */
export function parseMeta(raw: unknown): StoreMeta | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  const store = record['store']
  const sessionFormat = record['sessionFormat']
  if (!isSafePositiveInteger(store) || !isSafePositiveInteger(sessionFormat)) return undefined
  return { store, sessionFormat }
}

/** Serialize one checkpoint for disk. */
export function checkpointToJson(checkpoint: Checkpoint): Record<string, unknown> {
  return {
    store: CURRENT_STORE_VERSION,
    messageId: checkpoint.messageId,
    time: checkpoint.time,
    files: checkpoint.files,
  }
}

/**
 * Parse and structurally validate one checkpoint. Any malformed row drops the
 * whole checkpoint: a partially trusted manifest could plan a wrong action for
 * a path it does not actually describe.
 */
export function parseCheckpoint(raw: unknown): Checkpoint | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  if (record['store'] !== CURRENT_STORE_VERSION) return undefined
  const messageId = record['messageId']
  if (typeof messageId !== 'string' || messageId.length === 0) return undefined
  const time = record['time']
  if (typeof time !== 'number' || !Number.isFinite(time) || time < 0) return undefined
  const rawFiles = record['files']
  if (rawFiles === null || typeof rawFiles !== 'object' || Array.isArray(rawFiles)) return undefined
  const files: Record<string, FileState> = {}
  for (const [path, value] of Object.entries(rawFiles as Record<string, unknown>)) {
    if (!isAbsolute(path)) return undefined
    const state = parseFileState(value)
    if (state === undefined) return undefined
    files[path] = state
  }
  return { store: CURRENT_STORE_VERSION, messageId, time, files }
}

function parseFileState(raw: unknown): FileState | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  const v = record['v']
  if (!isSafePositiveInteger(v)) return undefined
  const blob = record['blob']
  if (blob !== null && (typeof blob !== 'string' || !isVersionFileName(blob))) return undefined
  const size = record['size']
  if (blob === null) {
    if (size !== undefined) return undefined
  } else if (!isSafeNonNegativeInteger(size)) {
    return undefined
  }
  const mode = record['mode']
  if (mode !== undefined && (!isSafeNonNegativeInteger(mode) || mode > 0o7777)) return undefined
  const parent = record['parent']
  if (parent !== undefined && (typeof parent !== 'string' || parent.length === 0)) return undefined
  return {
    v,
    blob,
    ...(size !== undefined ? { size: size as number } : {}),
    ...(mode !== undefined ? { mode: mode as number } : {}),
    ...(parent !== undefined ? { parent: parent as string } : {}),
  }
}

function isSafePositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
