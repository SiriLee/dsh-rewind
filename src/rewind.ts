/**
 * Pure rewind planning: target resolution and surface-range computation.
 * No I/O and no `Session` dependency — everything derives from the event log
 * and the ordered surface, so this module stays unit-testable.
 *
 * Rewind semantics: rewinding to a user message appends a marker node into the
 * session log whose `surfaceOp` replaces the target and every surface node
 * after it with itself. The log (audit trail, rendered transcript) is
 * untouched; only the model-visible surface is cut, so the next request
 * derives its context from before the target message. The marker is a `user/message` carrying a
 * replace `surfaceOp` and the producer-owned source `{ kind: 'dsh-rewind' }`
 * (see `marker.ts`); the shape's invariants and history are documented in
 * `docs/architecture.md`.
 *
 * @module dsh-rewind/rewind
 */

import type { SessionEvent, UserMessage } from '@deepseek-ai/dsh-session'

export { REWIND_MARKER_SOURCE } from './marker.ts'

/** Expected failure codes; each maps to a concise human outcome. */
export type RewindErrorCode =
  | 'no-user-messages'
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
}

/** A validated rewind: the target plus the exact surface range to shadow. */
export interface RewindPlan {
  /** Target user message seq (withdrawn with the surface range). */
  readonly targetSeq: number
  /** The target's ordered position in the surface. */
  readonly targetIndex: number
  /** Ordered surface node seqs the rewind shadows (the target and everything after it). */
  readonly shadowedSeqs: readonly number[]
  /** The target — the replace range start (inclusive). */
  readonly surfaceStart: number
  /** Last surface node — the replace range end (inclusive). */
  readonly surfaceEnd: number
}

/** Preview length cap for candidate listings. */
export const CANDIDATE_PREVIEW_CHARS = 80

/**
 * Default cap on how many user messages a candidate listing returns (newest
 * kept). Matches the checkpoint store's retention window (100), so every
 * message that can still have a file checkpoint is listed; callers can still
 * pass an explicit `limit`.
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
    })
  }
  return candidates
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
  targetSeq: number,
): RewindPlan {
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
