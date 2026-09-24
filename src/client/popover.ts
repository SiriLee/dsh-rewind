/**
 * The rewind popover's public entry: open and close the panel, plus the
 * composer focus channel the panel's close uses. The panel itself lives in
 * `panel.tsx`, rendered by React through the harness's own `Menu` primitive —
 * this module owns no keyboard handling at all.
 *
 * `knownCommandSeqs` / `waitForCommand` are re-exported from the panel so the
 * long-standing `./popover.ts` import path keeps working.
 *
 * @module dsh-rewind/client/popover
 */

import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import type { SessionFace } from '@deepseek-ai/dsh-api-session-controller/client'
import type { CommandNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatOf, ChatWatch } from './hidden.ts'
import { RewindPanel, type Translate } from './panel.tsx'

export { knownCommandSeqs, waitForCommand } from './panel.tsx'

export interface PopoverOptions {
  readonly session: SessionFace
  /** Durable variant: the target message seq (mode-selection flow). */
  readonly seq?: number
  /** Durable variant: the target message time. */
  readonly time?: number
  /** Pending variant: retract a pre-sent steering message (single-confirm flow). */
  readonly retract?: { readonly itemId: string; readonly text: string | null }
  /** Pending variant: executed after the retract confirm closes the popover. */
  readonly onRetract?: () => void
  readonly preview: string
  /**
   * Chat reader on the `uiConversation` "chat" view: the durable
   * variant's command probes scan the chat through it. Unused by the
   * pending-retract variant.
   */
  readonly chatOf: ChatOf
  /**
   * Subscribe to one session's live chat-update signal, so a probe waiting on
   * a command's chat node can be woken when the chat snapshot changes. Passed
   * straight through to `waitForCommand`.
   */
  readonly watchChat: ChatWatch
  /** The button that opened the popover (positioning anchor). */
  readonly anchor: HTMLElement
  readonly t: Translate
  /**
   * Execute one rewind in the given mode. The popover closes itself first;
   * the callback owns the command + composer-refill lifecycle (see
   * `runRewindAndFill` in index.ts).
   */
  readonly onRewind?: (mode: 'chat' | 'both') => void
}

/** The mounted panel's host element, or null when closed. */
let container: HTMLElement | null = null

/** The mounted panel's React root, or null when closed. */
let root: Root | null = null

/** The session whose popover currently holds the keyboard, or null. */
let liveSessionId: string | null = null

/** The plugin's composer focus channel; the harness's own `focusComposer` shape. */
let composerFocuser: ((sessionId: string) => void) | null = null

/**
 * Register the composer focus channel (called once by the client plugin).
 * @param focus - returns the keyboard to one session's composer, caret included.
 */
export function registerComposerFocuser(focus: (sessionId: string) => void): void {
  composerFocuser = focus
}

/**
 * Close the current popover, if any, handing the keyboard back to its composer.
 * Unmounting first leaves focus on the body; the composer claim then wins over
 * the `Menu`'s own post-close trigger refocus (a no-op here, since the anchor is
 * an empty span).
 */
export function closePopover(): void {
  const mounted = root
  const host = container
  root = null
  container = null
  if (mounted !== null) {
    try {
      mounted.unmount()
    } catch {
      // A root already torn down with the page; the host removal below still runs.
    }
  }
  host?.remove()
  const sessionId = liveSessionId
  liveSessionId = null
  if (sessionId !== null) {
    try {
      composerFocuser?.(sessionId)
    } catch {
      // Focus is presentation; the popover is already gone.
    }
  }
}

/** Open the mode-selection popover anchored near the given button. */
export function openPopover(opts: PopoverOptions): void {
  closePopover()
  liveSessionId = opts.session.sessionId
  const host = document.createElement('div')
  container = host
  document.body.append(host)
  root = createRoot(host)
  // The panel is present on the same tick it was requested: the opening click
  // must not land on a page with no panel (its own outside-click handling
  // would then see the trigger click as an outside press).
  flushSync(() => { root?.render(createElement(RewindPanel, {
    session: opts.session,
    ...opts.seq === undefined ? {} : { seq: opts.seq },
    ...opts.time === undefined ? {} : { time: opts.time },
    ...opts.retract === undefined ? {} : { retract: opts.retract },
    ...opts.onRetract === undefined ? {} : { onRetract: opts.onRetract },
    preview: opts.preview,
    chatOf: opts.chatOf,
    watchChat: opts.watchChat,
    anchor: opts.anchor,
    t: opts.t,
    ...opts.onRewind === undefined ? {} : { onRewind: opts.onRewind },
    onClose: closePopover,
  })) })
}

/** The command-node type the wait helpers match on (kept for the public surface). */
export type { CommandNode }
