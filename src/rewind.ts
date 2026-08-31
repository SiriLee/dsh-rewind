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
 * Marker shape (v0.3.4+): the marker is an EMPTY `assistant/message` with a
 * replace `surfaceOp`, wrapped in its own step frame —
 *
 *   step/start (turn, step) → assistant/message (marker) → step/end (turn, step)
 *
 * The step frame exists because the harness token-meter replays the log and
 * requires every `assistant/message` to sit inside an OPEN step whose
 * `(turn, step)` matches exactly (`token meter: assistant/message at seq N
 * has no matching step/start event` otherwise) — a bare marker appended while
 * idle (every step already closed) makes every later measure() call throw,
 * which disables /compact and automatic compaction. The frame's `turn` is the
 * LAST STARTED turn (`markerTurnOf`) and `step` is that turn's next unused
 * step number (`markerStepOf`): never a reused one, or the client
 * conversation assembler sees a duplicate `step/start` and rejects the log
 * with "received more than one start Match". The agent loop numbers its own
 * steps from memory (each new turn restarts at 1), so the ghost step can
 * never collide with a future real step.
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

/**
 * Turn number for the rewind marker.
 *
 * The marker MUST NOT reuse the harness's next-turn number. The agent loop
 * numbers its next real turn `lastTurn/start + 1` (dsh-agent-loop), so a
 * marker numbered `maxTurn + 1` collides: the log then holds an
 * `assistant/message` (the marker) BEFORE the `turn/start` of the same turn,
 * and the client conversation-context builder rejects that ordering with
 * `conversation Context …:turn-tail… received an update before its start
 * Match` — history load fails and the whole conversation disappears from the
 * UI (reproduced across real sessions).
 *
 * The marker therefore reuses the LAST STARTED turn's number: the harness has
 * already consumed it (its next turn is strictly larger), so it can never be
 * reused by a future `turn/start`, and the marker lands as a harmless
 * trailing update on that turn's already-closed tail context (its `turn/end`
 * is already matched) — no new context, no reordering, nothing rendered, and
 * the empty content still derives to `null` in the model context.
 *
 * @param events - the full session event log.
 * @returns a turn number the harness can never reuse for a future `turn/start`.
 */
export function markerTurnOf(events: readonly SessionEvent[]): number {
  let lastStarted = 0
  for (const event of events) {
    if (event.type === 'turn/start' && event.data.turn > lastStarted) {
      lastStarted = event.data.turn
    }
  }
  return lastStarted
}

/**
 * Step number for the rewind marker's ghost step frame.
 *
 * The marker's `assistant/message` must be wrapped in `step/start` …
 * `step/end` of the SAME `(turn, step)` so the harness token-meter replay
 * accepts it (see the module doc). The step number MUST be a step this turn
 * has never started: the client conversation assembler treats `step/start`
 * as the start of an `assistant-step` context keyed `turn:step`, so reusing
 * an already-started step number makes the log replay throw "received more
 * than one start Match" and the history disappears from the UI. Reusing
 * `lastStep + 1` is always safe: the harness numbers a turn's steps from
 * memory (each new turn restarts at 1), so the ghost step can never collide
 * with a future real step of this turn.
 *
 * @param events - the full session event log.
 * @param turn - the marker's turn (normally `markerTurnOf(events)`).
 * @returns the smallest step number this turn has never started (≥ 1).
 */
export function markerStepOf(events: readonly SessionEvent[], turn: number): number {
  let lastStarted = 0
  for (const event of events) {
    if (event.type === 'step/start' && event.data.turn === turn && event.data.step > lastStarted) {
      lastStarted = event.data.step
    }
  }
  return lastStarted + 1
}

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
