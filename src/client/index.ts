/**
 * dsh-rewind client half: the `/rewind` command decoration, the locale
 * registration, and the session-scoped portal bridge that renders the
 * per-message ↶ rewind button (see
 * `portals.tsx` for the button itself).
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
 * The text-driven flow is the harness's STANDARD command decoration
 * (`ctx.commandUi.decorate`): a bare `/rewind` (or its alias `/undo`) —
 * picked from the slash-menu completion, or typed in full and Entered —
 * opens the harness's own popupSelect shell (search, ↑↓/Enter, Esc) listing
 * the rewind candidates instead of executing the command. Picking one
 * continues the SAME flow as the ↶ button: the mode popover, both-impact
 * confirmation, execution, row hiding and the composer refill
 * (`runRewindAndFill`). The parameterized forms (`/rewind @<seq> chat|both`,
 * `/rewind preview …`) stay internal channels the ↶ button and the popover
 * drive through `session.command`.
 *
 * @module dsh-rewind/client
 */

import type { ClientContext, SessionFace } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type { CommandDecoration, CommandUiContract, SelectOption } from '@deepseek-ai/dsh-client-ui-commands/client'
import type { ClientSessionContext } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
// Type-only: pulls the ctx.locale merge from the locale plugin.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import {
  rewindCandidatesFromHostText,
  rewindCandidatesOfChat,
  rewindOptionsFromCandidates,
  type CandidateChat,
  type RewindCandidate,
} from './candidates.ts'
import { openPopover, knownCommandSeqs, waitForCommand } from './popover.ts'
import { createRewindBridge, runRewindAndFill, type SlotsLike } from './portals.tsx'
import { chatSnapshotOf, isCandidateCommand, type ChatOf } from './hidden.ts'
import { en, zh } from './locales.ts'
import { STYLE } from './styles.ts'

export const name = 'dsh-rewind'
// NOTE: deliberately NOT injecting the alpha.1+ `uiConversation` service here.
// Cordis inject entries are REQUIRED services; the name does not exist on
// harness rc.2, so declaring it would stall this plugin forever on DSH
// Desktop 2.0.3. The service is resolved lazily per read instead (see
// `uiConversation` in apply), the same optional `ctx.get` pattern the
// harness's own consumer plugins use on alpha.1+.
export const inject = ['slots', 'sessions', 'locale', 'commandUi']

const NS = 'rewind'

/**
 * Structural face of the alpha.1+ `uiConversation` service: per-session
 * conversation bindings exposing named view targets (the "chat" view carries
 * the chat snapshot). Typed locally so the plugin never imports the
 * conversation UI package's types and survives harness version drift.
 */
interface UiConversationLike {
  binding(source: string | { readonly sessionId: string }): {
    target(name: string): { getSnapshot(): unknown } | undefined
  }
}

/** The slot the session-scoped rewind bridge registers into (harness-declared). */
const HEADER_ACTIONS_SLOT = 'conversation.session.header.actions'

/** The composer textarea dsh renders for the current session's input. */
const COMPOSER_SELECTOR = '[data-input-scroll] textarea, textarea[data-phase]'

/**
 * Client plugin body: command decoration + parameterized guard + locale + the
 * portal bridge.
 * @param ctx - client root context carrying `slots`, `sessions`, `locale` and `commandUi`.
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

    /**
     * The alpha.1+ chat channel: the `uiConversation` service (contributed by
     * dsh-client-ui-conversation; dsh-client-ui-chat registers its named
     * "chat" view through the uiSession slot hook). Resolved lazily through
     * `ctx.get` — the harness's own consumer pattern — so the read returns
     * undefined on rc.2, where the service does not exist (see the `inject`
     * note above for why it is not a declared dependency). Re-read on every
     * call: services restart under the live-reload profile patcher.
     */
    const uiConversation = (): UiConversationLike | undefined =>
      (ctx as { get(name: string): unknown }).get('uiConversation') as UiConversationLike | undefined

    /** The named chat view in the alpha.1+ uiConversation registry. */
    const CHAT_VIEW = 'chat'
    /**
     * The live chat snapshot of a session, or undefined when unavailable.
     * Dual channel (see `chatSnapshotOf`): the rc.2 session-face snapshot
     * first, then the alpha.1+ `uiConversation` "chat" view.
     * `uiConversation.binding` throws for a session it does not know (a
     * teardown window) — degrade to "no chat" instead of failing the caller.
     */
    const chatOf: ChatOf = (sessionId) => {
      if (sessionId === undefined) return undefined
      try {
        const view = uiConversation()?.binding(sessionId).target(CHAT_VIEW)
        return chatSnapshotOf(sessionOf(sessionId), view)
      } catch {
        return undefined
      }
    }

    const slots = ctx.slots as unknown as SlotsLike
    yield slots.inject(HEADER_ACTIONS_SLOT, () => slots.register(
      {
        name: HEADER_ACTIONS_SLOT,
        // A distinct list-entry id keeps the bridge from shadowing any other
        // header action; the entry renders portals only, never header UI.
        id: 'dsh-rewind-portals',
        order: 1000,
      },
      createRewindBridge({ sessionOf, chatOf, currentSessionId, t, subscribeLocale }),
    ))

    // ---- /rewind command decoration (the standard text-driven flow) ----
    // A bare `/rewind` — picked from the slash-menu completion, or typed in
    // full and Entered — opens the harness's own popupSelect shell instead of
    // executing the command: the harness-native "bare invocation opens a
    // picker" mechanism (CommandDecoration, see the ui-commands contract).
    // The plugin never re-implements a menu; picking a candidate continues
    // the SAME flow as the ↶ button (the mode popover below).
    const commandUi = ctx.get('commandUi') as CommandUiContract


    /** True when the surface has at least one reachable rewind target. */
    const hasCandidates = (sessionId: string | undefined): boolean => {
      const chat = chatOf(sessionId)
      return chat !== undefined && rewindCandidatesOfChat(chat as unknown as CandidateChat).length > 0
    }

    /**
     * Fetch the FULL candidate list from the host through the internal
     * `__candidates` command. The host derives it from its complete surface +
     * event log, so it lists every reachable rewind target — not just the
     * already-loaded history window. Returns undefined when the command was
     * not matched or never settled.
     */
    const fetchHostCandidates = async (face: SessionFace, chatOf: ChatOf): Promise<readonly RewindCandidate[] | undefined> => {
      const known = knownCommandSeqs(face, chatOf, node => isCandidateCommand(node))
      const result = await face.command('/rewind __candidates')
      if (!result.ok || result.value?.matched !== true) return undefined
      const outcome = await waitForCommand(face, chatOf, node => isCandidateCommand(node) && !known.has(node.seq))
      if (outcome === null || outcome.kind !== 'success' || outcome.text === undefined) return undefined
      return rewindCandidatesFromHostText(outcome.text)
    }

    // Cache the last-fetched candidate list per session: `options` fills it,
    // `onSelect` reads it to resolve the picked seq's time/preview without a
    // second host round-trip.
    const hostCandidatesCache = new Map<string, readonly RewindCandidate[]>()

    /** The composer card the mode popover anchors to (the text flow has no button). */
    const composerAnchor = (): HTMLElement => {
      const textarea = composerTextarea()
      const card = textarea?.closest<HTMLElement>('[data-composer-card]')
      return card ?? textarea ?? document.body
    }

    // The decoration shared by `/rewind` and its alias `/undo`.
    const rewindPopupSpec: Omit<CommandDecoration, 'name'> = {
      // The picker exists exactly while the surface has a reachable user
      // message: a fresh session (no candidates) falls through to the host
      // command, which fails with "no user messages" — matching the harness's
      // own decoration convention (see ui-permission-presets).
      available: session => hasCandidates(session.sessionId),
      ui: {
        kind: 'popupSelect',
        options: async session => {
          const face = sessionOf(session.sessionId)
          if (face === undefined) return []
          const candidates = await fetchHostCandidates(face, chatOf)
          if (candidates !== undefined) hostCandidatesCache.set(session.sessionId, candidates)
          return candidates === undefined ? [] : rewindOptionsFromCandidates(candidates, t)
        },
        onSelect: (option, session) => {
          const face = sessionOf(session.sessionId)
          if (face === undefined) return
          const candidate = hostCandidatesCache.get(session.sessionId)?.find(
            candidate => candidate.seq === Number(option.id),
          )
          if (candidate === undefined) return
          openPopover({
            session: face,
            chatOf,
            seq: candidate.seq,
            time: candidate.time,
            preview: candidate.preview,
            anchor: composerAnchor(),
            t,
            onRewind: mode => { void runRewindAndFill(face, candidate.seq, mode, currentSessionId, chatOf) },
          })
        },
      },
    }
    for (const name of ['rewind', 'undo'] as const) {
      yield commandUi.decorate({ name, ...rewindPopupSpec })
    }

    const composerTextarea = (): HTMLTextAreaElement | null =>
      document.querySelector<HTMLTextAreaElement>(COMPOSER_SELECTOR)

    yield () => {
      style.remove()
    }
  }, 'dsh-rewind client lifecycle')
}

/**
 * Public contract — rewind visibility. Stable, semver-protected; the rest of
 * this module is internal. See `docs/contract/client-contract.md`.
 */
export { hiddenSeqsOf, targetSeqOfArgs, type HiddenChat } from './hidden.ts'