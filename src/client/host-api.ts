/**
 * The browser half of the two read-only host queries: the mode popover's impact
 * preview and the `/rewind` candidate list, posted to their exact `/api` routes.
 *
 * @module dsh-rewind/client/host-api
 */

import type { RewindCandidate } from './candidates.ts'
import { rewindLog } from './log.ts'

const TIMEOUT_MS = 8000

/** The query a transport failure belongs to. */
type QueryRoute = 'preview' | 'candidates'

/** One file affected by a rewind. */
export interface PreviewFileImpact {
  readonly path: string
  readonly action: 'restore' | 'delete'
}

/** One impact probe resolved, failed, or timed out (`null`). */
export type PreviewOutcome =
  | { readonly kind: 'success'; readonly files: readonly PreviewFileImpact[]; readonly backupOff: boolean }
  | { readonly kind: 'error'; readonly text: string }
  | null

/** Fetch one target's impact through the host query route. */
export type PreviewCall = (sessionId: string, seq: number) => Promise<PreviewOutcome>

type QueryResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly details: object } }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isResult(value: unknown): value is QueryResult {
  if (!isRecord(value)) return false
  if (value['ok'] === true) return true
  if (value['ok'] !== false || !isRecord(value['error'])) return false
  const error = value['error']
  return typeof error['code'] === 'string'
    && typeof error['message'] === 'string'
    && isRecord(error['details'])
}

function isImpact(value: unknown): value is PreviewFileImpact {
  return isRecord(value)
    && typeof value['path'] === 'string'
    && (value['action'] === 'restore' || value['action'] === 'delete')
}

function isCandidate(value: unknown): value is RewindCandidate {
  return isRecord(value)
    && Number.isSafeInteger(value['seq'])
    && typeof value['time'] === 'number' && Number.isFinite(value['time'])
    && typeof value['preview'] === 'string'
}

function isAbort(error: unknown): boolean {
  const name = (error as { readonly name?: unknown } | null)?.name
  return name === 'AbortError' || name === 'TimeoutError'
}

// Each endpoint owns its document-relative route literal at the fetch call;
// these helpers only build the request and decode the response.
/** Build one JSON POST request for a query payload. */
function init(payload: unknown, signal: AbortSignal): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  }
}

/** Decode one query envelope; `route` labels a transport failure. */
async function settleQuery(response: Response, route: QueryRoute): Promise<QueryResult> {
  if (!response.ok) throw new Error(`transport failure for ${route}: HTTP ${response.status}`)
  const result: unknown = await response.json()
  if (!isResult(result)) throw new Error(`invalid response for ${route}`)
  return result
}

/** Resolve one target's file impact through the host query route. */
export async function previewOverApi(sessionId: string, seq: number): Promise<PreviewOutcome> {
  try {
    const response = await fetch('./api/dsh-rewind/preview', init({ sessionId, seq }, AbortSignal.timeout(TIMEOUT_MS)))
    const result = await settleQuery(response, 'preview')
    if (!result.ok) {
      rewindLog.warn('preview', `preview request failed for @${seq}`, result.error)
      return { kind: 'error', text: result.error.message }
    }
    const value = result.value
    if (!isRecord(value) || typeof value['backupOff'] !== 'boolean'
      || !Array.isArray(value['files']) || !value['files'].every(isImpact)) {
      rewindLog.warn('preview', `preview request returned an invalid result for @${seq}`)
      return { kind: 'error', text: 'invalid preview response' }
    }
    return { kind: 'success', files: value['files'], backupOff: value['backupOff'] }
  } catch (error) {
    if (isAbort(error)) {
      rewindLog.warn('preview', `preview request timed out for @${seq}`)
      return null
    }
    rewindLog.warn('preview', `preview request threw for @${seq}`, error)
    return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
  }
}

/** Fetch the full rewind candidate list through the host query route. */
export async function candidatesOverApi(sessionId: string): Promise<readonly RewindCandidate[] | undefined> {
  try {
    const response = await fetch('./api/dsh-rewind/candidates', init({ sessionId }, AbortSignal.timeout(TIMEOUT_MS)))
    const result = await settleQuery(response, 'candidates')
    if (!result.ok) {
      rewindLog.warn('preview', 'candidate request failed', result.error)
      return undefined
    }
    const value = result.value
    if (!isRecord(value) || !Array.isArray(value['candidates']) || !value['candidates'].every(isCandidate)) {
      rewindLog.warn('preview', 'candidate request returned an invalid result')
      return undefined
    }
    return value['candidates']
  } catch (error) {
    rewindLog.warn('preview', 'candidate request threw', error)
    return undefined
  }
}
