/**
 * Pure candidate computation for the `/rewind` command decoration: which user
 * messages the harness's popupSelect shell offers (most recent first,
 * numbered 1..N), withdrawn-row exclusion, preview truncation, and the
 * mapping to popupSelect rows. The listing is a pure function of the session
 * chat snapshot (`rewindCandidatesOf`) so it stays unit-testable in a node
 * environment, mirroring the host's `listRewindCandidates` semantics: surface
 * user/steering messages only, withdrawn (hidden) rows excluded, most recent
 * first.
 *
 * @module dsh-rewind/client/candidates
 */

import { hiddenSeqsOf, type HiddenChat } from './hidden.ts'
import type { SelectOption } from '@deepseek-ai/dsh-client-ui-commands/client'
import type { RewindKey } from './locales.ts'

type Translate = (key: RewindKey, params?: Record<string, unknown>) => string

/** Preview length cap for candidate rows (matches the host's candidate list). */
export const PREVIEW_CHARS = 80

/** One selectable rewind target. */
export interface RewindCandidate {
  /** Absolute log seq of the `user/message` event. */
  readonly seq: number
  /** Unix epoch ms of the event. */
  readonly time: number
  /** Truncated plain-text preview of the message content. */
  readonly preview: string
  /** 1-based recency index (1 = most recent). */
  readonly index: number
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
 * steering rows still on the surface (not hidden by a previous rewind), most
 * recent first, numbered 1..N — the same candidate set and ordering the host's
 * `listRewindCandidates` produces for the same surface.
 * @param snap - the session chat snapshot.
 * @param hidden - anchor seqs withdrawn by rewinds (from `hiddenSeqsOf`).
 * @param limit - maximum number of candidates to return.
 */
export function rewindCandidatesOf(snap: CandidateChat, hidden: ReadonlySet<number>, limit = 10): RewindCandidate[] {
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
      index: candidates.length + 1,
    })
  }
  return candidates
}

/** The candidates of a live chat snapshot, withdrawn rows already excluded. */
export function rewindCandidatesOfChat(snap: CandidateChat): RewindCandidate[] {
  return rewindCandidatesOf(snap, hiddenSeqsOf(snap as unknown as HiddenChat))
}

/** Map the candidates to popupSelect rows for the `/rewind` decoration. */
export function rewindOptionsOf(snap: CandidateChat, t: Translate): SelectOption[] {
  return rewindCandidatesOfChat(snap).map(candidate => ({
    id: String(candidate.seq),
    label: `${candidate.index}. ${formatCandidateTime(candidate.time)}`,
    detail: candidate.preview || t('popover.noText'),
  }))
}

/** Resolve one candidate by log seq (the mode popover's re-entry after a pick). */
export function candidateBySeq(snap: CandidateChat, seq: number): RewindCandidate | undefined {
  return rewindCandidatesOfChat(snap).find(candidate => candidate.seq === seq)
}
