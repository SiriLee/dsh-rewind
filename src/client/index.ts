/**
 * dsh-rewind client half: the `/rewind` and `/undo` client commands, the
 * command-face takeover service, the mode popover, the visibility layer and
 * the per-message rewind action.
 *
 * The action lives in the Chat row's official actions row (`mount.tsx`);
 * unclaimed steering uses `pending-mount.tsx`. The commands and the action
 * drive the v1 contract (preview → commit); `rewind-flow.ts` executes the
 * rewind and the composer refill.
 *
 * @module dsh-rewind/client
 */

import type { ISessions, SessionFace } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { CommandContribution, CommandUiContract, PopupSelectSpec } from '@deepseek-ai/dsh-client-ui-commands/client'
// Type-only: the React element the slot component returns (the settings card).
import type { ReactNode } from 'react'
// Type-only: the per-entry configuration form (`ctx.configForms`) the settings
// card stages over; the form model itself is the harness's own.
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the ctx.locale merge from the locale plugin.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the `mainView` Session retain-source label merge (0.1.6-alpha.2
// removed `SessionListState.current`, so main-view ownership is read from the
// label the ui-session plugin contributes to `SessionReferenceSourceMap`).
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import {
  rewindOptionsFromCandidates,
  type RewindCandidate,
} from './candidates.ts'
import { closePopover, openPopover, registerPreviewCall, registerComposerFocuser } from './popover.ts'
import { installChatViewVisibility } from './visibility.ts'
import { installRowAction, type RowAction, type SlotLedger } from './mount.tsx'
import { rewindActionRenderer } from './action.tsx'
import { createPendingBridge } from './pending-mount.tsx'
import { isRewindInertSession, runRewindAndFill, writeComposer } from './rewind-flow.ts'
import type { MessageImageRef } from './hidden.ts'
import { createCommandFace } from './command-takeover.ts'
import { CommandConflicts } from './command-conflicts.ts'
import { REWIND, REWIND_COMMANDS, type RewindCommand } from './command-names.ts'
import { candidatesOverApi, previewOverApi } from './host-api.ts'
import { contractErrorKey } from './errors.ts'
import { createTakeoverStore, type UiOwner } from './claim.ts'
import { RewindIcon } from './icon.tsx'
import { rewindLog } from './log.ts'
import { BUILD_HASH, PLUGIN_PACKAGE, PLUGIN_VERSION } from './build-info.ts'
import { CLIENT_DICTS } from './locales.ts'
import { STYLE } from './styles.ts'
import {
  SettingsCard,
  settingsForm,
  SETTINGS_ENTRY_ID,
  type SettingsFormScope,
  type SettingsPolicy,
} from './settings-card.tsx'

export const name = 'dsh-rewind'
export type { CommandTakeoverPermission, RewindCommandFace, RewindCommands } from './command-takeover.ts'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    /** One Host command catalog read for the session. */
    dshRewindCommands: unknown
  }
}

// `configForms` IS a module-level inject: the rewind surface itself never needs
// it, but the configuration card is addressed through it, and the web profile
// always composes `ui-settings` (the same dependency the official settings
// pages declare).
export const inject = ['slots', 'sessions', 'locale', 'commandUi', 'configForms', 'remote', 'remote.commands']

const NS = 'rewind'

/** The harness-declared session slot the pending layer mounts through (renders portals only). */
const HEADER_ACTIONS_SLOT = 'conversation.session.header.actions'

/** The complete durable image reference the session face's image read verifies. */
type DurableImageRef = Parameters<SessionFace['readAttachment']>[0]

/**
 * Structural face of the `conversation.input` session-input resolver
 * (`SessionInputResolver`): resolves a per-session input shell whose
 * `setDraft` replaces the whole composer draft through the harness's Lexical
 * editor. Typed locally so the plugin never imports the conversation UI
 * package and survives harness version drift.
 */
interface SessionInputResolverLike {
  for(actx: unknown): { setDraft(text: string): void; focus(): void }
}

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
  /** Client-root event subscription (the reset that invalidates the catalog). */
  on(event: string, listener: () => void): () => void
  slots: unknown
  commandUi: unknown
  /** Register this bundle's public command-face service (`ctx.dshRewind`). */
  provide(name: string, value?: unknown): unknown
  /** Per-entry configuration forms (this bundle's own entry included). */
  configForms: { get<T>(entryId: string): ConfigForm<T> }
}

/** Client Remote face: one Session's Host catalog plus its invalidation events. */
interface RemoteFace {
  commands: {
    list(sessionId: string): Promise<
      | { ok: true; value: readonly { name: string }[] }
      | { ok: false; error: unknown }
    >
  }
  $on(event: string, listener: (payload?: unknown) => void): () => void
}

/**
 * Structural face of the runtime slot service. The client context types
 * `slots` as unknown, so the plugin declares the subset it uses — the
 * configuration card registration. Typed locally so the plugin imports no
 * slot package and survives harness version drift.
 */
interface SlotsLike {
  inject(key: string, install: () => () => void): () => void
  /**
   * One slot registration. `Face` is the injected business face the renderer
   * decomposes (its `hooks` compartment is rebound as a `use<Name>` selector
   * hook); `Props` is the COMPOSED props a component receives — the slot's
   * runtime owner share, the locale seat, and that face — which is what the
   * component is typed against, never the face alone.
   */
  register<P, Face = P>(
    entry: {
      readonly name: string
      readonly id?: string
      readonly order?: number
      readonly key?: string
      readonly locale?: string
      readonly inject?: () => Face
    },
    component: (props: P) => ReactNode,
  ): () => void
}

/**
 * Client plugin body: the client commands, the command-face takeover service,
 * locale, visibility and the settings card.
 * @param ctx - client root context carrying `slots`, `sessions`, `locale` and `commandUi`.
 */
export function apply(ctx: ClientContext): void {
  // Startup identity line (behind the existing `dsh-rewind.debug` switch, never
  // a new key): lets a reporter confirm the running bundle matches a fix,
  // ruling out stale cache / an un-restarted host — the cheapest, most likely
  // root cause. One line per load, not per event.
  rewindLog.info('boot', `loaded v${PLUGIN_VERSION} (build ${BUILD_HASH})`)

  ctx.effect(function* () {
    yield ctx.locale.register(NS, CLIENT_DICTS)
    const t = ctx.locale.bind(NS)

    registerPreviewCall(previewOverApi)
    // The entry configuration also carries the live checkpointing policy and
    // `uiOwner`; both are read-only here.
    interface SettingsRead extends SettingsPolicy {
      readonly uiOwner?: 'auto' | 'self'
    }
    const settingsScope = (() => {
      try {
        return ctx.configForms.get<SettingsRead>(SETTINGS_ENTRY_ID)
      } catch {
        return undefined
      }
    })()
    const checkpointingEnabled = (): boolean =>
      settingsScope?.getSnapshot().value?.fileCheckpointingEnabled !== false
    /** The live owner policy both takeover faces read (never cached). */
    const readOwner = (): UiOwner =>
      settingsScope?.getSnapshot().value?.uiOwner === 'self' ? 'self' : 'auto'
    // Third-party action-interface takeover.
    const takeover = createTakeoverStore({
      readOwner,
      subscribeOwner: listener => settingsScope?.subscribe(listener) ?? (() => {}),
      ...(typeof document === 'undefined' ? {} : { document }),
    })
    const stopTakeoverWatch = takeover.subscribe(() => {
      if (takeover.getSnapshot().claimed) closePopover()
    })

    const style = document.createElement('style')
    // Keep the package identity for diagnostics; the plugin owns removal.
    style.dataset.plugin = PLUGIN_PACKAGE
    style.textContent = STYLE
    document.head.appendChild(style)

    // Move rewind hiding to the Chat snapshot input: nodes stay in the store
    // (composer refill) but leave `order`/locations/navigation/grouping when
    // the builder receives them as `visibility: 'hidden'`.
    installChatViewVisibility(ctx)

    // ---- shared session/chat capabilities for the text flow ----
    // `sessionOf` resolves a session id to its live face; `isMainViewSession`
    // is the session switch check the composer refill needs (fill only the
    // session the rewind actually happened in).
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
    /** Locale switches re-render the pending layer's portaled labels. */
    const subscribeLocale = (cb: () => void): (() => void) => ctx.locale.subscribe(cb)

    /**
     * The session's composer facade (draft write + focus), resolved lazily
     * through `ctx.get`; `scope` is reached via `sessions.scope`. Never throws.
     */
    const composerFacade = (sessionId: string): { setDraft(text: string): void; focus(): void } | undefined => {
      const conversation = (ctx as { get(name: string): unknown }).get('conversation') as { input?: SessionInputResolverLike } | undefined
      const input = conversation?.input
      const scope = (ctx.sessions as { scope?: (id: SessionId) => unknown }).scope?.(sessionId as SessionId)
      if (input === undefined || scope === undefined) return undefined
      return {
        setDraft: (draft: string) => { input.for(scope).setDraft(draft) },
        focus: () => { input.for(scope).focus() },
      }
    }

    /**
     * File-extension map for the composer intake's accepted image types (the
     * harness's `isImageMediaType` whitelist): restores name unnamed drafts so
     * the rail card renders the right kind.
     */
    const IMAGE_MEDIA_EXTENSION: Record<string, string> = {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/webp': 'webp',
      'image/gif': 'gif',
    }

    /**
     * The composer image restorer: puts a withdrawn message's durable image
     * references back into that session's composer draft. `readAttachment`
     * takes the complete reference the host verifies; `createDrafts` +
     * `addAttachments` run the same intake a dragged-in image takes (including
     * the entry-time upload), so a rewind of an image-bearing message loses
     * nothing. Best-effort and never throws: one image's failure skips that
     * image, and absent services degrade to the text-only refill.
     */
    const restoreImages = async (sessionId: string, images: readonly MessageImageRef[]): Promise<void> => {
      if (images.length === 0) return
      const session = sessionOf(sessionId)
      const conversation = (ctx as { get(name: string): unknown }).get('conversation') as {
        input?: { for(actx: unknown): { addAttachments(ids: readonly string[]): boolean } }
        createDrafts?: (id: SessionId, files: readonly File[], uploadImages: boolean) => readonly { id: string }[]
        releaseDraftAttachments?: (drafts: readonly { id: string }[]) => void
      } | undefined
      const scope = (ctx.sessions as { scope?: (id: SessionId) => unknown }).scope?.(sessionId as SessionId)
      if (session === undefined || conversation?.input === undefined || conversation.createDrafts === undefined || scope === undefined) {
        rewindLog.warn('refill', 'image restore unavailable (conversation services not ready)')
        return
      }
      const files: File[] = []
      for (const [index, ref] of images.entries()) {
        const extension = IMAGE_MEDIA_EXTENSION[ref.mediaType]
        if (extension === undefined) {
          rewindLog.warn('refill', `skipping image with unsupported type ${ref.mediaType}`)
          continue
        }
        if (typeof ref.bytes !== 'number' || typeof ref.width !== 'number' || typeof ref.height !== 'number') {
          rewindLog.warn('refill', `skipping image ${ref.attachmentId}: incomplete durable reference`)
          continue
        }
        try {
          const result = await session.readAttachment({
            attachmentId: ref.attachmentId as DurableImageRef['attachmentId'],
            mediaType: ref.mediaType as DurableImageRef['mediaType'],
            bytes: ref.bytes,
            width: ref.width,
            height: ref.height,
            ...(ref.name === undefined ? {} : { name: ref.name }),
          })
          if (!result.ok) throw result.error
          // The face types its bytes as a plain `Uint8Array`, which newer TS
          // lib types widen to `ArrayBufferLike`; the host always hands over an
          // ArrayBuffer-backed view, so `File` takes it without a copy.
          const bytes = result.value.data as Uint8Array<ArrayBuffer>
          files.push(new File([bytes], ref.name ?? `image-${index + 1}.${extension}`, { type: ref.mediaType }))
        } catch (error) {
          rewindLog.warn('refill', `image read threw for ${ref.attachmentId}`, error)
        }
      }
      if (files.length === 0) return
      try {
        const drafts = conversation.createDrafts(sessionId as SessionId, files, session.getSnapshot().subagent === null)
        const admitted = conversation.input.for(scope).addAttachments(drafts.map(draft => draft.id))
        if (!admitted) {
          // A busy admission locks the composer; release what it refused, as the
          // harness's own drop path does.
          rewindLog.warn('refill', `composer refused ${drafts.length} restored image(s) (busy)`)
          conversation.releaseDraftAttachments?.(drafts)
        }
      } catch (error) {
        rewindLog.warn('refill', 'image restore threw', error)
      }
    }

    /**
     * The composer writer: the `conversation` service's `input` resolver
     * (`SessionInputResolver`), whose `setDraft` replaces the whole composer
     * draft through the harness's own Lexical editor. Wrapped in `writeComposer`
     * (the facade when reachable, else the contenteditable DOM fill).
     */
    const setComposerText = (sessionId: string, text: string): boolean => {
      try {
        return writeComposer(text, composerFacade(sessionId))
      } catch (error) {
        rewindLog.warn('refill', 'composer write threw', error)
        return false
      }
    }

    // The plugin's own popovers hold the keyboard while they are open; hand it
    // back on close, the same channel the harness uses for its own dismissals.
    registerComposerFocuser(sessionId => {
      try {
        composerFacade(sessionId)?.focus()
      } catch (error) {
        rewindLog.warn('refill', 'composer focus threw', error)
      }
    })

    const slots = ctx.slots as unknown as SlotsLike

    // ---- plugin configuration form (sidebar Plugins page) ----
    // The card is this bundle's own configuration page: it registers under
    // `plugins.bundle.config`, keyed by the BUNDLE's package name, and stages
    // its edits over the entry's shared configuration form (`ctx.configForms`),
    // exactly like the official settings pages.
    try {
      const { store, form } = settingsForm(
        ctx.configForms.get<SettingsPolicy>(SETTINGS_ENTRY_ID) as unknown as SettingsFormScope<SettingsPolicy>,
      )
      // The model subscribes to the entry's form on construction, so the fiber
      // must release it on unload (the official settings pages do the same).
      ctx.effect(() => () => { form.dispose() }, 'dsh-rewind settings form')
      yield slots.inject('plugins.bundle.config', () => slots.register(
        {
          name: 'plugins.bundle.config',
          key: PLUGIN_PACKAGE,
          locale: NS,
          inject: () => ({ hooks: { settingsCard: store }, ...form.actions() }),
        },
        SettingsCard,
      ))
    } catch (error) {
      // A settings-card failure must never break the plugin: the rewind
      // feature is independent of the settings surface.
      rewindLog.error('settings', 'settings card register failed', error)
    }

    // ---- /rewind and /undo client commands ----
    // A bare invocation opens the harness popupSelect; a third-party UI can
    // take the face over through `ctx.dshRewind` (see command-takeover.ts).
    const commandUi = ctx.get('commandUi') as CommandUiContract

    /**
     * Whether a session may be rewound: bound, and not a direct subagent. The
     * command stays available with no candidates so its picker can open empty.
     */
    const canRewindIn = (sessionId: string): boolean => {
      const face = sessionOf(sessionId)
      return face !== undefined && !isRewindInertSession(face.getSnapshot())
    }

    // A Host command owns its name. Read the Session's Host catalog at open /
    // preset switch and keep the same-name contribution out of the menu while
    // that name is owned. The snapshot starts optimistic and is only replaced
    // by a completed read.
    const remote = ctx.get('remote') as RemoteFace | undefined
    const readHostCommands = async (sessionId: string): Promise<readonly string[] | undefined> => {
      if (remote === undefined) return undefined
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          return await ctx.sessions.using(sessionId as SessionId, { source: 'dshRewindCommands' }, async () => {
            const result = await remote.commands.list(sessionId)
            if (!result.ok) throw new Error(`command.list failed: ${String(result.error)}`)
            return result.value.map(command => command.name)
          })
        } catch (error) {
          if (attempt === 3) {
            rewindLog.warn('conflicts', 'host command catalog unavailable', {
              sessionId,
              error: error instanceof Error ? error.message : String(error),
            })
            return undefined
          }
          await new Promise(resolve => { setTimeout(resolve, 250 * attempt) })
        }
      }
      return undefined
    }
    const conflicts = new CommandConflicts(readHostCommands)
    let current: string | undefined
    const syncSession = (): void => {
      const { ids, byId } = ctx.sessions.list.getSnapshot()
      const sessionId = ids.find(id => (byId[id]?.retainedBy.mainView ?? 0) > 0)
      if (sessionId === undefined || sessionId === current) return
      current = sessionId
      void conflicts.check(sessionId)
    }
    yield ctx.sessions.list.subscribe(syncSession)
    syncSession()
    yield ctx.on('connection/reset', () => { if (current !== undefined) void conflicts.check(current) })
    if (remote !== undefined) {
      yield remote.$on('agent-preset/selected', (sessionId) => {
        if (current !== undefined && String(sessionId) === current) void conflicts.check(current)
      })
    }

    /** Internal host candidate read for the picker. */
    const hostCandidates = new Map<string, readonly RewindCandidate[]>()
    const fetchHostCandidates = async (face: SessionFace): Promise<readonly RewindCandidate[]> => {
      const cached = hostCandidates.get(face.sessionId)
      const next = await candidatesOverApi(face.sessionId)
      if (next === undefined) return cached ?? []
      hostCandidates.set(face.sessionId, next)
      return next
    }

    /** The composer card the mode popover anchors to. */
    const composerAnchor = (): HTMLElement => {
      const surface = composerSurface()
      const card = surface?.closest<HTMLElement>('[data-composer-card]')
      return card ?? surface ?? document.body
    }

    // The popup shared by `/rewind` and its alias `/undo`.
    const rewindPopupSpec: PopupSelectSpec = {
      kind: 'popupSelect',
      options: async session => {
        const face = sessionOf(session.sessionId)
        return face === undefined ? [] : rewindOptionsFromCandidates(await fetchHostCandidates(face), t)
      },
      onSelect: (option, session) => {
        const face = sessionOf(session.sessionId)
        if (face === undefined) return
        const candidate = hostCandidates.get(face.sessionId)?.find(candidate => candidate.seq === Number(option.id))
        if (candidate === undefined) return
        openPopover({
          session: face,
          seq: candidate.seq,
          time: candidate.time,
          preview: candidate.preview,
          anchor: composerAnchor(),
          t,
          checkpointingEnabled: checkpointingEnabled(),
          onRewind: mode => { void runRewindAndFill(face, candidate.seq, mode, isMainViewSession, setComposerText, restoreImages, code => t(contractErrorKey(code))) },
        })
      },
    }

    /** One client command per name; both share the picker. */
    const commandContribution = (name: RewindCommand): CommandContribution => ({
      name,
      label: () => t(name === REWIND ? 'command.rewindLabel' : 'command.undoLabel'),
      description: () => t(name === REWIND ? 'command.description' : 'command.undoDescription'),
      icon: RewindIcon,
      available: session => canRewindIn(session.sessionId) && conflicts.allows(name),
      ui: rewindPopupSpec,
    })

    const commandFace = createCommandFace({
      contributions: REWIND_COMMANDS.map(name => commandContribution(name)),
      register: contribution => commandUi.register(contribution),
      dismiss: name => { commandUi.dismiss(name) },
      readOwner,
    })
    ctx.effect(() => () => commandFace.dispose(), 'dsh-rewind command face')
    try {
      ctx.provide('dshRewind', commandFace.service)
    } catch (error) {
      // Another copy of this bundle already owns the page-level service. The
      // commands still work; only the takeover channel is unavailable.
      rewindLog.error('command', 'command-face service registration failed', error)
    }

    // ---- per-message rewind action (a child of the official actions row) ----
    /** Open the mode popover for one row, anchored at its action button. */
    const openRewindFor = (row: RowAction, anchor: HTMLElement): void => {
      const face = sessionOf(row.sessionId)
      if (face === undefined) {
        rewindLog.warn('action', 'rewind action clicked with no session binding')
        return
      }
      openPopover({
        session: face,
        seq: row.seq,
        time: row.time,
        preview: row.text,
        anchor,
        placement: 'below',
        t,
        checkpointingEnabled: checkpointingEnabled(),
        onRewind: mode => { void runRewindAndFill(face, row.seq, mode, isMainViewSession, setComposerText, restoreImages, code => t(contractErrorKey(code))) },
      })
    }

    // A failing mount costs the action only: the command face and the
    // visibility layer above must not share its fate.
    try {
      yield installRowAction({
        slots: ctx.slots as unknown as SlotLedger,
        render: rewindActionRenderer(t, canRewindIn, openRewindFor, takeover),
      })
    } catch (error) {
      rewindLog.error('action', 'rewind action mount failed', error)
    }

    // ---- pending (unclaimed) steering retract ----
    // A zero-UI session-scoped anchor; the layer works only while the inbox
    // holds steering rows.
    try {
      yield slots.inject(HEADER_ACTIONS_SLOT, () => slots.register(
        { name: HEADER_ACTIONS_SLOT, id: 'dsh-rewind-pending', order: 1000 },
        createPendingBridge({ sessionOf, setComposerText, restoreImages, t, subscribeLocale, takeover }),
      ))
    } catch (error) {
      rewindLog.error('retract', 'pending retract mount failed', error)
    }

    /** The composer's text-holding element: the `contenteditable` div. */
    const composerSurface = (): HTMLElement | null =>
      document.querySelector<HTMLElement>(COMPOSER_EDITABLE_SELECTOR)

    yield () => {
      stopTakeoverWatch()
      takeover.dispose()
      // A live disable can land while the mode popover is open. The popover is
      // plain DOM plus document capture-phase key listeners, so it must be
      // closed with this fiber: otherwise the node and the key steal (↑/↓/Esc
      // routed away from the composer) outlive the unload, and a later remount
      // would overwrite the singleton reference and leak both for good.
      closePopover()
      // The loader no longer reaps style[data-plugin]; remove it with the fiber.
      style.remove()
    }
  }, 'dsh-rewind client lifecycle')
}
