/**
 * Pure candidate computation for the `/rewind` command decoration: which user
 * messages the harness's popupSelect shell offers, withdrawn-row exclusion,
 * preview truncation, and the mapping to popupSelect rows. The listing is a
 * pure function of the session chat snapshot (`rewindCandidatesOf`) so it
 * stays unit-testable in a node environment. Surface user/steering messages
 * only, withdrawn (hidden) rows excluded, newest first — the top row is the
 * default highlight, i.e. the most recent message and the most common rewind
 * target.
 *
 * @module dsh-rewind/client/candidates
 */

import type { SelectOption } from '@deepseek-ai/dsh-client-ui-commands/client'
import type { RewindKey } from './locales.ts'

type Translate = (key: RewindKey, params?: Record<string, unknown>) => string

/** Preview length cap for candidate rows (matches the host's candidate list). */
export const PREVIEW_CHARS = 80

/**
 * Default cap on how many user messages the rewind picker lists (newest kept).
 *
 * Matches the snapshot store's MAX_ANCHOR_GROUPS (100), so the picker shows
 * every anchor group that can still restore file backups; 100 stays
 * scrollable/searchable via the popupSelect shell, and callers can still
 * pass an explicit `limit`.
 */
export const DEFAULT_CANDIDATE_LIMIT = 100

/** One selectable rewind target. */
export interface RewindCandidate {
  /** Absolute log seq of the `user/message` event. */
  readonly seq: number
  /** Unix epoch ms of the event. */
  readonly time: number
  /** Truncated plain-text preview of the message content. */
  readonly preview: string
}

/** A chat snapshot subset the candidate listing reads (structural). */
export interface CandidateChat {
  readonly order: readonly string[]
  readonly nodes: { get(key: string): CandidateUserNode | undefined }
}

/** A user/steering row subset; only fields the listing reads are real. */
export interface CandidateUserNode {
  readonly kind: string
  readonly data: {
    readonly seq: number
    readonly time: number
    readonly content: readonly { type: string; text?: unknown }[]
  }
}

/** Join the text blocks of a user message into one plain preview. */
export function messagePreviewOf(message: { readonly content: readonly { type: string; text?: unknown }[] }): string {
  const text = message.content
    .map(block => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length <= PREVIEW_CHARS
    ? text
    : `${text.slice(0, PREVIEW_CHARS - 1)}…`
}

/** Format a candidate row's clock time (`HH:MM`), matching the host format. */
export function formatCandidateTime(time: number): string {
  const d = new Date(time)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

/**
 * List the selectable rewind candidates of a session chat snapshot: user and
 * steering rows still on the surface (withdrawn rows are absent from `order`),
 * the newest `limit` kept, newest first — the top row is the default highlight,
 * i.e. the most recent message and the most common rewind target.
 * @param snap - the session chat snapshot.
 * @param limit - maximum number of candidates to return.
 */
export function rewindCandidatesOf(snap: CandidateChat, limit = DEFAULT_CANDIDATE_LIMIT): RewindCandidate[] {
  // Walk the log backwards so the newest rows come first; `limit` bounds the
  // kept window.
  const candidates: RewindCandidate[] = []
  for (let i = snap.order.length - 1; i >= 0 && candidates.length < limit; i--) {
    const key = snap.order[i]
    if (key === undefined) continue
    const node = snap.nodes.get(key)
    if (node === undefined || (node.kind !== 'user' && node.kind !== 'steering')) continue
    candidates.push({
      seq: node.data.seq,
      time: node.data.time,
      preview: messagePreviewOf(node.data),
    })
  }
  return candidates
}

/** The candidates of a live chat snapshot; withdrawn rows are already excluded from `order`. */
export function rewindCandidatesOfChat(snap: CandidateChat): RewindCandidate[] {
  return rewindCandidatesOf(snap)
}

/**
 * Map typed candidates to popupSelect rows. The list comes from the host over
 * the host query route, so it covers the FULL host surface rather than the
 * windowed chat snapshot.
 */
export function rewindOptionsFromCandidates(candidates: readonly RewindCandidate[], t: Translate): SelectOption[] {
  return candidates.map(candidate => ({
    id: String(candidate.seq),
    label: candidate.preview || t('popover.noText'),
    detail: formatCandidateTime(candidate.time),
  }))
}
