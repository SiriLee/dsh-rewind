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
  ClientContext, SessionFace, UserMessageNode,
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
const ACTIONS_ROOT_SELECTOR = '[data-time-hover-root]'

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
      if (actions === null || actions === undefined) return
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
        if (session === undefined) return
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
      for (const seat of document.querySelectorAll<HTMLElement>(USER_SEAT_SELECTOR)) attach(seat)
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
