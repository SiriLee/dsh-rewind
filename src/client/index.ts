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
 * Manual composer input of `/rewind` is deliberately restricted (the guard
 * below): it takes no parameters — a bare `/rewind` withdraws the most recent
 * message, and any `/rewind <args>` line is blocked with a hint pointing at
 * the per-message button.
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

    const scan = (): void => {
      // Drop buttons whose seat rows were removed from the DOM (React unmount).
      for (const [key, button] of buttons) {
        if (!button.isConnected) buttons.delete(key)
      }
      const session = sessionFor()
      const hiddenSeqs = session !== undefined ? hiddenSeqsOf(session) : new Set<number>()
      let hiddenCount = 0
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
          hiddenCount += 1
        } else if (hidden.has(seat)) {
          seat.style.display = ''
          hidden.delete(seat)
        }
      }
      // Fill the composer with the withdrawn target's text, once per target.
      if (session !== undefined) fillComposerForRewind(session, filledTargets)
      // Diagnostics (only when something is hidden): confirm the hiding path
      // actually fires in the browser.
      if (hiddenSeqs.size > 0 || hiddenCount > 0) {
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

    // ---- manual /rewind guard ----
    // Manual composer input of `/rewind` accepts NO parameters: a bare
    // `/rewind` line withdraws the most recent message (host behavior). Any
    // `/rewind <args>` line is blocked here with a hint, because parameterized
    // rewinds belong to the per-message ↶ button flow — which drives this same
    // host command with an explicit `@seq` target internally.
    const REWIND_WITH_ARGS = /^\s*\/rewind\s+\S/i

    const composerTextarea = (): HTMLTextAreaElement | null =>
      document.querySelector<HTMLTextAreaElement>(COMPOSER_SELECTOR)

    /** True when the composer draft is a parameterized /rewind line. */
    const hasBlockedRewindDraft = (): boolean => {
      const textarea = composerTextarea()
      return textarea !== null && REWIND_WITH_ARGS.test(textarea.value)
    }

    let guardHintEl: HTMLElement | null = null
    let guardHintTimer: number | undefined

    /** Transient hint above the composer: manual /rewind takes no parameters. */
    const showGuardHint = (): void => {
      if (guardHintEl !== null) guardHintEl.remove()
      if (guardHintTimer !== undefined) window.clearTimeout(guardHintTimer)
      const textarea = composerTextarea()
      if (textarea === null) return
      const card = textarea.closest('[data-composer-card]')
      const hint = document.createElement('div')
      hint.className = CLASS.guardHint
      hint.setAttribute('role', 'status')
      hint.textContent = t('guard.hint')
      document.body.appendChild(hint)
      const rect = card instanceof HTMLElement ? card.getBoundingClientRect() : textarea.getBoundingClientRect()
      // Bottom-anchored above the card: the hint grows upward, never covering
      // the input.
      hint.style.left = `${Math.round(rect.left)}px`
      hint.style.bottom = `${Math.round(window.innerHeight - rect.top + 8)}px`
      guardHintEl = hint
      guardHintTimer = window.setTimeout(() => {
        hint.remove()
        if (guardHintEl === hint) guardHintEl = null
        guardHintTimer = undefined
      }, 3200)
    }

    // Capture phase on document: fires before React's root handlers, so
    // preventDefault + stopPropagation here stops the submit path entirely.
    const onKeyDownGuard = (event: KeyboardEvent): void => {
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
      if (!hasBlockedRewindDraft()) return
      event.preventDefault()
      event.stopPropagation()
      showGuardHint()
    }

    const onClickGuard = (event: MouseEvent): void => {
      if (event.button !== 0 || !hasBlockedRewindDraft()) return
      const target = event.target
      if (!(target instanceof Element)) return
      const button = target.closest('button')
      if (button === null) return
      const card = button.closest('[data-composer-card]')
      if (card === null) return
      // Only the composer's primary submit button is guarded. The stop button
      // (renders a <rect>) must keep working with a /rewind draft present.
      const all = card.querySelectorAll<HTMLButtonElement>('button')
      if (all[all.length - 1] !== button) return
      if (button.querySelector('rect') !== null) return
      event.preventDefault()
      event.stopPropagation()
      showGuardHint()
    }

    document.addEventListener('keydown', onKeyDownGuard, true)
    document.addEventListener('click', onClickGuard, true)

    observer = new MutationObserver(scan)
    // attributes: watch style so a React re-render that resets display is
    // re-hidden on the next mutation instead of flickering back.
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] })
    scan()

    yield () => {
      document.removeEventListener('keydown', onKeyDownGuard, true)
      document.removeEventListener('click', onClickGuard, true)
      if (guardHintEl !== null) guardHintEl.remove()
      if (guardHintTimer !== undefined) window.clearTimeout(guardHintTimer)
      observer?.disconnect()
      for (const button of buttons.values()) button.remove()
      buttons.clear()
      closePopover()
      style.remove()
    }
  }, 'dsh-rewind client lifecycle')
}
