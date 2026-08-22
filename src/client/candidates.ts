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

import { hiddenSeqsOf, type HiddenChat } from './hidden.ts'
import type { SelectOption } from '@deepseek-ai/dsh-client-ui-commands/client'
import type { RewindKey } from './locales.ts'

type Translate = (key: RewindKey, params?: Record<string, unknown>) => string

/** Preview length cap for candidate rows (matches the host's candidate list). */
export const PREVIEW_CHARS = 80

/**
 * Default cap on how many user messages the rewind picker lists (newest kept).
 *
 * A fixed 10 made long sessions look "incomplete" (only the newest 10 shown).
 * 50 keeps the picker scrollable/searchable via the popupSelect shell while
 * covering far longer sessions; callers can still pass an explicit `limit`.
 */
export const DEFAULT_CANDIDATE_LIMIT = 50

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
  readonly anchorSeq?: number
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
 * steering rows still on the surface (not hidden by a previous rewind), the
 * newest `limit` kept, newest first — the top row is the default highlight,
 * i.e. the most recent message and the most common rewind target.
 * @param snap - the session chat snapshot.
 * @param hidden - anchor seqs withdrawn by rewinds (from `hiddenSeqsOf`).
 * @param limit - maximum number of candidates to return.
 */
export function rewindCandidatesOf(snap: CandidateChat, hidden: ReadonlySet<number>, limit = DEFAULT_CANDIDATE_LIMIT): RewindCandidate[] {
  // Walk the log backwards so the newest rows come first; `limit` bounds the
  // kept window.
  const candidates: RewindCandidate[] = []
  for (let i = snap.order.length - 1; i >= 0 && candidates.length < limit; i--) {
    const key = snap.order[i]
    if (key === undefined) continue
    const node = snap.nodes.get(key)
    if (node === undefined || (node.kind !== 'user' && node.kind !== 'steering')) continue
    if (hidden.has(node.anchorSeq ?? node.data.seq)) continue
    candidates.push({
      seq: node.data.seq,
      time: node.data.time,
      preview: messagePreviewOf(node.data),
    })
  }
  return candidates
}

/** The candidates of a live chat snapshot, withdrawn rows already excluded. */
export function rewindCandidatesOfChat(snap: CandidateChat): RewindCandidate[] {
  return rewindCandidatesOf(snap, hiddenSeqsOf(snap as unknown as HiddenChat))
}

/**
 * Map the candidates to popupSelect rows: the message preview as the row
 * label (left) and the clock time as the detail (right) — the shell's native
 * label/detail flex layout, with no recency numbers.
 */
export function rewindOptionsOf(snap: CandidateChat, t: Translate): SelectOption[] {
  return rewindCandidatesOfChat(snap).map(candidate => ({
    id: String(candidate.seq),
    label: candidate.preview || t('popover.noText'),
    detail: formatCandidateTime(candidate.time),
  }))
}

/** Resolve one candidate by log seq (the mode popover's re-entry after a pick). */
export function candidateBySeq(snap: CandidateChat, seq: number): RewindCandidate | undefined {
  return rewindCandidatesOfChat(snap).find(candidate => candidate.seq === seq)
}

/**
 * Header prefix of the host's machine-readable candidate list (matches
 * `CANDIDATE_LIST_HEADER` in src/rewind.ts). Kept as a local literal so the
 * client bundle never imports the host module (which would drag in dsh-session).
 */
const CANDIDATE_LIST_HEADER = 'candidates='

/**
 * Parse the host's candidate-list encoding (see `formatCandidateList` in
 * src/rewind.ts) into typed candidates. Malformed lines are skipped; a
 * missing/zero header yields an empty list.
 */
export function rewindCandidatesFromHostText(text: string): RewindCandidate[] {
  if (!text.startsWith(CANDIDATE_LIST_HEADER)) return []
  const lines = text.split('\n').slice(1)
  const candidates: RewindCandidate[] = []
  for (const line of lines) {
    if (line === '') continue
    const parts = line.split('\t')
    if (parts.length !== 3) continue
    const seq = Number(parts[0])
    const time = Number(parts[1])
    const preview = parts[2] ?? ''
    if (!Number.isSafeInteger(seq) || !Number.isFinite(time)) continue
    candidates.push({ seq, time, preview })
  }
  return candidates
}

/**
 * Map typed candidates to popupSelect rows (the host-derived path). The
 * popupSelect sources its options from the FULL host surface via the
 * `__candidates` channel instead of the windowed chat snapshot.
 */
export function rewindOptionsFromCandidates(candidates: readonly RewindCandidate[], t: Translate): SelectOption[] {
  return candidates.map(candidate => ({
    id: String(candidate.seq),
    label: candidate.preview || t('popover.noText'),
    detail: formatCandidateTime(candidate.time),
  }))
}

/**
 * Parse the host's candidate-list encoding (see `formatCandidateList` in
 * src/rewind.ts) into popupSelect rows.
 */
export function rewindOptionsFromHostText(text: string, t: Translate): SelectOption[] {
  return rewindOptionsFromCandidates(rewindCandidatesFromHostText(text), t)
}
