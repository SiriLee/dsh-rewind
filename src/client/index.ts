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
 * Manual composer input of `/rewind` opens the rewind menu (the guard below):
 * a bare `/rewind` line is intercepted — NOT submitted as a command — and the
 * candidate menu appears above the composer, so the text-driven flow is the
 * same interactive picker as Claude Code's. The parameterized forms
 * (`/rewind @<seq> chat|both`, `/rewind preview …`) stay internal channels the
 * ↶ button and the menu drive through `session.command`; a hand-typed
 * parameterized line is stopped with a hint.
 *
 * @module dsh-rewind/client
 */

import type { ClientContext, SessionFace } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
// Type-only: pulls the ctx.locale merge from the locale plugin.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { closeRewindMenu, openRewindMenu, type MenuCandidate } from './menu.ts'
import { openPopover } from './popover.ts'
import { createRewindBridge, fillComposer, runRewindAndFill, type SlotsLike } from './portals.tsx'
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
    // Manual composer input of `/rewind` opens the rewind menu instead of
    // submitting: a bare `/rewind` line is consumed (input cleared) and the
    // candidate menu appears above the composer — Claude Code's rewind menu,
    // entered from the command line. The parameterized forms are internal
    // channels (the ↶ button and the menu drive them through
    // `session.command`), so a hand-typed `/rewind <args>` line is stopped
    // with a hint.
    const BARE_REWIND = /^\s*\/rewind\s*$/i
    const PARAM_REWIND = /^\s*\/rewind\s+\S+/i

    const composerTextarea = (): HTMLTextAreaElement | null =>
      document.querySelector<HTMLTextAreaElement>(COMPOSER_SELECTOR)

    /** True when the composer draft is a manually typed /rewind line. */
    const hasManualRewindDraft = (): boolean => {
      const textarea = composerTextarea()
      if (textarea === null) return false
      return BARE_REWIND.test(textarea.value) || PARAM_REWIND.test(textarea.value)
    }

    /**
     * One rewind entry point: pick a target in the menu, then continue the
     * SAME flow as the per-message ↶ button — mode popover, both-impact
     * confirmation, execution and the composer refill (`runRewindAndFill`).
     */
    const onPickCandidate = (candidate: MenuCandidate, anchor: HTMLElement): void => {
      const sessionId = currentSessionId()
      const session = sessionId !== undefined ? sessionOf(sessionId) : undefined
      if (session === undefined) return
      openPopover({
        session,
        seq: candidate.seq,
        time: candidate.time,
        preview: candidate.preview,
        anchor,
        t,
        onRewind: mode => { void runRewindAndFill(session, candidate.seq, mode, currentSessionId) },
      })
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

    /**
     * Route a manual /rewind submit: bare → open the menu (the typed command
     * is consumed, mirroring Claude Code clearing the input); parameterized →
     * hint.
     */
    const onManualRewindSubmit = (event: KeyboardEvent | MouseEvent): void => {
      const draft = composerTextarea()?.value ?? ''
      if (!BARE_REWIND.test(draft) && !PARAM_REWIND.test(draft)) return
      event.preventDefault()
      event.stopPropagation()
      if (PARAM_REWIND.test(draft)) {
        showGuardHint()
        return
      }
      // Consume the typed command, then open the candidate menu.
      fillComposer('')
      openRewindMenu({ sessionOf, currentSessionId, t, onPick: onPickCandidate })
    }

    // Capture phase on document: fires before React's root handlers, so
    // preventDefault + stopPropagation here stops the submit path entirely.
    const onKeyDownGuard = (event: KeyboardEvent): void => {
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
      if (!hasManualRewindDraft()) return
      onManualRewindSubmit(event)
    }

    const onClickGuard = (event: MouseEvent): void => {
      if (event.button !== 0 || !hasManualRewindDraft()) return
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
      onManualRewindSubmit(event)
    }

    document.addEventListener('keydown', onKeyDownGuard, true)
    document.addEventListener('click', onClickGuard, true)

    yield () => {
      document.removeEventListener('keydown', onKeyDownGuard, true)
      document.removeEventListener('click', onClickGuard, true)
      if (guardHintEl !== null) guardHintEl.remove()
      if (guardHintTimer !== undefined) window.clearTimeout(guardHintTimer)
      closeRewindMenu()
      style.remove()
    }
  }, 'dsh-rewind client lifecycle')
}
