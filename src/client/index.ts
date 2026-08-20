/**
 * dsh-rewind client half: the manual `/rewind` composer guard, the locale
 * registration, and the session-scoped portal bridge that renders the
 * per-message ↶ rewind button (see `portals.tsx` for the button itself).
 *
 * The button is NOT injected by hand into the DOM anymore: the plugin
 * registers a bridge into the harness's `conversation.session.header.actions`
 * list slot, and that bridge portals a React button into every user message's
 * IconActions row — the same rendering family as the copy button (a React
 * child of the actions row), without touching any harness source. The
 * registration is typed structurally (see `SlotsLike` in portals.tsx), so the
 * plugin never imports conversation UI types and survives harness version
 * drift.
 *
 * Manual composer input of `/rewind` is deliberately blocked (the guard
 * below): the command exists only as the per-message ↶ button's internal
 * channel, so any `/rewind` line typed by hand — bare or with arguments — is
 * stopped with a hint pointing at the button.
 *
 * @module dsh-rewind/client
 */

import type { ClientContext, SessionFace } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
// Type-only: pulls the ctx.locale merge from the locale plugin.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { createRewindBridge, type SlotsLike } from './portals.tsx'
import { en, zh } from './locales.ts'
import { STYLE } from './styles.ts'

export const name = 'dsh-rewind'
export const inject = ['slots', 'sessions', 'locale']

const NS = 'rewind'

/** The slot the session-scoped rewind bridge registers into (harness-declared). */
const HEADER_ACTIONS_SLOT = 'conversation.session.header.actions'

/** The composer textarea dsh renders for the current session's input. */
const COMPOSER_SELECTOR = '[data-input-scroll] textarea, textarea[data-phase]'

/**
 * Client plugin body: composer guard + locale + the portal bridge.
 * @param ctx - client root context carrying `slots`, `sessions` and `locale`.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(function* () {
    yield ctx.locale.register(NS, { zh, en })
    const t = ctx.locale.bind(NS)

    const style = document.createElement('style')
    style.dataset.plugin = 'dsh-rewind'
    style.textContent = STYLE
    document.head.appendChild(style)

    // ---- rewind portals: session-scoped React mount ----
    // Capabilities handed to the portal bridge. `sessionOf` resolves a
    // session id to its live face; `currentSessionId` is the session switch
    // check the composer refill needs (fill only the session the rewind
    // actually happened in).
    const sessionOf = (sessionId: string): SessionFace | undefined =>
      ctx.sessions.binding(sessionId as SessionId)?.session
    const currentSessionId = (): string | undefined => ctx.sessions.list.getSnapshot().current
    const subscribeLocale = (cb: () => void): (() => void) => ctx.locale.subscribe(cb)

    const slots = ctx.slots as unknown as SlotsLike
    yield slots.inject(HEADER_ACTIONS_SLOT, () => slots.register(
      {
        name: HEADER_ACTIONS_SLOT,
        // A distinct list-entry id keeps the bridge from shadowing any other
        // header action; the entry renders portals only, never header UI.
        id: 'dsh-rewind-portals',
        order: 1000,
      },
      createRewindBridge({ sessionOf, currentSessionId, t, subscribeLocale }),
    ))

    // ---- manual /rewind guard ----
    // Manual composer input of `/rewind` is fully blocked: the command exists
    // only as the per-message ↶ button's internal channel (it drives the same
    // host command with an explicit `@seq` target). Any `/rewind` line typed
    // by hand — bare or with arguments — is stopped here with a hint pointing
    // at the button.
    const MANUAL_REWIND = /^\s*\/rewind(?:\s|$)/i

    const composerTextarea = (): HTMLTextAreaElement | null =>
      document.querySelector<HTMLTextAreaElement>(COMPOSER_SELECTOR)

    /** True when the composer draft is a manually typed /rewind line. */
    const hasBlockedRewindDraft = (): boolean => {
      const textarea = composerTextarea()
      return textarea !== null && MANUAL_REWIND.test(textarea.value)
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
      hint.className = 'dsh-rewind-guard-hint'
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

    yield () => {
      document.removeEventListener('keydown', onKeyDownGuard, true)
      document.removeEventListener('click', onClickGuard, true)
      if (guardHintEl !== null) guardHintEl.remove()
      if (guardHintTimer !== undefined) window.clearTimeout(guardHintTimer)
      style.remove()
    }
  }, 'dsh-rewind client lifecycle')
}
