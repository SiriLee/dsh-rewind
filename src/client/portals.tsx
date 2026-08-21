/**
 * dsh-rewind portal half: the per-user-message ↶ rewind button, rendered as a
 * React portal inside the message's `MessageIconActions` row.
 *
 * Why portals (aligned with the copy button's own rendering): the copy button
 * is a React child of the actions row, painted in the same commit as the
 * bubble. A pure-DOM `appendChild` (the earlier approach) lands one microtask
 * later and re-runs a full-transcript scan on EVERY mutation, which can push
 * the paint of a newly sent bubble — the "occasional hiccup before the bubble
 * shows". Portals let React own the button lifecycle (mount/unmount with the
 * row, no orphaned buttons, no manual re-attach after harness re-renders),
 * and the target collection is coalesced (one refresh per mutation batch) and
 * diffed (no setState churn when nothing changed).
 *
 * Mount point: the plugin registers a session-scoped bridge into the harness's
 * `conversation.session.header.actions` list slot. The bridge renders NO
 * header UI — it only portals buttons into the user rows of the session the
 * harness mounts it for. That slot is the harness-native way to get a
 * per-session React mount without touching any source; the registration is
 * typed structurally (see `SlotsLike`) so the plugin never imports the
 * conversation UI package's types and survives its version drift.
 *
 * @module dsh-rewind/client/portals
 */

import {
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  createElement,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import type { ChatConversationViewNode, SessionFace, UserMessageNode } from '@deepseek-ai/dsh-client-runtime/client'
import { hiddenSeqsOf, isExecutedRewindCommand } from './hidden.ts'
import type { RewindKey } from './locales.ts'
import { messagePreviewOf } from './menu.ts'
import { knownCommandSeqs, openPopover, waitForCommand } from './popover.ts'
import { CLASS, REWIND_ICON_SVG } from './styles.ts'

type Translate = (key: RewindKey, params?: Record<string, unknown>) => string

/** The chat snapshot shape the portal collection reads (structural subset). */
interface ChatLike {
  readonly order: readonly string[]
  readonly nodes: { get(key: string): ChatConversationViewNode | undefined }
}

/** One portal target: the actions row of a user/steering seat + its durable node. */
interface PortalTarget {
  readonly key: string
  /** The row's actions container (React portal target). */
  readonly container: HTMLElement
  readonly seq: number
  readonly time: number
  readonly preview: string
}

/** Capabilities the session-scoped bridge receives from the plugin apply(). */
export interface RewindBridgeDeps {
  readonly sessionOf: (sessionId: string) => SessionFace | undefined
  readonly currentSessionId: () => string | undefined
  readonly t: Translate
  readonly subscribeLocale: (cb: () => void) => () => void
}

/** Structural face of the runtime slot service (see the module doc). */
export interface SlotsLike {
  inject(key: string, install: () => () => void): () => void
  register(
    entry: { readonly name: string; readonly id: string; readonly order: number },
    component: (props: { readonly sessionId: string }) => ReactNode,
  ): () => void
}

/** Join the text blocks of a user message into one plain preview. */
// (shared with the manual /rewind menu — see `messagePreviewOf` in menu.ts)

/**
 * The plain text of the user message at `seq` in the session snapshot, for
 * filling the composer after a withdraw.
 */
function userTextAt(session: SessionFace, seq: number): string | undefined {
  const snap = session.getSnapshot()
  for (const key of snap.chat.order) {
    const node = snap.chat.nodes.get(key)
    if (node === undefined || node.kind !== 'user') continue
    const user = node.data as UserMessageNode
    if (user.seq === seq) {
      return user.content
        .map(block => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
        .join('')
    }
  }
  return undefined
}

/**
 * Fill the dsh composer with `text` (React-controlled textarea: use the
 * native setter so the value change is seen, then dispatch an input event).
 * Best-effort — no composer match means the fill is skipped. The manual
 * `/rewind` menu reuses this to consume the typed command (clear the input)
 * when it opens.
 */
export function fillComposer(text: string): boolean {
  const textarea = document.querySelector<HTMLTextAreaElement>(COMPOSER_SELECTOR)
  if (textarea === null) return false
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  setter?.call(textarea, text)
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
  textarea.focus()
  return true
}

/** The durable user/steering node behind a seat key via the runtime snapshot. */
function userNodeOf(session: SessionFace, key: string): UserMessageNode | undefined {
  const node = session.getSnapshot().chat.nodes.get(key)
  if (node === undefined || (node.kind !== 'user' && node.kind !== 'steering')) return undefined
  // SteeringMessageNode carries the same seq/time/content/source fields.
  return node.data as UserMessageNode
}

/**
 * Execute one rewind from the popover and, when it settles successfully,
 * put the withdrawn target message's text back into the composer so the
 * user can edit and re-send.
 *
 * THE COMPOSER FILL IS EVENT-DRIVEN: it runs only when THIS page performed
 * the rewind (the user clicked confirm moments ago). It must NEVER scan
 * loaded history for rewind commands: a session window opens with only
 * the tail page and grows via loadOlder, so a "command already in the
 * snapshot" cannot be told apart from "command executed in this page" —
 * the old baseline heuristic refilled withdrawn text into the composer
 * after switching sessions or restarting dsh.
 */
export async function runRewindAndFill(
  session: SessionFace,
  seq: number,
  mode: 'chat' | 'both',
  currentSessionId: () => string | undefined,
): Promise<void> {
  // Exclude already-present executed-rewind nodes for this target BEFORE
  // issuing the command: a repeated rewind of the same message must wait
  // for THIS command's node, not settle on the previous one.
  const known = knownCommandSeqs(session, node => isExecutedRewindCommand(node, seq))
  const result = await session.command(`/rewind @${seq} ${mode}`)
  if (!result.ok || result.value?.matched !== true) return
  // The executed rewind lands as a CommandNode with a marker-carrying
  // success outcome; wait for exactly that (longer than the preview wait:
  // a running turn is cancelled first, which can take seconds).
  const outcome = await waitForCommand(session, node => isExecutedRewindCommand(node, seq) && !known.has(node.seq), 20_000)
  if (outcome === null || outcome.kind !== 'success') return
  // The user may have switched sessions while the rewind ran — fill only
  // the composer of the session the rewind actually happened in.
  if (currentSessionId() !== session.sessionId) return
  const text = userTextAt(session, seq)
  if (text === undefined || text === '') return
  fillComposer(text)
}

/** The composer textarea dsh renders for the current session's input. */
const COMPOSER_SELECTOR = '[data-input-scroll] textarea, textarea[data-phase]'

/** Both durable user messages and durable steering inputs render user-style rows. */
const USER_SEAT_SELECTOR = '[data-chat-flow-kind="user"][data-chat-anchor-key], [data-chat-flow-kind="steering"][data-chat-anchor-key]'

/** Every conversation seat row (hidden rows included). */
const CHAT_SEAT_SELECTOR = '[data-chat-anchor-key]'

/** The row container whose hover reveals the actions (and the time). */
const ACTIONS_ROOT_SELECTOR = '[data-time-hover-root]'

/** Collect the portal targets of one session: user rows × snapshot nodes. */
function collectTargets(chat: ChatLike, hiddenSeqs: ReadonlySet<number>): readonly PortalTarget[] {
  const rows = new Map<string, HTMLElement>()
  for (const element of document.querySelectorAll<HTMLElement>(USER_SEAT_SELECTOR)) {
    const key = element.dataset.chatAnchorKey
    if (key !== undefined) rows.set(key, element)
  }
  const targets: PortalTarget[] = []
  for (const key of chat.order) {
    const node = chat.nodes.get(key)
    if (node === undefined || (node.kind !== 'user' && node.kind !== 'steering')) continue
    const user = node.data as UserMessageNode
    // A withdrawn row must not get a button (it is not part of the surface).
    if (hiddenSeqs.has(node.anchorSeq ?? user.seq)) continue
    const row = rows.get(key)
    const messageRoot = row?.querySelector<HTMLElement>(ACTIONS_ROOT_SELECTOR)
    const actions = messageRoot?.lastElementChild
    // The actions row is the last child of the user row and holds the
    // copy/branch IconActions; refuse to portal when the DOM does not match
    // (a layout change must not break the conversation).
    if (!(actions instanceof HTMLElement) || actions.querySelector('button') === null) continue
    targets.push({ key, container: actions, seq: user.seq, time: user.time, preview: messagePreviewOf(user) })
  }
  return targets
}

/** Whether two target lists describe the same portals (order-sensitive). */
function sameTargets(left: readonly PortalTarget[], right: readonly PortalTarget[]): boolean {
  return left.length === right.length && left.every((target, index) => {
    const other = right[index]
    return other !== undefined
      && target.key === other.key
      && target.container === other.container
      && target.seq === other.seq
  })
}

interface RewindPortalsProps extends RewindBridgeDeps {
  readonly sessionId: string
}

/**
 * Session-scoped portal bridge: renders the ↶ button of every user message
 * row of the session the harness mounts it for. The refresh is coalesced
 * (one pass per mutation batch via queueMicrotask) and diffed (setState is
 * skipped when the target set is unchanged), so the plugin never runs a
 * synchronous full-transcript scan inside a commit microtask.
 */
export function RewindPortals({ sessionId, sessionOf, currentSessionId, t, subscribeLocale }: RewindPortalsProps): ReactNode {
  const [targets, setTargets] = useState<readonly PortalTarget[]>([])
  // Rows we have hidden; re-shown when they leave the withdrawn span.
  const hidden = useRef(new WeakSet<HTMLElement>())
  // Re-render when the active locale switches so injected button labels
  // keep following the dsh language preference (the popover and guard hint
  // are created fresh each time and already read the current locale).
  const [, forceRender] = useReducer((count: number) => count + 1, 0)
  useEffect(() => subscribeLocale(() => { forceRender() }), [subscribeLocale])

  useLayoutEffect(() => {
    let active = true
    let queued = false

    const refresh = (): void => {
      if (!active) return
      const session = sessionOf(sessionId)
      if (session === undefined) {
        // Session binding gone (teardown window): drop every portal.
        setTargets([])
        return
      }
      const chat = session.getSnapshot().chat
      const hiddenSeqs = hiddenSeqsOf(chat)
      let hiddenCount = 0
      // Hide withdrawn rows (rewind markers, /rewind command rows, and every
      // message inside the executed rewinds' [earliest target, latest marker]
      // span) so the rendered transcript matches the agent's context. React
      // re-renders recreate rows, so this runs on every refresh.
      //
      // Each hidden row also carries a semantic marker (`data-dsh-rewind-hidden`)
      // so DevTools, other DOM plugins and tests can tell a rewind-hide apart
      // from any collapse/filter hide. Purely observational: the marker is
      // kept in sync with the hide/show state on both branches (a recreated
      // row has no marker and is re-marked when it re-enters a hidden span).
      for (const seat of document.querySelectorAll<HTMLElement>(CHAT_SEAT_SELECTOR)) {
        const key = seat.dataset.chatAnchorKey
        const anchor = key !== undefined ? chat.nodes.get(key)?.anchorSeq : undefined
        if (anchor !== undefined && hiddenSeqs.has(anchor)) {
          seat.style.display = 'none'
          seat.dataset.dshRewindHidden = 'true'
          hidden.current.add(seat)
          hiddenCount += 1
        } else if (hidden.current.has(seat)) {
          seat.style.display = ''
          delete seat.dataset.dshRewindHidden
          hidden.current.delete(seat)
        }
      }
      // Diagnostics (only when something is hidden): confirm the hiding path
      // actually fires in the browser.
      if (hiddenSeqs.size > 0 || hiddenCount > 0) {
        console.info(
          `[dsh-rewind] hiding: ${hiddenCount} rows, seqs [${[...hiddenSeqs].slice(0, 20).join(', ')}${hiddenSeqs.size > 20 ? '…' : ''}]`,
        )
      }
      const next = collectTargets(chat, hiddenSeqs)
      // Diff: no change → no re-render (the observer fires on every mutation;
      // only an actual target-set change should touch React).
      setTargets(current => (sameTargets(current, next) ? current : next))
    }

    // Coalesce: any number of mutations in a batch collapse into ONE refresh
    // (microtask), instead of one synchronous full scan per mutation — this
    // is what keeps the plugin off the critical path of the frame that paints
    // a newly sent bubble.
    const queueRefresh = (): void => {
      if (queued || !active) return
      queued = true
      queueMicrotask(() => {
        queued = false
        refresh()
      })
    }

    refresh()
    const observer = new MutationObserver(queueRefresh)
    // attributes: watch style so a harness re-render that resets display is
    // re-hidden on the next refresh instead of flickering back.
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] })
    return () => {
      active = false
      observer.disconnect()
    }
  }, [sessionId, sessionOf])

  return targets.map(target => createPortal(
    <RewindButton
      key={target.key}
      target={target}
      sessionId={sessionId}
      sessionOf={sessionOf}
      currentSessionId={currentSessionId}
      t={t}
    />,
    target.container,
    target.key,
  ))
}

interface RewindButtonProps {
  readonly target: PortalTarget
  readonly sessionId: string
  readonly sessionOf: (sessionId: string) => SessionFace | undefined
  readonly currentSessionId: () => string | undefined
  readonly t: Translate
}

/** The per-message ↶ button (28px, matching the harness IconActions). */
function RewindButton({ target, sessionId, sessionOf, currentSessionId, t }: RewindButtonProps): ReactNode {
  const onClick = (event: ReactMouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation()
    const session = sessionOf(sessionId)
    if (session === undefined) {
      // No session binding (transition): nothing to rewind, say so instead
      // of failing silently.
      console.warn('[dsh-rewind] rewind button clicked with no session binding')
      return
    }
    const node = userNodeOf(session, target.key)
    if (node === undefined) return
    openPopover({
      session,
      seq: node.seq,
      time: node.time,
      preview: messagePreviewOf(node),
      anchor: event.currentTarget,
      t,
      onRewind: mode => { void runRewindAndFill(session, node.seq, mode, currentSessionId) },
    })
  }

  return (
    <button
      type="button"
      className={CLASS.button}
      aria-label={t('button.aria')}
      title={t('button.title')}
      onClick={onClick}
      dangerouslySetInnerHTML={{ __html: REWIND_ICON_SVG }}
    />
  )
}

/**
 * Build the slot-entry component for the plugin apply(): a tiny bridge that
 * injects the apply-time capabilities (session resolution, locale, rewind
 * runner) into the module-level `RewindPortals`.
 */
export function createRewindBridge(deps: RewindBridgeDeps): (props: { readonly sessionId: string }) => ReactNode {
  return function RewindBridge({ sessionId }): ReactNode {
    return createElement(RewindPortals, { sessionId, ...deps })
  }
}
