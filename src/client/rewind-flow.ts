/**
 * dsh-rewind flow half: the executed rewind command and its composer refill.
 *
 * This is the BEHAVIOR layer, deliberately free of any mounting decision. Both
 * the `/rewind` text flow (command decoration → mode popover) and, in A2, the
 * per-message action call {@link runRewindAndFill}; nothing here portals,
 * observes rows, or knows where the trigger sits.
 *
 * The refill is event-driven: it runs only when THIS page performed the
 * rewind (the user confirmed moments ago). It must NEVER scan loaded history
 * for rewind commands — a session window opens with only the tail page, so
 * "a command already in the snapshot" cannot be told apart from "executed in
 * this page", and the old baseline heuristic refilled withdrawn text into the
 * composer after switching sessions or restarting dsh.
 *
 * @module dsh-rewind/client/rewind-flow
 */

import type { SessionFace } from '@deepseek-ai/dsh-api-session-controller/client'
import { ENGINE_COMMAND, isExecutedRewindCommand, messageAttachmentsAt, messageTextAt, type ChatOf, type ChatWatch, type MessageImageRef } from './hidden.ts'
import { knownCommandSeqs, waitForCommand } from './popover.ts'
import { rewindLog } from './log.ts'
import { CLASS } from './styles.ts'

/**
 * The composer's text surface: the Lexical `contenteditable` div
 * `[data-composer-input]`. The DOM fallback of the composer write and the
 * failure toast anchor both point at it.
 */
const COMPOSER_EDITABLE_SELECTOR = '[data-composer-input]'

/**
 * The session input facade's write face (structural, so the plugin
 * never imports the conversation UI package). `setDraft` replaces the whole
 * composer draft through the harness's own Lexical editor — the correct way
 * to restore the withdrawn text.
 */
interface ComposerDraftWriter {
  setDraft(text: string): void
  /**
   * Return the keyboard to the composer with the caret it last held (the
   * facade's own `focus`). Optional so the DOM fallback and older faces still
   * restore the text.
   */
  focus?(): void
}

/**
 * Write `text` into the Lexical `contenteditable` composer
 * (`[data-composer-input]`) through the native editing pipeline: set a
 * full-content selection, then `insertText`. That fires `beforeinput`, which
 * the harness's plain-text Lexical editor adopts into its model, exactly like
 * a user typing. Falls back to a direct text-node write when `execCommand` is
 * unavailable (non-Chromium only); best-effort. This is the DOM fallback of
 * the composer write (the primary channel is the `setDraft` facade).
 */
function fillComposerEditable(text: string): boolean {
  const editable = document.querySelector<HTMLElement>(COMPOSER_EDITABLE_SELECTOR)
  if (editable === null) return false
  editable.focus()
  const selection = document.getSelection()
  if (selection !== null) {
    const range = document.createRange()
    range.selectNodeContents(editable)
    selection.removeAllRanges()
    selection.addRange(range)
  }
  let ok = false
  try {
    ok = document.execCommand('insertText', false, text)
  } catch {
    ok = false
  }
  if (ok) return true
  editable.textContent = text
  editable.dispatchEvent(new Event('input', { bubbles: true }))
  return true
}

/**
 * Fill the dsh composer with `text` through the `contenteditable`
 * DOM path. Used by `setComposerText` (the harness-facade-aware writer) as the
 * last-resort and by `runRewindAndFill` to put the withdrawn target message
 * back into the composer after a rewind. Best-effort — no composer match means
 * false, never a throw.
 */
export function fillComposer(text: string): boolean {
  return fillComposerEditable(text)
}

/**
 * Composer write: prefer the harness facade's `setDraft` (correct whole-draft
 * replace), then degrade to the DOM `fillComposer` (contenteditable). A facade
 * that throws (session teardown) is treated as absent so the DOM path still
 * restores the text. Never throws.
 * @param text - the withdrawn target message text.
 * @param facade - the session input draft writer, when reachable.
 * @returns whether a channel applied the text.
 */
export function writeComposer(text: string, facade: ComposerDraftWriter | undefined): boolean {
  if (facade !== undefined) {
    try {
      facade.setDraft(text)
      try {
        // The confirm popover held the keyboard; give it back, caret included.
        facade.focus?.()
      } catch {
        // Focus is presentation; the restored draft is what matters.
      }
      return true
    } catch {
      // Fall through to the DOM channel (the facade must never kill the refill).
    }
  }
  return fillComposer(text)
}

/**
 * Execute one rewind and, when it settles successfully, put the withdrawn
 * target message's text back into the composer so the user can edit and
 * re-send.
 */
export async function runRewindAndFill(
  session: SessionFace,
  seq: number,
  mode: 'chat' | 'both',
  isMainViewSession: (sessionId: string) => boolean,
  chatOf: ChatOf,
  watchChat: ChatWatch,
  setComposerText: (sessionId: string, text: string) => boolean,
  restoreImages?: (sessionId: string, images: readonly MessageImageRef[]) => Promise<void>,
): Promise<void> {
  // Exclude already-present executed-rewind nodes for this target BEFORE
  // issuing the command: a repeated rewind of the same message must wait
  // for THIS command's node, not settle on the previous one.
  const known = knownCommandSeqs(session, chatOf, node => isExecutedRewindCommand(node, seq))
  let result: Awaited<ReturnType<SessionFace['command']>>
  try {
    result = await session.command(`/${ENGINE_COMMAND} @${seq} ${mode}`)
  } catch (error) {
    // A command/teardown throw must never become a silent unhandled rejection
    // on the `void runRewindAndFill(...)` call site.
    rewindLog.warn('refill', `rewind command threw, skipping refill @${seq}`, error)
    return
  }
  if (!result.ok) {
    // The Host rejected the call before any handler ran — e.g. a
    // subagent-owned identity (`session/agent-busy`, "use subagent delivery"),
    // or a command this Host does not have. Nothing was rewound: say so in the
    // console instead of failing silently (SiriLee/dsh-rewind#26).
    rewindLog.warn('refill', `rewind command rejected for @${seq}`, result.error)
    return
  }
  if (result.value?.matched !== true) {
    rewindLog.warn('refill', `rewind command was not matched for @${seq}`)
    return
  }
  // The executed rewind lands as a CommandNode with a marker-carrying
  // success outcome; wait for exactly that (longer than the preview route
  // timeout: a running turn is cancelled first, which can take seconds).
  let outcome: Awaited<ReturnType<typeof waitForCommand>>
  try {
    outcome = await waitForCommand(session, chatOf, node => isExecutedRewindCommand(node, seq) && !known.has(node.seq), 20_000, cb => watchChat(session.sessionId, cb))
  } catch (error) {
    rewindLog.warn('refill', `waiting for rewind @${seq} outcome threw`, error)
    return
  }
  if (outcome === null) {
    rewindLog.warn('refill', `rewind @${seq} never settled within timeout, no refill`)
    return
  }
  if (outcome.kind !== 'success') {
    // The host rejected the rewind (e.g. the target was shadowed by
    // compaction and is no longer in the model context). The refusal is the
    // correct behavior, but it must not fail silently — surface the host's
    // reason instead.
    showHint(outcome.text ?? 'rewind failed')
    return
  }
  // The user may have switched sessions while the rewind ran — fill only
  // the composer of the session the rewind actually happened in.
  if (!isMainViewSession(session.sessionId)) {
    return
  }
  let text: string | undefined
  let images: readonly MessageImageRef[] | undefined
  try {
    const chat = chatOf(session)
    text = messageTextAt(chat, seq)
    images = messageAttachmentsAt(chat, seq)
  } catch (error) {
    rewindLog.warn('refill', `reading target content for @${seq} threw`, error)
    return
  }
  // Restore the withdrawn message's images FIRST: adding draft attachments
  // never clobbers an in-progress draft, so this is NOT gated by the
  // empty-composer guard below. Best-effort — a restore failure leaves the
  // text refill intact (the image stays in the hidden history message).
  if (restoreImages !== undefined && images !== undefined && images.length > 0) {
    try {
      await restoreImages(session.sessionId, images)
    } catch (error) {
      rewindLog.warn('refill', `image restore for @${seq} threw`, error)
    }
  }
  if (text === undefined || text === '') {
    return
  }
  // Empty-composer guard (Claude Code parity): never clobber a draft the user
  // is already editing.
  if (composerText().trim() !== '') {
    return
  }
  try {
    setComposerText(session.sessionId, text)
  } catch (error) {
    rewindLog.warn('refill', `composer refill @${seq} threw`, error)
    return
  }
}

/**
 * The composer's text-holding element: the Lexical `contenteditable`
 * div `[data-composer-input]` (the facade `setDraft` is preferred in
 * `writeComposer`; this DOM path is the fallback).
 */
function composerSurface(): HTMLElement | null {
  return document.querySelector<HTMLElement>(COMPOSER_EDITABLE_SELECTOR)
}

/** Transient status toast above the composer (rewind-failure notification). */
function showHint(text: string): void {
  const surface = composerSurface()
  const hint = document.createElement('div')
  hint.className = CLASS.guardHint
  hint.setAttribute('role', 'status')
  hint.textContent = text
  document.body.appendChild(hint)
  if (surface !== null) {
    const card = surface.closest('[data-composer-card]')
    const rect = card instanceof HTMLElement ? card.getBoundingClientRect() : surface.getBoundingClientRect()
    hint.style.left = `${Math.round(rect.left)}px`
    hint.style.bottom = `${Math.round(window.innerHeight - rect.top + 8)}px`
  }
  window.setTimeout(() => hint.remove(), 3200)
}

/** The current composer draft: the contenteditable `textContent`.
 * Empty when the composer is absent. Exported as a test seam (the
 * empty-composer guard in `runRewindAndFill`). */
export function composerText(): string {
  const surface = composerSurface()
  if (surface === null) return ''
  return surface.textContent ?? ''
}

/**
 * The session-kind slice the durable-target gate reads — the session
 * snapshot's `subagent` cell, the Harness's own runtime signal for a
 * direct-subagent (child) session. Typed structurally so the plugin never
 * imports the session-controller snapshot contract.
 */
export interface SessionKindLike {
  /** Non-null exactly while this Session is addressed as a subagent child. */
  readonly subagent: unknown
}

/**
 * Whether a session is rewind-inert: a direct-subagent (child) session.
 *
 * The Harness refuses every generic Session RPC for a subagent-owned identity
 * (`session/agent-busy`, "use subagent delivery for this child session"), so
 * `/rewind` can never execute there — the command's own admission is the
 * refusal, before any handler runs. A wired-up action in such a session would
 * therefore be dead UI (SiriLee/dsh-rewind#26). This mirrors the Harness's own
 * slash-command directory (which returns no commands for an addressed child)
 * and the Host's `isSubagentSession` skips: a child session gets no rewind
 * surface and records no snapshot.
 */
export function isRewindInertSession(snapshot: SessionKindLike): boolean {
  return snapshot.subagent !== null && snapshot.subagent !== undefined
}
