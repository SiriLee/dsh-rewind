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

import type { ISessions, SessionFace } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { CommandDecoration, CommandUiContract, SelectOption } from '@deepseek-ai/dsh-client-ui-commands/client'
import type { ClientSessionContext } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
// Type-only: the per-entry configuration form (`ctx.configForms`) the cleanup
// card stages over; the form model itself is the harness's own.
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the ctx.locale merge from the locale plugin.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the `mainView` Session retain-source label merge (0.1.6-alpha.2
// removed `SessionListState.current`, so main-view ownership is read from the
// label the ui-session plugin contributes to `SessionReferenceSourceMap`).
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import {
  rewindCandidatesFromHostText,
  rewindCandidatesOfChat,
  rewindOptionsFromCandidates,
  type CandidateChat,
  type RewindCandidate,
} from './candidates.ts'
import { closePopover, openPopover, knownCommandSeqs, waitForCommand } from './popover.ts'
import { createRewindBridge, isRewindInertSession, runRewindAndFill, writeComposer, type SlotsLike } from './portals.tsx'
import { chatSnapshotOf, resolveChatWatch, isCandidateCommand, type ChatOf, type ChatWatch } from './hidden.ts'
import { rewindLog } from './log.ts'
import { BUILD_HASH, PLUGIN_PACKAGE, PLUGIN_VERSION } from './build-info.ts'
import { en, zh } from './locales.ts'
import { STYLE } from './styles.ts'
import {
  SettingsCleanupCard,
  cleanupForm,
  CLEANUP_ENTRY_ID,
  type CleanupFormScope,
  type CleanupPolicy,
} from './settings-card.tsx'

export const name = 'dsh-rewind'
// NOTE: deliberately NOT injecting the `uiConversation` service
// here as a required dependency. The service is resolved lazily per read
// instead (see `uiConversation` in apply), the optional `ctx.get` pattern the
// harness's own consumer plugins use.
//
// `configForms` IS a module-level inject: the rewind surface itself never needs
// it, but the configuration card is addressed through it, and the web profile
// always composes `ui-settings` (the same dependency the official settings
// pages declare).
export const inject = ['slots', 'sessions', 'locale', 'commandUi', 'configForms']

const NS = 'rewind'

/**
 * Structural face of the `uiConversation` service: per-session
 * conversation bindings exposing named view targets (the "chat" view carries
 * the chat snapshot). Typed locally so the plugin never imports the
 * conversation UI package's types and survives harness version drift.
 */
interface UiConversationLike {
  binding(source: string | { readonly sessionId: string }): {
    target(name: string): { getSnapshot(): unknown; subscribe?(cb: () => void): () => void } | undefined
  }
}

/**
 * Structural face of the `conversation.input` session-input resolver
 * (`SessionInputResolver`): resolves a per-session input shell whose
 * `setDraft` replaces the whole composer draft through the harness's Lexical
 * editor. Typed locally so the plugin never imports the conversation UI
 * package and survives harness version drift.
 */
interface SessionInputResolverLike {
  for(actx: unknown): { setDraft(text: string): void }
}

/**
 * The slot the session-scoped rewind bridge registers into (harness-declared).
 */
const HEADER_ACTIONS_SLOT = 'conversation.session.header.actions'

/**
 * The composer's text surface: the Lexical `contenteditable` div
 * `[data-composer-input]`. The `/rewind` text-flow anchor points at it.
 */
const COMPOSER_EDITABLE_SELECTOR = '[data-composer-input]'

/**
 * The client plugin root context read by `apply(ctx)`. Local structural face:
 * the harness client context is a cordis `Context` augmented by runtime
 * services, so the plugin declares the subset it reads. `sessions` is the real
 * `ISessions` from `@deepseek-ai/dsh-api-session-controller`.
 */
export interface ClientContext {
  effect(execute: (() => Iterable<unknown>) | (() => void), label?: string): unknown
  locale: {
    register(namespace: string, messages: Record<string, Record<string, string>>): unknown
    bind(namespace: string): (key: string) => string
    subscribe(cb: () => void): () => void
  }
  sessions: ISessions
  get(name: string): unknown
  slots: unknown
  commandUi: unknown
  /** Per-entry configuration forms (this bundle's own entry included). */
  configForms: { get<T>(entryId: string): ConfigForm<T> }
}

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
    // The loader row id (the harness matches its owned-style fallback by
    // `data-plugin === entryId`, and the entry id is the package name).
    style.dataset.plugin = PLUGIN_PACKAGE
    style.textContent = STYLE
    document.head.appendChild(style)

    // ---- rewind portals: session-scoped React mount ----
    // Capabilities handed to the portal bridge. `sessionOf` resolves a
    // session id to its live face; `isMainViewSession` is the session switch
    // check the composer refill needs (fill only the session the rewind
    // actually happened in).
    const sessionOf = (sessionId: string): SessionFace | undefined =>
      ctx.sessions.binding(sessionId as SessionId)?.session
    /**
     * Whether a session is the one the MAIN VIEW retains — what
     * `SessionListState.current` used to say before 0.1.6-alpha.2 deleted it; it
     * is the `mainView` count `ui-session` itself checks. A predicate rather
     * than "the current session id", so two windows cannot pick the wrong one.
     */
    const isMainViewSession = (sessionId: string): boolean =>
      (ctx.sessions.list.getSnapshot().byId[sessionId as SessionId]?.retainedBy.mainView ?? 0) > 0
    const subscribeLocale = (cb: () => void): (() => void) => ctx.locale.subscribe(cb)

    /**
     * The chat channel: the `uiConversation` service (contributed by
     * dsh-client-ui-conversation; dsh-client-ui-chat registers its named
     * "chat" view through the uiSession slot hook). Resolved lazily through
     * `ctx.get` — the harness's own consumer pattern — so the read is undefined
     * before the service registers. Re-read on every call: services restart
     * under the live-reload profile patcher.
     */
    const uiConversation = (): UiConversationLike | undefined =>
      (ctx as { get(name: string): unknown }).get('uiConversation') as UiConversationLike | undefined

    /** The named chat view in the `uiConversation` registry. */
    const CHAT_VIEW = 'chat'
    /**
     * The live chat snapshot of a session, or undefined when unavailable. Served
     * by the `uiConversation` "chat" view (see `chatSnapshotOf`).
     * `uiConversation.binding` throws for a session it does not know (a
     * teardown window) — degrade to "no chat" instead of failing the caller.
     */
    const chatOf: ChatOf = (session) => {
      if (session === undefined) return undefined
      try {
        const view = uiConversation()?.binding(session.sessionId).target(CHAT_VIEW)
        return chatSnapshotOf(view)
      } catch {
        return undefined
      }
    }

    /**
     * The composer writer: the `conversation` service's `input`
     * resolver (`SessionInputResolver`) through which `setDraft` replaces the
     * whole composer draft (the harness's own Lexical editor — the correct
     * semantics, not a DOM hack). Resolved lazily through `ctx.get`; `scope` is
     * reached via `sessions.scope`. Wrapped in `writeComposer` (the facade when
     * reachable, else the contenteditable DOM fill). Never throws.
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
     * `waitForCommand`): the `uiConversation` "chat" view's
     * `subscribe` (see `resolveChatWatch`). Never throws.
     */
    const watchChat: ChatWatch = (sessionId, cb) => resolveChatWatch(
      id => {
        try {
          return uiConversation()?.binding(id).target(CHAT_VIEW)
        } catch {
          return undefined
        }
      },
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
      createRewindBridge({ sessionOf, chatOf, isMainViewSession, watchChat, setComposerText, t, subscribeLocale }),
    ))

    // ---- snapshot-cleanup configuration form (sidebar Plugins page) ----
    // The card is this bundle's own configuration page: it registers under
    // `plugins.bundle.config`, keyed by the BUNDLE's package name, and stages
    // its edits over the entry's shared configuration form (`ctx.configForms`),
    // exactly like the official settings pages.
    try {
      const { store, form } = cleanupForm(
        ctx.configForms.get<CleanupPolicy>(CLEANUP_ENTRY_ID) as unknown as CleanupFormScope<CleanupPolicy>,
      )
      // The model subscribes to the entry's form on construction, so the fiber
      // must release it on unload (the official settings pages do the same).
      ctx.effect(() => () => { form.dispose() }, 'dsh-rewind cleanup form')
      yield slots.inject('plugins.bundle.config', () => slots.register(
        {
          name: 'plugins.bundle.config',
          key: PLUGIN_PACKAGE,
          locale: NS,
          inject: () => ({ hooks: { cleanupCard: store }, ...form.actions() }),
        },
        SettingsCleanupCard,
      ))
    } catch (error) {
      // A settings-card failure must never break the plugin: the rewind
      // feature is independent of the settings surface.
      rewindLog.error('settings', 'settings card register failed', error)
    }

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
      // A direct-subagent (child) session is rewind-inert (see
      // `isRewindInertSession`): the Host refuses every generic Session RPC for
      // a subagent-owned identity, so this picker could only list targets that
      // can never execute. The Harness's own slash-command directory already
      // returns nothing there; this keeps the decoration from becoming a second
      // dead surface should that policy change.
      if (face === undefined || isRewindInertSession(face.getSnapshot())) return false
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
            onRewind: mode => { void runRewindAndFill(face, candidate.seq, mode, isMainViewSession, chatOf, watchChat, setComposerText) },
          })
        },
      },
    }
    for (const name of ['rewind', 'undo'] as const) {
      yield commandUi.decorate({ name, ...rewindPopupSpec })
    }

    /** The composer's text-holding element: the `contenteditable` div. */
    const composerSurface = (): HTMLElement | null =>
      document.querySelector<HTMLElement>(COMPOSER_EDITABLE_SELECTOR)

    yield () => {
      // A live disable can land while the mode popover is open. The popover is
      // plain DOM plus document capture-phase key listeners, so it must be
      // closed with this fiber: otherwise the node and the key steal (↑/↓/Esc
      // routed away from the composer) outlive the unload, and a later remount
      // would overwrite the singleton reference and leak both for good.
      closePopover()
      style.remove()
    }
  }, 'dsh-rewind client lifecycle')
}

/**
 * Public contract — rewind visibility. Stable, semver-protected; the rest of
 * this module is internal. See `docs/contract/client-contract.md`.
 */
export { hiddenSeqsOf, targetSeqOfArgs, type HiddenChat } from './hidden.ts'
