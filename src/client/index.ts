/**
 * dsh-rewind client half: the per-user-message ↶ rewind button and the
 * mode-selection popover, injected into the conversation DOM (pure plugin —
 * no harness source patches).
 *
 * Anchoring: each chat node seat renders `[data-chat-flow-kind]` with
 * `data-chat-anchor-key`; a `MutationObserver` tracks newly rendered user
 * seats and appends the rewind button into the message's IconActions row.
 * The seq is never parsed from DOM text — the key is looked up in the runtime
 * snapshot (`session.getSnapshot().chat.nodes.get(key)`) to get the durable
 * `UserMessageNode.seq`.
 *
 * Interaction: clicking a message's button fixes the target (step one), the
 * popover offers the two modes (step two); "rewind conversation and code"
 * first fetches the impact list via `/rewind preview @seq both` and confirms
 * before executing. Execution always goes through `session.command(...)`, the
 * same host path the `/rewind` command uses.
 *
 * @module dsh-rewind/client
 */

import type {
  ClientContext, CommandNode, SessionFace, UserMessageNode,
} from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the ctx.locale merge from the locale plugin.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { en, zh } from './locales.ts'
import { closePopover, openPopover } from './popover.ts'
import { CLASS, REWIND_ATTACHED, REWIND_ICON_SVG, STYLE } from './styles.ts'

export const name = 'dsh-rewind'
export const inject = ['sessions', 'locale']

const NS = 'rewind'
const USER_SEAT_SELECTOR = '[data-chat-flow-kind="user"]'
const CHAT_SEAT_SELECTOR = '[data-chat-anchor-key]'
const ACTIONS_ROOT_SELECTOR = '[data-time-hover-root]'

/** Structured prefix the host marker carries: `__DSH_REWIND__:{"target":N}`. */
const REWIND_MARKER_RE = /__DSH_REWIND__:\{"target":(\d+)\}/

/** Join the text blocks of a user message into one plain preview. */
function messagePreviewOf(node: UserMessageNode): string {
  return node.content
    .map(block => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
}

/**
 * Anchor seqs that must be hidden from the rendered transcript so the user
 * sees the conversation as it was before the rewind (matching what the agent
 * sees): every rewind marker, every `/rewind` command row, and every message
 * withdrawn between the latest marker's target and the marker itself.
 */
function hiddenSeqsOf(session: SessionFace): Set<number> {
  const hidden = new Set<number>()
  const snap = session.getSnapshot()
  let latest: { marker: number; target: number } | null = null
  for (const key of snap.chat.order) {
    const node = snap.chat.nodes.get(key)
    if (node === undefined) continue
    if (node.kind === 'command') {
      const command = node.data as CommandNode
      if (command.name === 'rewind') hidden.add(command.seq)
    } else if (node.kind === 'user') {
      const user = node.data as UserMessageNode
      const text = user.content
        .map(block => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
        .join('')
      const match = text.match(REWIND_MARKER_RE)
      if (match !== null) {
        hidden.add(user.seq)
        const target = Number(match[1])
        if (latest === null || user.seq > latest.marker) latest = { marker: user.seq, target }
      }
    }
  }
  if (latest !== null) {
    for (const key of snap.chat.order) {
      const node = snap.chat.nodes.get(key)
      if (node === undefined) continue
      const anchor = node.anchorSeq
      if (anchor > latest.target && anchor <= latest.marker) hidden.add(anchor)
    }
  }
  return hidden
}

/**
 * Client plugin body: button injection + popover wiring.
 * @param ctx - client root context carrying `sessions` and `locale`.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(function* () {
    yield ctx.locale.register(NS, { zh, en })
    const t = ctx.locale.bind(NS)

    const style = document.createElement('style')
    style.dataset.plugin = 'dsh-rewind'
    style.textContent = STYLE
    document.head.appendChild(style)

    const attached = new WeakSet<HTMLElement>()
    const hidden = new WeakSet<HTMLElement>()
    const buttons = new Map<string, HTMLButtonElement>()
    let observer: MutationObserver | null = null

    /** The current session face, or undefined in no-session mode. */
    const sessionFor = (): SessionFace | undefined => {
      const sessionId = ctx.sessions.list.getSnapshot().current
      if (sessionId === undefined) return undefined
      return ctx.sessions.binding(sessionId)?.session
    }

    /** Resolve the durable user node behind a seat key via the runtime snapshot. */
    const userNodeFor = (key: string, session: SessionFace): UserMessageNode | undefined => {
      const node = session.getSnapshot().chat.nodes.get(key)
      if (node === undefined || node.kind !== 'user') return undefined
      return node.data as UserMessageNode
    }

    /** Append the rewind button into one user seat's actions row. */
    const attach = (seat: HTMLElement): void => {
      const key = seat.dataset.chatAnchorKey
      if (key === undefined || attached.has(seat)) return
      const hoverRoot = seat.querySelector<HTMLElement>(ACTIONS_ROOT_SELECTOR)
      const actions = hoverRoot?.lastElementChild
      // The actions row is the last child of the user row and holds the
      // copy/branch IconActions; refuse to inject when the DOM does not match
      // (a layout change must not break the conversation).
      if (!(actions instanceof HTMLElement) || actions.querySelector('button') === null) return
      attached.add(seat)

      const button = document.createElement('button')
      button.type = 'button'
      button.className = CLASS.button
      button.setAttribute('aria-label', t('button.aria'))
      button.title = t('button.title')
      button.innerHTML = REWIND_ICON_SVG
      button.addEventListener('click', event => {
        event.stopPropagation()
        const session = sessionFor()
        if (session === undefined) {
          // No current session (hero/transition): nothing to rewind, say so
          // instead of failing silently.
          console.warn('[dsh-rewind] rewind button clicked with no current session')
          return
        }
        const node = userNodeFor(key, session)
        if (node === undefined) return
        openPopover({
          session,
          seq: node.seq,
          time: node.time,
          preview: messagePreviewOf(node),
          anchor: button,
          t,
        })
      })
      actions.appendChild(button)
      buttons.set(key, button)
      seat.setAttribute(REWIND_ATTACHED, '')
    }

    const scan = (): void => {
      // Drop buttons whose seat rows were removed from the DOM (React unmount).
      for (const [key, button] of buttons) {
        if (!button.isConnected) buttons.delete(key)
      }
      const session = sessionFor()
      const hiddenSeqs = session !== undefined ? hiddenSeqsOf(session) : new Set<number>()
      // Hide withdrawn rows (rewind markers, /rewind command rows, and every
      // message between the latest marker's target and the marker) so the
      // rendered transcript matches the agent's context. React re-renders
      // recreate rows, so this runs on every mutation.
      for (const seat of document.querySelectorAll<HTMLElement>(CHAT_SEAT_SELECTOR)) {
        const key = seat.dataset.chatAnchorKey
        const anchor = key !== undefined && session !== undefined
          ? session.getSnapshot().chat.nodes.get(key)?.anchorSeq
          : undefined
        if (anchor !== undefined && hiddenSeqs.has(anchor)) {
          seat.style.display = 'none'
          hidden.add(seat)
        } else if (hidden.has(seat)) {
          seat.style.display = ''
          hidden.delete(seat)
        }
      }
      for (const seat of document.querySelectorAll<HTMLElement>(USER_SEAT_SELECTOR)) {
        if (!hidden.has(seat)) attach(seat)
      }
    }

    observer = new MutationObserver(scan)
    observer.observe(document.body, { childList: true, subtree: true })
    scan()

    yield () => {
      observer?.disconnect()
      for (const button of buttons.values()) button.remove()
      buttons.clear()
      closePopover()
      style.remove()
    }
  }, 'dsh-rewind client lifecycle')
}
