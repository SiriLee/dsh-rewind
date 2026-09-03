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
import { createRewindBridge, runRewindAndFill, writeComposer, type SlotsLike } from './portals.tsx'
import { chatSnapshotOf, resolveChatWatch, isCandidateCommand, type ChatOf, type ChatWatch } from './hidden.ts'
import { rewindLog } from './log.ts'
import { BUILD_HASH, PLUGIN_VERSION } from './build-info.ts'
import { en, zh } from './locales.ts'
import { STYLE } from './styles.ts'
import {
  SettingsCleanupCard,
  CLEANUP_SETTINGS_NAMESPACE,
  type CleanupCardApi,
  type CleanupPolicy,
  type CardTranslate,
} from './settings-card.tsx'

export const name = 'dsh-rewind'
// NOTE: deliberately NOT injecting the 0.1.2-rc.1 `uiConversation` service
// here. Cordis inject entries are REQUIRED services; the name does not exist on
// harness 0.1.1-rc.2, so declaring it would stall this plugin forever on DSH
// Desktop 2.0.3. The service is resolved lazily per read instead (see
// `uiConversation` in apply), the same optional `ctx.get` pattern the
// harness's own consumer plugins use on 0.1.2.
//
// `settingsScope` is likewise NOT a module-level inject. Following the
// dsh-market template (see src/client/index.ts below), the settings surface is
// reached through a NESTED `ctx.inject(['settingsScope'], ...)`: naming it at
// the module level would keep this whole plugin unmounted on a host without
// that service, costing the rewind feature a settings card that a 0.1.1-rc.2
// host cannot render. Nested, the card simply never appears there.
export const inject = ['slots', 'sessions', 'locale', 'commandUi']

const NS = 'rewind'

/**
 * Structural face of the 0.1.2-rc.1 `uiConversation` service: per-session
 * conversation bindings exposing named view targets (the "chat" view carries
 * the chat snapshot). This is the 0.1.2-rc.1 channel of the `chatSnapshotOf`
 * dual reader (the 0.1.1-rc.2 channel is the session-face `chat` field).
 * Typed locally so the plugin never imports the conversation UI package's types
 * and survives harness version drift.
 */
interface UiConversationLike {
  binding(source: string | { readonly sessionId: string }): {
    target(name: string): { getSnapshot(): unknown; subscribe?(cb: () => void): () => void } | undefined
  }
}

/**
 * Structural face of the 0.1.2-rc.1 `conversation.input` session-input resolver
 * (`SessionInputResolver`): resolves a per-session input shell whose
 * `setDraft` replaces the whole composer draft through the harness's Lexical
 * editor. This is the 0.1.2-rc.1 channel of the composer-write dual path (the
 * 0.1.1-rc.2 channel is the `<textarea>` DOM fill). Typed locally so the
 * plugin never imports the conversation UI package and survives harness
 * version drift. Absent on 0.1.1-rc.2.
 */
interface SessionInputResolverLike {
  for(actx: unknown): { setDraft(text: string): void }
}

/**
 * Structural face of the settings-namespace scope the snapshot-cleanup card
 * binds (the `settingsScope.bind({namespace})` result). Only the subset the
 * card uses — a resolved-value snapshot, a per-field write, and a change
 * subscription — typed locally so the plugin never imports the client settings
 * typed contract (which drifts 0.1.1-rc.2 ↔ 0.1.2-rc.1: 0.1.2 adds `mutate`,
 * not used here).
 */
interface CleanupSettingsScopeLike {
  getSnapshot(): {
    /** The resolved namespace value (schema-valid) or undefined while loading. */
    value?: { enabled: boolean; maxAgeDays: number }
    status: 'loading' | 'ready' | 'unavailable' | string
    /** Whether the Host document accepts writes (the harness's own writable signal). */
    writable: boolean
  }
  /** Write one field's user-layer value (present on 0.1.1-rc.2 and 0.1.2-rc.1). */
  set(field: string, value: unknown): Promise<void>
  /** Observe snapshot replacements; returns the disposer. */
  subscribe(cb: () => void): () => void
}

/** The slot the session-scoped rewind bridge registers into (harness-declared). */
const HEADER_ACTIONS_SLOT = 'conversation.session.header.actions'

/**
 * The composer's text surface, whichever harness version is running: 0.1.1-rc.2
 * is a `<textarea>`, 0.1.2-rc.1 is a Lexical `contenteditable` div. The
 * `/rewind` text-flow anchor must point at whichever exists, so the popup
 * positions correctly on both channels.
 */
const COMPOSER_TEXTAREA_SELECTOR = '[data-input-scroll] textarea, textarea[data-phase]'
const COMPOSER_EDITABLE_SELECTOR = '[data-composer-input]'

/**
 * Client plugin body: command decoration + parameterized guard + locale + the
 * portal bridge.
 * @param ctx - client root context carrying `slots`, `sessions`, `locale` and `commandUi`.
 */
export function apply(ctx: ClientContext): void {
  // Startup identity line (behind the existing `dsh-rewind.debug` switch, never
  // a new key): lets a reporter confirm the running bundle matches a fix,
  // ruling out stale cache / an un-restarted host — the cheapest, most likely
  // root cause. One line per load, not per event.
  rewindLog.info('boot', `loaded v${PLUGIN_VERSION} (build ${BUILD_HASH})`)

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
     * The 0.1.2-rc.1 chat channel: the `uiConversation` service (contributed by
     * dsh-client-ui-conversation; dsh-client-ui-chat registers its named
     * "chat" view through the uiSession slot hook). Resolved lazily through
     * `ctx.get` — the harness's own consumer pattern — so the read returns
     * undefined on 0.1.1-rc.2, where the service does not exist (see the
     * `inject` note above for why it is not a declared dependency). Re-read on
     * every call: services restart under the live-reload profile patcher.
     */
    const uiConversation = (): UiConversationLike | undefined =>
      (ctx as { get(name: string): unknown }).get('uiConversation') as UiConversationLike | undefined

    /** The named chat view in the 0.1.2-rc.1 uiConversation registry. */
    const CHAT_VIEW = 'chat'
    /**
     * The live chat snapshot of a session, or undefined when unavailable.
     * Dual channel (see `chatSnapshotOf`): the 0.1.1-rc.2 session-face snapshot
     * first, then the 0.1.2-rc.1 `uiConversation` "chat" view.
     * `uiConversation.binding` throws for a session it does not know (a
     * teardown window) — degrade to "no chat" instead of failing the caller.
     */
    const chatOf: ChatOf = (session) => {
      if (session === undefined) return undefined
      try {
        const view = uiConversation()?.binding(session.sessionId).target(CHAT_VIEW)
        return chatSnapshotOf(session, view)
      } catch {
        return undefined
      }
    }

    /**
     * The 0.1.2-rc.1 composer channel: the `conversation` service's `input`
     * resolver (`SessionInputResolver`) through which `setDraft` replaces the
     * whole composer draft (the harness's own Lexical editor — the correct
     * semantics, not a DOM hack). Resolved lazily through `ctx.get` so the
     * read is undefined on 0.1.1-rc.2, where the service does not exist;
     * `sessions.scope` is likewise absent on 0.1.1-rc.2. Wrapped in the
     * `writeComposer` dual channel: the 0.1.2-rc.1 facade when reachable, else
     * the 0.1.1-rc.2 textarea / 0.1.2-rc.1 contenteditable DOM fill. Never
     * throws.
     */
    const setComposerText = (sessionId: string, text: string): boolean => {
      try {
        const conversation = (ctx as { get(name: string): unknown }).get('conversation') as { input?: SessionInputResolverLike } | undefined
        const input = conversation?.input
        const scope = (ctx.sessions as { scope?: (id: SessionId) => unknown }).scope?.(sessionId as SessionId)
        const facade = input !== undefined && scope !== undefined
        const ok = writeComposer(
          text,
          facade
            ? { setDraft: (draft: string) => { input.for(scope).setDraft(draft) } }
            : undefined,
        )
        return ok
      } catch (error) {
        rewindLog.warn('refill', 'composer write threw', error)
        return false
      }
    }

    /**
     * Subscribe to one session's live chat-update signal (the wait signal for
     * `waitForCommand`). Channel selection mirrors the chat's residence (see
     * `resolveChatWatch`): on 0.1.2-rc.1 prefer the `uiConversation` "chat"
     * view's `subscribe`; when that view is unreachable (0.1.1-rc.2, or before
     * it registers) fall back to the session face's own `subscribe`. Never
     * throws.
     */
    const watchChat: ChatWatch = (sessionId, cb) => resolveChatWatch(
      id => {
        try {
          return uiConversation()?.binding(id).target(CHAT_VIEW)
        } catch {
          return undefined
        }
      },
      id => sessionOf(id),
      sessionId,
      cb,
    )

    const slots = ctx.slots as unknown as SlotsLike
    yield slots.inject(HEADER_ACTIONS_SLOT, () => slots.register(
      {
        name: HEADER_ACTIONS_SLOT,
        // A distinct list-entry id keeps the bridge from shadowing any other
        // header action; the entry renders portals only, never header UI.
        id: 'dsh-rewind-portals',
        order: 1000,
      },
      createRewindBridge({ sessionOf, chatOf, currentSessionId, watchChat, setComposerText, t, subscribeLocale }),
    ))

    // ---- snapshot-cleanup settings card (Settings > Plugins > Plugin config) ----
    // Reach the settings surface through a NESTED inject (the dsh-market
    // template, proven on 0.1.1-rc.2 ↔ 0.1.2-rc.1): do NOT name settingsScope in the
    // module-level inject, or a host without it leaves this whole plugin
    // unmounted (costing the rewind feature a card it cannot render). Nested,
    // the card simply never registers there. The nested scope inherits the
    // module 'slots' and 'locale', and gains 'settingsScope'; only then is the
    // namespace bound and the card registered under `settings.plugin.item`
    // keyed by the SAME namespace the Host half serves. The card reads/writes
    // through a structural scope face (the 0.1.2-rc.1-only `mutate`
    // deliberately unused).
    const clientCtx = ctx as unknown as {
      inject(services: string[], callback: (scoped: {
        slots: SlotsLike
        settingsScope: { bind(spec: { namespace: string }): CleanupSettingsScopeLike }
      }) => void): void
    }
    clientCtx.inject(['settingsScope'], (scoped) => {
      try {
        const scope = scoped.settingsScope.bind({ namespace: CLEANUP_SETTINGS_NAMESPACE }) as unknown as CleanupSettingsScopeLike
        const cardApi: CleanupCardApi = {
          read: () => {
            const value = scope.getSnapshot().value
            return value === undefined
              ? undefined
              : { enabled: value.enabled, maxAgeDays: value.maxAgeDays }
          },
          writable: () => {
            // The harness's own writable signal (a read-only settings source
            // reports false); the earlier status/mode derivation was wrong and
            // left the buttons disabled.
            return scope.getSnapshot().writable === true
          },
          save: async (next: CleanupPolicy) => {
            await scope.set('enabled', next.enabled)
            await scope.set('maxAgeDays', next.maxAgeDays)
          },
          subscribe: (cb) => scope.subscribe(cb),
        }
        scoped.slots.inject('settings.plugin.item', () => scoped.slots.register(
          {
            name: 'settings.plugin.item',
            key: CLEANUP_SETTINGS_NAMESPACE,
            // Match the official cards / dsh-market: locale + inject provide
            // the card its props through the slot renderer (the keyed card owns
            // its internals, but the page feeds it locale + the bound api).
            locale: NS,
            inject: () => ({ t: t as unknown as CardTranslate, api: cardApi }),
          },
          SettingsCleanupCard,
        ))
      } catch (error) {
        // A settings-card failure must never break the plugin: the rewind
        // feature is independent of the settings surface.
        rewindLog.error('settings', 'settings card register failed', error)
      }
    })

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
      const face = sessionId === undefined ? undefined : sessionOf(sessionId)
      const chat = chatOf(face)
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
      const outcome = await waitForCommand(face, chatOf, node => isCandidateCommand(node) && !known.has(node.seq), 8000, cb => watchChat(face.sessionId, cb))
      if (outcome === null || outcome.kind !== 'success' || outcome.text === undefined) return undefined
      return rewindCandidatesFromHostText(outcome.text)
    }

    // Cache the last-fetched candidate list per session: `options` fills it,
    // `onSelect` reads it to resolve the picked seq's time/preview without a
    // second host round-trip.
    const hostCandidatesCache = new Map<string, readonly RewindCandidate[]>()

    /** The composer card the mode popover anchors to (the text flow has no button). */
    const composerAnchor = (): HTMLElement => {
      const surface = composerSurface()
      const card = surface?.closest<HTMLElement>('[data-composer-card]')
      return card ?? surface ?? document.body
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
            watchChat,
            seq: candidate.seq,
            time: candidate.time,
            preview: candidate.preview,
            anchor: composerAnchor(),
            t,
            onRewind: mode => { void runRewindAndFill(face, candidate.seq, mode, currentSessionId, chatOf, watchChat, setComposerText) },
          })
        },
      },
    }
    for (const name of ['rewind', 'undo'] as const) {
      yield commandUi.decorate({ name, ...rewindPopupSpec })
    }

    /** The composer's text-holding element: 0.1.1-rc.2 `<textarea>` or 0.1.2-rc.1 contenteditable. */
    const composerSurface = (): HTMLElement | null =>
      document.querySelector<HTMLTextAreaElement>(COMPOSER_TEXTAREA_SELECTOR)
        ?? document.querySelector<HTMLElement>(COMPOSER_EDITABLE_SELECTOR)

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
