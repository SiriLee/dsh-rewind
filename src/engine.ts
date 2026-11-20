/**
 * Host-internal rewind engine: the one pair of operations the command front
 * doors and the public v1 contract share. Inputs are plain data; results carry
 * stable codes and raw outcomes, never localized copy. Request validation,
 * HTTP/command framing and user-facing text belong to the adapters.
 *
 * The two effects are orthogonal: `conversation` cuts the model-visible surface
 * by appending one marker, `files` reconciles the target checkpoint against the
 * live disk. Neither operation keeps server-side plan state: the only binding
 * between preview and commit is the caller-supplied `headSeq`.
 *
 * @module dsh-rewind/engine
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session, SessionSeq, UserMessage } from '@deepseek-ai/dsh-session'
import { REWIND_MARKER_CONTENT, REWIND_MARKER_SOURCE } from './marker.ts'
import { isHumanUserMessageEvent, planRewind, RewindError, type RewindPlan } from './rewind.ts'
import {
  SnapshotStore,
  UnknownStoreVersionError,
  type RestoreOutcome,
  type SkippedPath,
  type StoreSession,
} from './snapshot.ts'

/** The contract's major version, reported by `GET /v1/health`. */
export const CONTRACT_VERSION = 1

/** Which of the two effects a commit executes. */
export type RewindMode = 'conversation' | 'files' | 'both'

/** Why the file effect cannot run for the target. */
export type AvailabilityReason = 'no-checkpoint' | 'checkpointing-disabled' | 'store-unsupported'

/** Contract vocabulary for a path the file effect leaves alone. */
export type ContractSkipReason = 'oversized' | 'parent-changed' | 'unsafe' | 'missing'

/** Contract vocabulary for an expected failure. */
export type EngineErrorCode =
  | 'target-missing'
  | 'head-changed'
  | 'turn-running'
  | 'commit-in-flight'
  | 'internal'

/** One path the file effect leaves alone. */
export interface ContractSkipped {
  readonly path: string
  readonly reason: ContractSkipReason
}

/** One failed file write, with the raw error text (not stable). */
export interface ContractFailed {
  readonly path: string
  readonly message: string
}

/** The content a rewind withdraws, for the caller to refill or resend. */
export interface Withdraw {
  /** Joined text blocks of the target user message. */
  readonly text: string
  /** The target's non-text content blocks, passed through unchanged. */
  readonly attachments: readonly ContentBlock[]
}

/** File effect preview: either the diff list or why it cannot run. */
export type FilesPreview =
  | {
    readonly available: true
    /** Disk changes the commit would apply, sorted by path. */
    readonly changes: readonly { readonly path: string; readonly action: 'restore' | 'delete' }[]
    readonly skipped: readonly ContractSkipped[]
  }
  | { readonly available: false; readonly reason: AvailabilityReason }

/** Result of `preview`: the session head plus the two effect descriptions. */
export interface PreviewValue {
  readonly headSeq: number
  readonly withdraw: Withdraw
  readonly files: FilesPreview
}

/** File effect result: either the applied diff or why it did not run. */
export type FilesCommit =
  | {
    readonly applied: true
    readonly restored: readonly string[]
    readonly deleted: readonly string[]
    readonly skipped: readonly ContractSkipped[]
    readonly failed: readonly ContractFailed[]
  }
  | { readonly applied: false; readonly reason: AvailabilityReason }

/** Result of `commit`: only the requested effects are present. */
export interface CommitValue {
  readonly conversation?: { readonly rewound: true }
  readonly files?: FilesCommit
}

/** One expected engine failure. Unexpected throws become `internal`. */
export interface EngineFailure {
  readonly ok: false
  readonly code: EngineErrorCode
  /** Diagnostic detail (not stable copy). */
  readonly message: string
}

/** Either a successful value or a stable failure code. */
export type EngineResult<T> = { readonly ok: true; readonly value: T } | EngineFailure

/** Everything one mounted engine needs from the host. */
export interface RewindEngineDeps {
  readonly store: SnapshotStore
  /** Live `fileCheckpointingEnabled`; read per operation, never cached. */
  checkpointingEnabled(): boolean
  /** Store warnings and diagnostics; defaults to silently dropping them. */
  log?(message: string): void
}

/** The target's `user/message` id, or undefined when the event is not one. */
export function targetMessageIdOf(session: Session, targetSeq: number): string | undefined {
  const event = session.snapshotEvents().find(candidate => candidate.seq === targetSeq)
  return event?.type === 'user/message' ? event.data.id : undefined
}

/** Build the host-independent session facts the store loader needs. */
export function storeSessionOf(session: Session): StoreSession {
  const messageIds: string[] = []
  for (const event of session.snapshotEvents()) {
    if (event.type === 'user/message') messageIds.push(event.data.id)
  }
  return { id: session.id, version: session.header.version, messageIds }
}

/** Load a session's checkpoint store once, logging its one-time warnings. */
export async function ensureStoreSession(
  store: SnapshotStore,
  session: Session,
  log: (message: string) => void,
): Promise<void> {
  if (store.isLoaded(session.id)) return
  const { warnings } = await store.loadSession(storeSessionOf(session))
  for (const warning of warnings) log(`[dsh-rewind] ${warning}`)
}

/**
 * Wait until an agent reaches idle (a running turn stops), or the deadline/abort
 * hits. Uses the agent's own `whenIdle()` — the loop's activity promise — so a
 * `maintenance` phase, which reads `idle` in `status`, is still followed.
 */
export async function waitForAgentIdle(agent: Agent, signal: AbortSignal | undefined, timeoutMs = 15_000): Promise<boolean> {
  if (signal?.aborted === true) return false
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  try {
    await Promise.race([
      agent.whenIdle(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('rewind idle wait timed out')), timeoutMs)
        onAbort = () => reject(new Error('rewind idle wait aborted'))
        signal?.addEventListener('abort', onAbort, { once: true })
      }),
    ])
    return true
  } catch {
    return false
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort)
  }
}

/** Drop every pending steering (next-step) inbox message. */
function dropPendingSteering(agent: Agent): void {
  for (const message of [...agent.inbox.nextStep]) {
    agent.inbox.remove(message.id)
  }
}

/**
 * Build the rewind marker: a `user/message` carrying the surface-replace op over
 * the target and every surface node after it. `user/message` is the only surface
 * type that can cite the shadowed seqs via `sourceEventSeqs`; the marker is
 * appended while idle, outside any turn (see `docs/architecture.md`).
 */
function buildMarker(): UserMessage {
  return createUserMessage({ content: REWIND_MARKER_CONTENT, source: REWIND_MARKER_SOURCE })
}

/** Map the store's internal skip vocabulary to the contract's. */
function contractSkip(skip: SkippedPath): ContractSkipped {
  return {
    path: skip.path,
    reason: skip.reason === 'parent' ? 'parent-changed' : skip.reason,
  }
}

/** Thrown inside the engine for an expected failure; converted at the boundary. */
class EngineFailureError extends Error {
  constructor(readonly code: EngineErrorCode, message: string) {
    super(message)
    this.name = 'EngineFailureError'
  }
}

/** Read the target message's withdrawable content (text plus non-text blocks). */
function withdrawOf(session: Session, targetSeq: number): Withdraw {
  const event = session.snapshotEvents().find(candidate => candidate.seq === targetSeq)
  if (event?.type !== 'user/message') {
    throw new EngineFailureError('target-missing', `no user message at seq ${targetSeq}`)
  }
  const content = event.data.content
  return {
    text: content.map(block => block.type === 'text' ? block.text : '').join(''),
    attachments: content.filter(block => block.type !== 'text'),
  }
}

/** The mount's rewind engine: per-session commit exclusion plus the two operations. */
export class RewindEngine {
  /** Sessions with a commit currently executing. */
  private readonly inflight = new Set<string>()

  constructor(private readonly deps: RewindEngineDeps) {}

  /** Whether a commit owns this session right now (the checkpoint pipeline skips then). */
  isCommitting(sessionId: string): boolean {
    return this.inflight.has(sessionId)
  }

  /**
   * Describe what a commit would do. Read-only and repeatable: it never appends,
   * restores, cancels or mutates checkpoint state.
   */
  async preview(input: {
    readonly session: Session
    readonly seq: number
  }): Promise<EngineResult<PreviewValue>> {
    try {
      const plan = this.planOf(input.session, input.seq)
      const files = await this.previewFiles(input.session, plan.targetSeq)
      return {
        ok: true,
        value: {
          headSeq: input.session.seq - 1,
          withdraw: withdrawOf(input.session, plan.targetSeq),
          files,
        },
      }
    } catch (error) {
      return this.failure(error)
    }
  }

  /**
   * Execute the requested effects after binding to the caller's session head.
   * The order is fixed: validate the target, reserve the session, compare the
   * head (no cancellation yet), then, for a conversation effect, cancel and
   * await quiescence BEFORE planning the surface. A mismatch causes neither a
   * write nor a cancellation; planning after the wait lets the marker cover
   * surface events an in-flight tool appends during cancellation.
   */
  async commit(input: {
    readonly agent: Agent
    readonly seq: number
    readonly headSeq: number
    readonly mode: RewindMode
    readonly signal?: AbortSignal
  }): Promise<EngineResult<CommitValue>> {
    const { agent, mode } = input
    const session = agent.session
    const sessionId = session.id
    try {
      // Resolve the target event before reserving the session; surface eligibility
      // is checked after the head so a replayed conversation commit reports the
      // stale binding (I2) rather than a generic missing target.
      this.targetEventOf(session, input.seq)
      if (this.inflight.has(sessionId)) {
        throw new EngineFailureError('commit-in-flight', `a rewind is already running for session ${sessionId}`)
      }
      this.inflight.add(sessionId)
      try {
        const head = session.seq - 1
        if (head !== input.headSeq) {
          throw new EngineFailureError('head-changed', `session head is ${head}, expected ${input.headSeq}`)
        }
        if (mode === 'files') {
          // A file-only restore must not kill the turn holding the workspace;
          // surface eligibility is checked before the running-turn refusal, as
          // before.
          const plan = this.planOf(session, input.seq)
          if (agent.status !== 'idle') {
            throw new EngineFailureError('turn-running', 'the turn is still running')
          }
          return { ok: true, value: { files: await this.commitFiles(session, plan.targetSeq) } }
        }
        if (agent.status !== 'idle') {
          agent.cancel({ kind: 'user' }, { keepInbox: true })
          const stopped = await waitForAgentIdle(agent, input.signal)
          if (!stopped) {
            throw new EngineFailureError('turn-running', 'the running turn did not stop in time')
          }
        }
        if (input.signal?.aborted === true) {
          throw new EngineFailureError('turn-running', 'the commit was cancelled')
        }
        // Plan after quiescence: a tool result appended while the turn stopped
        // belongs to the withdrawn surface and must be inside the marker range.
        const plan = this.planOf(session, input.seq)
        dropPendingSteering(agent)
        session.append('user/message', buildMarker(), {
          surfaceOp: {
            op: 'replace',
            startSeq: plan.surfaceStart as SessionSeq,
            endSeq: plan.surfaceEnd as SessionSeq,
          },
          sourceEventSeqs: [...plan.shadowedSeqs] as SessionSeq[],
        })
        const value: CommitValue = {
          conversation: { rewound: true as const },
          ...(mode === 'conversation' ? {} : { files: await this.commitFiles(session, plan.targetSeq) }),
        }
        return { ok: true, value }
      } finally {
        this.inflight.delete(sessionId)
      }
    } catch (error) {
      return this.failure(error)
    }
  }

  /** Resolve one seq to its human user message, or `target-missing`. */
  private targetEventOf(session: Session, seq: number): void {
    const event = session.snapshotEvents().find(candidate => candidate.seq === seq)
    if (event === undefined || !isHumanUserMessageEvent(event)) {
      throw new EngineFailureError('target-missing', `no human user message at seq ${seq}`)
    }
  }

  /** Resolve one seq into a validated plan, or `target-missing`. */
  private planOf(session: Session, seq: number): RewindPlan {
    try {
      return planRewind(session.snapshotEvents(), session.surface.nodes, seq)
    } catch (error) {
      if (error instanceof RewindError) {
        throw new EngineFailureError('target-missing', error.message)
      }
      throw error
    }
  }

  /** Describe the file effect for one target, including why it cannot run. */
  private async previewFiles(session: Session, targetSeq: number): Promise<FilesPreview> {
    const messageId = targetMessageIdOf(session, targetSeq)
    if (messageId === undefined) return { available: false, reason: 'no-checkpoint' }
    await ensureStoreSession(this.deps.store, session, this.log)
    try {
      const preview = await this.deps.store.preview(session.id, messageId)
      if (preview.noCheckpoint) return { available: false, reason: this.noCheckpointReason() }
      return {
        available: true,
        changes: preview.files,
        skipped: preview.skipped.map(contractSkip),
      }
    } catch (error) {
      if (error instanceof UnknownStoreVersionError) {
        this.log(`[dsh-rewind] checkpoint store v${error.version} is newer than this plugin understands; file preview skipped`)
        return { available: false, reason: 'store-unsupported' }
      }
      throw error
    }
  }

  /** Apply the file effect for one target, or report why it did not run. */
  private async commitFiles(session: Session, targetSeq: number): Promise<FilesCommit> {
    const messageId = targetMessageIdOf(session, targetSeq)
    if (messageId === undefined) return { applied: false, reason: 'no-checkpoint' }
    await ensureStoreSession(this.deps.store, session, this.log)
    let outcome: RestoreOutcome
    try {
      outcome = await this.deps.store.restoreAfter(session.id, messageId)
    } catch (error) {
      if (error instanceof UnknownStoreVersionError) {
        this.log(`[dsh-rewind] checkpoint store v${error.version} is newer than this plugin understands; file restore skipped`)
        return { applied: false, reason: 'store-unsupported' }
      }
      throw error
    }
    if (outcome.noCheckpoint) return { applied: false, reason: this.noCheckpointReason() }
    return {
      applied: true,
      restored: outcome.restored,
      deleted: outcome.deleted,
      skipped: outcome.skipped.map(contractSkip),
      failed: outcome.failed,
    }
  }

  /** Explain a missing target checkpoint using the live recording policy. */
  private noCheckpointReason(): AvailabilityReason {
    return this.deps.checkpointingEnabled() ? 'no-checkpoint' : 'checkpointing-disabled'
  }

  private log = (message: string): void => {
    this.deps.log?.(message)
  }

  /** Convert an expected failure or an unexpected throw into a result. */
  private failure<T>(error: unknown): EngineResult<T> {
    if (error instanceof EngineFailureError) {
      return { ok: false, code: error.code, message: error.message }
    }
    return { ok: false, code: 'internal', message: error instanceof Error ? error.message : String(error) }
  }
}
