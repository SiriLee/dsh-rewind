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
/** The composer textarea dsh renders for the current session's input. */
const COMPOSER_SELECTOR = '[data-input-scroll] textarea, textarea[data-phase]'

/** Extract the rewind target from a command outcome text ("已撤回 seq N..."). */
function targetOfOutcome(text: string | undefined): number | undefined {
  if (text === undefined) return undefined
  const match = text.match(/seq (\d+)/)
  return match !== null ? Number(match[1]) : undefined
}

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
 * sees the conversation as the agent sees it: every `/rewind` command row and
 * every message withdrawn by the latest rewind — the target message itself,
 * everything after it, and the (empty, unrendered) marker. The range
 * endpoints come from the command node: `sourceEventSeq` is the marker's log
 * seq, and the outcome text carries the target seq.
 */
function hiddenSeqsOf(session: SessionFace): Set<number> {
  const hidden = new Set<number>()
  const snap = session.getSnapshot()
  let latest: { marker: number; target: number } | null = null
  for (const key of snap.chat.order) {
    const node = snap.chat.nodes.get(key)
    if (node === undefined || node.kind !== 'command') continue
    const command = node.data as CommandNode
    if (command.name !== 'rewind') continue
    // Only SUCCESSFUL rewind commands are hidden (their result is noise once
    // the conversation is rewound). A failed rewind must stay visible so the
    // user sees the error instead of silently missing the rewind.
    if (command.outcome?.kind !== 'success') continue
    hidden.add(command.seq)
    const marker = command.outcome?.sourceEventSeq
    const target = targetOfOutcome(command.outcome?.text)
    if (marker !== undefined && target !== undefined
      && (latest === null || marker > latest.marker)) {
      latest = { marker, target }
    }
  }
  if (latest !== null) {
    for (const key of snap.chat.order) {
      const node = snap.chat.nodes.get(key)
      if (node === undefined) continue
      const anchor = node.anchorSeq
      if (anchor >= latest.target && anchor <= latest.marker) hidden.add(anchor)
    }
  }
  return hidden
}

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
 * Best-effort — no composer match means the fill is skipped.
 */
function fillComposer(text: string): boolean {
  const textarea = document.querySelector<HTMLTextAreaElement>(COMPOSER_SELECTOR)
  if (textarea === null) return false
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  setter?.call(textarea, text)
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
  textarea.focus()
  return true
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

    // Last successful rewind command seq seen; the hidden-range computation
    // only re-runs when a NEW rewind lands (not on every mutation).
    let lastRewindSeq = -1
    let hiddenSeqsCache: Set<number> | null = null

    const scan = (): void => {
      // Drop buttons whose seat rows were removed from the DOM (React unmount).
      for (const [key, button] of buttons) {
        if (!button.isConnected) buttons.delete(key)
      }
      const session = sessionFor()

      // Cheap pass: find the newest successful rewind command. Nothing else in
      // this scan is allowed to do heavy work when there has never been one.
      let newestRewind = -1
      if (session !== undefined) {
        const snap = session.getSnapshot()
        for (const key of snap.chat.order) {
          const node = snap.chat.nodes.get(key)
          if (node === undefined || node.kind !== 'command') continue
          const command = node.data as CommandNode
          if (command.name === 'rewind' && command.outcome?.kind === 'success' && command.seq > newestRewind) {
            newestRewind = command.seq
          }
        }
      }

      // A new rewind landed: recompute the hidden range and refill the composer
      // with the withdrawn message's text (once per target).
      if (newestRewind > lastRewindSeq) {
        lastRewindSeq = newestRewind
        hiddenSeqsCache = session !== undefined ? hiddenSeqsOf(session) : null
        if (session !== undefined) fillComposerForRewind(session, filledTargets)
      }
      const hiddenSeqs = hiddenSeqsCache

      // Apply hiding only when there is something withdrawn (cheap no-op
      // otherwise). React re-renders recreate rows, so this runs per mutation
      // while a rewind range exists — but never on style-only mutations (the
      // observer no longer watches attributes, so streaming is not blocked).
      let hiddenCount = 0
      if (hiddenSeqs !== null && hiddenSeqs.size > 0 && session !== undefined) {
        for (const seat of document.querySelectorAll<HTMLElement>(CHAT_SEAT_SELECTOR)) {
          const key = seat.dataset.chatAnchorKey
          const anchor = key !== undefined
            ? session.getSnapshot().chat.nodes.get(key)?.anchorSeq
            : undefined
          if (anchor !== undefined && hiddenSeqs.has(anchor)) {
            seat.style.display = 'none'
            hidden.add(seat)
            hiddenCount += 1
          } else if (hidden.has(seat)) {
            seat.style.display = ''
            hidden.delete(seat)
          }
        }
        // Diagnostics (only when something is hidden): confirm the hiding path
        // actually fires in the browser.
        console.info(
          `[dsh-rewind] hiding: ${hiddenCount} rows, seqs [${[...hiddenSeqs].slice(0, 20).join(', ')}${hiddenSeqs.size > 20 ? '…' : ''}]`,
        )
      }
      for (const seat of document.querySelectorAll<HTMLElement>(USER_SEAT_SELECTOR)) {
        if (!hidden.has(seat)) attach(seat)
      }
    }

    const filledTargets = new Set<number>()
    /**
     * When a rewind command settles successfully, put the withdrawn target
     * message's text back into the composer so the user can edit and re-send.
     */
    const fillComposerForRewind = (session: SessionFace, filled: Set<number>): void => {
      const snap = session.getSnapshot()
      for (const key of snap.chat.order) {
        const node = snap.chat.nodes.get(key)
        if (node === undefined || node.kind !== 'command') continue
        const command = node.data as CommandNode
        if (command.name !== 'rewind' || command.outcome?.kind !== 'success') continue
        const target = targetOfOutcome(command.outcome.text)
        if (target === undefined || filled.has(target)) continue
        const text = userTextAt(session, target)
        if (text === undefined || text === '') continue
        if (fillComposer(text)) filled.add(target)
      }
    }

    observer = new MutationObserver(scan)
    // childList only: style-attribute watching fired on every render/animation
    // (streaming tokens set element styles constantly), making the scan run
    // continuously and delaying message bubbles. Re-hiding on React re-render
    // still happens because the scan re-runs on childList mutations.
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
