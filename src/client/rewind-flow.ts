/**
 * dsh-rewind flow half: the executed rewind and its composer refill.
 *
 * This is the BEHAVIOR layer, deliberately free of any mounting decision. It
 * drives the v1 contract (preview → commit) and returns the withdrawn content
 * to the composer; the confirmation binder is the preview's `headSeq`, so the
 * commit either matches the state the user saw or fails without writing.
 *
 * The refill is event-driven: it runs only after THIS page's commit succeeded.
 * It must never scan loaded history for rewind commands — a session window
 * opens with only the tail page, so "a command already in the snapshot" cannot
 * be told apart from "executed in this page", and a history heuristic refilled
 * withdrawn text into the composer after switching sessions or restarting dsh.
 *
 * @module dsh-rewind/client/rewind-flow
 */

import type { SessionFace } from '@deepseek-ai/dsh-api-session-controller/client'
import type { RewindKey } from './locales.ts'
import { commitOverApi, previewOverApi } from './host-api.ts'
import { imageRefsOf, type ImageBlockLike, type MessageImageRef } from './hidden.ts'
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

/** One withdrawable image block, read from the preview's opaque attachments. */
function imageRefsOfWithdraw(attachments: readonly unknown[]): readonly MessageImageRef[] {
  return imageRefsOf(attachments as readonly ImageBlockLike[])
}

/**
 * Execute one rewind through the v1 contract and, when the conversation effect
 * succeeded, put the withdrawn target message's text and images back into the
 * composer so the user can edit and re-send.
 *
 * @param session - the live session face the rewind targets.
 * @param seq - the target user message seq.
 * @param mode - `conversation` (context only) or `both` (context + files).
 * @param isMainViewSession - fill only the session the main view retains.
 * @param setComposerText - writes one session's composer draft.
 * @param restoreImages - restores the target's images into the composer draft.
 * @param failureText - localizes one stable contract failure code.
 */
export async function runRewindAndFill(
  session: SessionFace,
  seq: number,
  mode: 'conversation' | 'both',
  isMainViewSession: (sessionId: string) => boolean,
  setComposerText: (sessionId: string, text: string) => boolean,
  restoreImages?: (sessionId: string, images: readonly MessageImageRef[]) => Promise<void>,
  failureText?: (code: string) => string,
): Promise<void> {
  const textOfFailure = (code: string): string => failureText?.(code) ?? code
  const preview = await previewOverApi(session.sessionId, seq)
  if (preview === null) {
    rewindLog.warn('refill', `preview request timed out for @${seq}; no rewind`)
    showHint(textOfFailure('internal'))
    return
  }
  if (preview.kind === 'error') {
    rewindLog.warn('refill', `preview rejected @${seq}: ${preview.code}`, preview.message)
    showHint(textOfFailure(preview.code))
    return
  }
  const withdraw = preview.value.withdraw
  const result = await commitOverApi(session.sessionId, seq, preview.value.headSeq, mode)
  if (result === null) {
    rewindLog.warn('refill', `commit request timed out for @${seq}`)
    showHint(textOfFailure('internal'))
    return
  }
  if (result.kind === 'error') {
    rewindLog.warn('refill', `commit rejected @${seq}: ${result.code}`, result.message)
    showHint(textOfFailure(result.code))
    return
  }
  if (result.value.files?.applied === false) {
    rewindLog.warn('refill', `file effect unavailable for @${seq}: ${result.value.files.reason}`)
  }
  // The user may have switched sessions while the commit ran — fill only the
  // composer of the session the rewind actually happened in.
  if (!isMainViewSession(session.sessionId)) return
  // Restore the withdrawn message's images FIRST: adding draft attachments
  // never clobbers an in-progress draft, so this is NOT gated by the
  // empty-composer guard below. Best-effort — a restore failure leaves the text
  // refill intact.
  const images = imageRefsOfWithdraw(withdraw.attachments)
  if (restoreImages !== undefined && images.length > 0) {
    try {
      await restoreImages(session.sessionId, images)
    } catch (error) {
      rewindLog.warn('refill', `image restore for @${seq} threw`, error)
    }
  }
  if (withdraw.text === '') return
  // Empty-composer guard (Claude Code parity): never clobber a draft the user
  // is already editing.
  if (composerText().trim() !== '') return
  try {
    setComposerText(session.sessionId, withdraw.text)
  } catch (error) {
    rewindLog.warn('refill', `composer refill @${seq} threw`, error)
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
