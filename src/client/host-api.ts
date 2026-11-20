/**
 * The browser half of the v1 engine contract: health, preview and commit over
 * the plugin's exact `/api/dsh-rewind/v1` routes.
 *
 * The transport decodes envelopes and stable error codes; it never invents
 * localized copy. Callers branch on `code` and localize through their own
 * dictionaries (`./errors.ts`), and must ignore unknown fields.
 *
 * @module dsh-rewind/client/host-api
 */

import type { RewindCandidate } from './candidates.ts'
import { rewindLog } from './log.ts'

const TIMEOUT_MS = 8000

/** The major version this client speaks; health must report the same value. */
export const CONTRACT_MAJOR = 1

/** Stable failure codes the v1 routes can return. */
export type ContractErrorCode =
  | 'bad-request'
  | 'session-not-found'
  | 'target-missing'
  | 'head-changed'
  | 'turn-running'
  | 'commit-in-flight'
  | 'internal'

/** Why the file effect cannot run for a target. */
export type AvailabilityReason = 'no-checkpoint' | 'checkpointing-disabled' | 'store-unsupported'

/** Contract vocabulary for a path the file effect leaves alone. */
export type ContractSkipReason = 'oversized' | 'parent-changed' | 'unsafe' | 'missing'

/** The content a rewind withdraws. */
export interface Withdraw {
  readonly text: string
  /** Non-text content blocks, passed through from the host message. */
  readonly attachments: readonly unknown[]
}

/** One disk change the file effect would apply. */
export interface PreviewFileChange {
  readonly path: string
  readonly action: 'restore' | 'delete'
}

/** One path the file effect leaves alone. */
export interface PreviewSkipped {
  readonly path: string
  readonly reason: ContractSkipReason
}

/** File effect description: the diff, or why it cannot run. */
export type FilesPreview =
  | { readonly available: true; readonly changes: readonly PreviewFileChange[]; readonly skipped: readonly PreviewSkipped[] }
  | { readonly available: false; readonly reason: AvailabilityReason }

/** Result of `preview`. */
export interface PreviewValue {
  readonly headSeq: number
  readonly withdraw: Withdraw
  readonly files: FilesPreview
}

/** File effect result after a commit. */
export type FilesCommit =
  | {
    readonly applied: true
    readonly restored: readonly string[]
    readonly deleted: readonly string[]
    readonly skipped: readonly PreviewSkipped[]
    readonly failed: readonly { readonly path: string; readonly message: string }[]
  }
  | { readonly applied: false; readonly reason: AvailabilityReason }

/** Result of `commit`: only the requested effects are present. */
export interface CommitValue {
  readonly conversation?: { readonly rewound: true }
  readonly files?: FilesCommit
}

/** One decoded contract failure; `code` is kept raw for forward compatibility. */
export interface ContractFailure {
  readonly kind: 'error'
  readonly code: string
  readonly message: string
}

/** A settled preview call; `null` is a timeout/transport failure. */
export type PreviewOutcome = { readonly kind: 'success'; readonly value: PreviewValue } | ContractFailure | null

/** A settled commit call; `null` is a timeout/transport failure. */
export type CommitOutcome = { readonly kind: 'success'; readonly value: CommitValue } | ContractFailure | null

/** A settled health call; `null` means the engine is absent. */
export type HealthOutcome = { readonly contract: number } | null

/** Fetch one target's preview; the popover's registered transport. */
export type PreviewCall = (sessionId: string, seq: number) => Promise<PreviewOutcome>

type QueryRoute = 'health' | 'preview' | 'commit' | 'candidates'

type Result =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isResult(value: unknown): value is Result {
  if (!isRecord(value)) return false
  if (value['ok'] === true) return true
  if (value['ok'] !== false || !isRecord(value['error'])) return false
  const error = value['error']
  return typeof error['code'] === 'string' && typeof error['message'] === 'string'
}

function isAbort(error: unknown): boolean {
  const name = (error as { readonly name?: unknown } | null)?.name
  return name === 'AbortError' || name === 'TimeoutError'
}

function isAvailability(value: unknown): value is AvailabilityReason {
  return value === 'no-checkpoint' || value === 'checkpointing-disabled' || value === 'store-unsupported'
}

function isSkipReason(value: unknown): value is ContractSkipReason {
  return value === 'oversized' || value === 'parent-changed' || value === 'unsafe' || value === 'missing'
}

function isChange(value: unknown): value is PreviewFileChange {
  return isRecord(value)
    && typeof value['path'] === 'string'
    && (value['action'] === 'restore' || value['action'] === 'delete')
}

function isSkipped(value: unknown): value is PreviewSkipped {
  return isRecord(value) && typeof value['path'] === 'string' && isSkipReason(value['reason'])
}

function isWithdraw(value: unknown): value is Withdraw {
  return isRecord(value) && typeof value['text'] === 'string' && Array.isArray(value['attachments'])
}

function isFilesPreview(value: unknown): value is FilesPreview {
  if (!isRecord(value)) return false
  if (value['available'] === false) return isAvailability(value['reason'])
  return value['available'] === true
    && Array.isArray(value['changes']) && value['changes'].every(isChange)
    && Array.isArray(value['skipped']) && value['skipped'].every(isSkipped)
}

function isFilesCommit(value: unknown): value is FilesCommit {
  if (!isRecord(value)) return false
  if (value['applied'] === false) return isAvailability(value['reason'])
  return value['applied'] === true
    && Array.isArray(value['restored']) && value['restored'].every(path => typeof path === 'string')
    && Array.isArray(value['deleted']) && value['deleted'].every(path => typeof path === 'string')
    && Array.isArray(value['skipped']) && value['skipped'].every(isSkipped)
    && Array.isArray(value['failed'])
    && value['failed'].every(failed => isRecord(failed) && typeof failed['path'] === 'string' && typeof failed['message'] === 'string')
}

function isPreviewValue(value: unknown): value is PreviewValue {
  return isRecord(value)
    && typeof value['headSeq'] === 'number' && Number.isSafeInteger(value['headSeq'])
    && isWithdraw(value['withdraw'])
    && isFilesPreview(value['files'])
}

function isCommitValue(value: unknown): value is CommitValue {
  if (!isRecord(value)) return false
  const conversation = value['conversation']
  if (conversation !== undefined) {
    if (!isRecord(conversation) || conversation['rewound'] !== true) return false
  }
  const files = value['files']
  return files === undefined ? conversation !== undefined : isFilesCommit(files)
}

/** Build one JSON request for a contract payload. */
function init(signal: AbortSignal): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal,
  }
}

/** Decode one contract envelope; transport faults throw. */
async function settle(response: Response, route: QueryRoute): Promise<Result> {
  const result: unknown = await response.json().catch(() => undefined)
  if (!isResult(result)) throw new Error(`invalid response for ${route}`)
  return result
}

/** Decode one failure envelope without inventing a code. */
function failure(result: Extract<Result, { ok: false }>): ContractFailure {
  return { kind: 'error', code: result.error.code, message: result.error.message }
}

/** Narrow one internal candidate row. */
function isCandidate(value: unknown): value is RewindCandidate {
  if (!isRecord(value)) return false
  return typeof value['seq'] === 'number' && Number.isSafeInteger(value['seq'])
    && typeof value['time'] === 'number' && Number.isFinite(value['time'])
    && typeof value['preview'] === 'string'
}

/**
 * Read the `/rewind` picker candidates from the Host's internal route.
 * NOT part of the v1 contract and not covered by its stability promise; the
 * picker covers the full surface (the store's 100-candidate window) rather than
 * only the loaded chat window.
 * @param sessionId - the session whose surface to list.
 * @returns candidates, or undefined when the internal read is unavailable.
 */
export async function candidatesOverApi(sessionId: string): Promise<readonly RewindCandidate[] | undefined> {
  try {
    const response = await fetch('./api/dsh-rewind/candidates', {
      ...init(AbortSignal.timeout(TIMEOUT_MS)),
      body: JSON.stringify({ sessionId }),
    })
    if (!response.ok) return undefined
    const result = await settle(response, 'candidates')
    if (!result.ok) {
      rewindLog.warn('preview', 'candidates request rejected', result.error)
      return undefined
    }
    if (!isRecord(result.value) || !Array.isArray(result.value['candidates'])) {
      throw new Error('invalid candidates response')
    }
    return result.value['candidates'].filter(isCandidate)
  } catch (error) {
    if (!isAbort(error)) rewindLog.warn('preview', 'candidates request threw', error)
    return undefined
  }
}

/** Resolve the engine contract version, or null when the engine is absent. */
export async function healthOverApi(): Promise<HealthOutcome> {
  try {
    const response = await fetch('./api/dsh-rewind/v1/health', {
      method: 'GET',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response.ok) return null
    const result: unknown = await response.json()
    if (!isRecord(result) || result['ok'] !== true || !isRecord(result['value'])) return null
    const contract = result['value']['contract']
    return typeof contract === 'number' && Number.isSafeInteger(contract) ? { contract } : null
  } catch (error) {
    if (!isAbort(error)) rewindLog.warn('health', 'health request threw', error)
    return null
  }
}

/** Describe what a commit would do. */
export async function previewOverApi(sessionId: string, seq: number): Promise<PreviewOutcome> {
  try {
    const request = init(AbortSignal.timeout(TIMEOUT_MS))
    request.body = JSON.stringify({ sessionId, seq })
    const response = await fetch('./api/dsh-rewind/v1/preview', request)
    const result = await settle(response, 'preview')
    if (!result.ok) {
      rewindLog.warn('preview', `preview request failed for @${seq}`, result.error)
      return failure(result)
    }
    if (!isPreviewValue(result.value)) {
      rewindLog.warn('preview', `preview request returned an invalid result for @${seq}`)
      return { kind: 'error', code: 'internal', message: 'invalid preview response' }
    }
    return { kind: 'success', value: result.value }
  } catch (error) {
    if (isAbort(error)) {
      rewindLog.warn('preview', `preview request timed out for @${seq}`)
      return null
    }
    rewindLog.warn('preview', `preview request threw for @${seq}`, error)
    return { kind: 'error', code: 'internal', message: error instanceof Error ? error.message : String(error) }
  }
}

/** Execute the requested effects against the previewed head. */
export async function commitOverApi(
  sessionId: string,
  seq: number,
  headSeq: number,
  mode: 'conversation' | 'files' | 'both',
): Promise<CommitOutcome> {
  try {
    const request = init(AbortSignal.timeout(TIMEOUT_MS))
    request.body = JSON.stringify({ sessionId, seq, headSeq, mode })
    const response = await fetch('./api/dsh-rewind/v1/commit', request)
    const result = await settle(response, 'commit')
    if (!result.ok) {
      rewindLog.warn('commit', `commit request failed for @${seq}`, result.error)
      return failure(result)
    }
    if (!isCommitValue(result.value)) {
      rewindLog.warn('commit', `commit request returned an invalid result for @${seq}`)
      return { kind: 'error', code: 'internal', message: 'invalid commit response' }
    }
    return { kind: 'success', value: result.value }
  } catch (error) {
    if (isAbort(error)) {
      rewindLog.warn('commit', `commit request timed out for @${seq}`)
      return null
    }
    rewindLog.warn('commit', `commit request threw for @${seq}`, error)
    return { kind: 'error', code: 'internal', message: error instanceof Error ? error.message : String(error) }
  }
}
