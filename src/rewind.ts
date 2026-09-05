/**
 * Pure rewind planning: target resolution and surface-range computation.
 * No I/O and no `Session` dependency — everything derives from the event log
 * and the ordered surface, so this module stays unit-testable.
 *
 * Rewind semantics (see README): rewinding to a user message appends a marker
 * node into the session log whose `surfaceOp` replaces every surface node
 * AFTER the target with itself. The log (the audit trail and the rendered
 * transcript) is untouched; only the model-visible surface is cut, so the
 * next request derives its context from the target message onward.
 *
 * Marker shape (v0.1.3/v2): the marker is an EMPTY `user/message` carrying a
 * replace `surfaceOp` — a single event:
 *
 *   user/message (marker, empty content) → { surfaceOp {replace, start, end} }
 *
 * v2 reserves surface `replace` to a node that cites every shadowed seq via
 * `sourceEventSeqs`, and `assistant/message` can no longer carry
 * `sourceEventSeqs` (it now embeds its provider stream instead) — so the
 * replacement node must be a `user/message`, exactly as /compact's checkpoint
 * is. No ghost `step/start`…`step/end` frame is needed: the token-meter's
 * step state machine ignores `user/message`, and the session invariant
 * (`invariant.ts`) imposes no open-turn requirement on it, so the marker is
 * appended while idle, outside any turn. The empty content means the marker
 * carries no language; it sits at the surface tail as the model-visible
 * "cut point" (an empty `user/message` derives to itself, so it remains a
 * present-but-empty user turn in derived history).
 *
 * @module dsh-rewind/rewind
 */

import type { SessionEvent, UserMessage } from '@deepseek-ai/dsh-session'

/** Which of the two rewind modes a rewind executes. */
export type RewindMode = 'chat' | 'both'

/**
 * Parse-level rewind target. The command line accepts both forms:
 * - `@<seq>` — an absolute log seq (what the UI button always sends);
 * - `<index>` — a 1-based recency index into the listed candidates
 *   (1 = most recent user message; the step-by-step command flow uses this).
 */
export type RewindTarget =
  | { kind: 'seq'; seq: number }
  | { kind: 'index'; index: number }

/** Expected failure codes; each maps to a concise human outcome. */
export type RewindErrorCode =
  | 'no-user-messages'
  | 'invalid-index'
  | 'not-a-user-message'
  | 'not-on-surface'

/** A typed rewind failure. The host renders `code` into user-facing copy. */
export class RewindError extends Error {
  constructor(
    readonly code: RewindErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'RewindError'
  }
}

/** One selectable rewind candidate: a user message currently on the surface. */
export interface RewindCandidate {
  /** Absolute log seq of the `user/message` event. */
  readonly seq: number
  /** Unix epoch ms of the event. */
  readonly time: number
  /** Truncated plain-text preview of the message content. */
  readonly preview: string
  /** 1-based recency index in the candidate list (1 = most recent). */
  readonly index: number
}

/** A validated rewind: the target plus the exact surface range to shadow. */
export interface RewindPlan {
  /** Target user message seq (stays on the surface). */
  readonly targetSeq: number
  /** The target's ordered position in the surface. */
  readonly targetIndex: number
  /** Ordered surface node seqs the rewind shadows (everything after the target). */
  readonly shadowedSeqs: readonly number[]
  /** First surface node after the target — the replace range start (inclusive). */
  readonly surfaceStart: number
  /** Last surface node — the replace range end (inclusive). */
  readonly surfaceEnd: number
}

/** Preview length cap for candidate listings. */
export const CANDIDATE_PREVIEW_CHARS = 80

/**
 * Default cap on how many user messages a candidate listing returns (newest
 * kept). Matches the snapshot store's MAX_ANCHOR_GROUPS (100), so every
 * anchor group that still has restorable file backups is listed; callers can
 * still pass an explicit `limit`.
 */
export const DEFAULT_CANDIDATE_LIMIT = 100

/** Narrow an event to a user message. */
export function isUserMessageEvent(
  event: SessionEvent,
): event is SessionEvent<'user/message'> {
  return event.type === 'user/message'
}

/**
 * True for a HUMAN user message event — one whose `source.kind` is `'user'`.
 *
 * The surface can carry `user/message` events whose source is NOT the user:
 * plugin/system context injection (including compaction checkpoints) and
 * tool-result backfill all arrive as `user/message` with a non-`'user'`
 * source, and the client renders those as `context` nodes, never as a user
 * bubble. Only genuine user messages (and user steering during a running
 * turn, which keeps `source.kind: 'user'`) are valid rewind targets — a
 * rewind boundary must land on a human prompt, not on injected context.
 */
export function isHumanUserMessageEvent(
  event: SessionEvent,
): event is SessionEvent<'user/message'> {
  return isUserMessageEvent(event) && event.data.source.kind === 'user'
}

/** Join the text blocks of a message into one plain string. */
export function messagePreview(message: UserMessage): string {
  const text = message.content
    .map(block => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length <= CANDIDATE_PREVIEW_CHARS
    ? text
    : `${text.slice(0, CANDIDATE_PREVIEW_CHARS - 1)}…`
}

/**
 * Parse a raw command token into a rewind target.
 * @param raw - one token: `@123` (absolute seq) or `12` (recency index).
 * @returns the parsed target, or undefined when the token is malformed.
 */
export function parseRewindTarget(raw: string): RewindTarget | undefined {
  const token = raw.trim()
  if (token === '') return undefined
  if (token.startsWith('@')) {
    const seq = Number(token.slice(1))
    return Number.isSafeInteger(seq) && seq >= 0 ? { kind: 'seq', seq } : undefined
  }
  const index = Number(token)
  return Number.isSafeInteger(index) && index >= 1 ? { kind: 'index', index } : undefined
}

/**
 * List the selectable rewind candidates: user messages currently on the
 * surface, most recent first. Shadowed (compacted-away) user messages are
 * intentionally excluded — the rewind boundary cannot be placed where the
 * model context no longer reaches.
 * @param events - the full session event log.
 * @param surface - the ordered surface node seqs (`session.surface.nodes`).
 * @param limit - maximum number of candidates to return.
 * @returns candidates numbered 1..N by recency.
 */
export function listRewindCandidates(
  events: readonly SessionEvent[],
  surface: readonly number[],
  limit = DEFAULT_CANDIDATE_LIMIT,
): RewindCandidate[] {
  const surfaceIndexes = new Map<number, number>()
  for (let i = 0; i < surface.length; i++) surfaceIndexes.set(surface[i]!, i)
  const candidates: RewindCandidate[] = []
  for (let i = events.length - 1; i >= 0 && candidates.length < limit; i--) {
    const event = events[i]!
    // Only HUMAN user messages are candidates: injected context / compaction
    // checkpoints ride `user/message` with a non-`'user'` source and must not
    // appear as rewind targets.
    if (!isHumanUserMessageEvent(event)) continue
    if (!surfaceIndexes.has(event.seq)) continue
    candidates.push({
      seq: event.seq,
      time: event.time,
      preview: messagePreview(event.data),
      index: candidates.length + 1,
    })
  }
  return candidates
}

/** Header line of the machine-readable candidate list (locale-independent). */
export const CANDIDATE_LIST_HEADER = 'candidates='

/**
 * Encode a candidate list as the host→client machine channel (the same
 * trailer pattern `formatPlan` uses for `impact=`). The client popupSelect
 * parses this instead of reading the windowed chat snapshot, so the candidate
 * list reflects the FULL host surface — not just the already-loaded history.
 *
 * Lines (each preview is already whitespace-collapsed and tab-free by
 * `messagePreview`):
 *   candidates=<n>
 *   <seq>\t<time>\t<preview>
 *   … (one line per candidate, newest first, matching `listRewindCandidates`)
 *
 * A list with no candidates is just `candidates=0`.
 */
export function formatCandidateList(candidates: readonly RewindCandidate[]): string {
  const lines = [`${CANDIDATE_LIST_HEADER}${candidates.length}`]
  for (const candidate of candidates) {
    lines.push(`${candidate.seq}\t${candidate.time}\t${candidate.preview}`)
  }
  return lines.join('\n')
}

/**
 * Resolve a target against the session log and surface into a validated plan.
 * @param events - the full session event log.
 * @param surface - the ordered surface node seqs.
 * @param target - the parsed target.
 * @returns the validated rewind plan.
 * @throws {RewindError} with a typed code when the target is unusable.
 */
export function planRewind(
  events: readonly SessionEvent[],
  surface: readonly number[],
  target: RewindTarget,
): RewindPlan {
  let targetSeq: number
  if (target.kind === 'seq') {
    targetSeq = target.seq
  } else {
    const candidate = listRewindCandidates(events, surface, target.index)[target.index - 1]
    if (candidate === undefined) {
      throw new RewindError('invalid-index', `rewind index ${target.index} has no candidate`)
    }
    targetSeq = candidate.seq
  }

  const targetEvent = events.find(event => event.seq === targetSeq)
  if (targetEvent === undefined) {
    throw new RewindError('not-a-user-message', `no session event at seq ${targetSeq}`)
  }
  // Only a HUMAN user message is a valid rewind boundary: injected
  // context / compaction checkpoints arrive as `user/message` with a
  // non-`'user'` source and must not be rewindable.
  if (!isHumanUserMessageEvent(targetEvent)) {
    throw new RewindError(
      'not-a-user-message',
      `session event at seq ${targetSeq} is not a human user message (${targetEvent.type})`,
    )
  }

  const targetIndex = surface.indexOf(targetSeq)
  if (targetIndex === -1) {
    throw new RewindError(
      'not-on-surface',
      `user message at seq ${targetSeq} is no longer in the model context (shadowed by compaction)`,
    )
  }
  // Rewinding to a message WITHDRAWS it and everything after it (time-travel
  // semantics: the conversation returns to before that message; its content
  // is offered back in the composer for re-sending). The replacement range
  // therefore ALWAYS includes the target.
  const shadowedSeqs = surface.slice(targetIndex)
  return {
    targetSeq,
    targetIndex,
    shadowedSeqs,
    surfaceStart: shadowedSeqs[0]!,
    surfaceEnd: shadowedSeqs[shadowedSeqs.length - 1]!,
  }
}

/** Human rendering of a candidate list line (`/rewind` step 1). */
export function formatCandidate(candidate: RewindCandidate): string {
  const time = new Date(candidate.time)
  const hh = String(time.getHours()).padStart(2, '0')
  const mm = String(time.getMinutes()).padStart(2, '0')
  return `${candidate.index}. ${hh}:${mm} ${candidate.preview || '(no text)'}`
}
