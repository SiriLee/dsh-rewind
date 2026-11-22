/**
 * Snapshot-level rewind visibility.
 *
 * DSH's Chat builder already supports hidden rows: a node stays in the node
 * store (so the composer can read its text/images) but leaves `order`,
 * `locations`, Turn navigation, and grouping whenever its `visibility` is
 * `'hidden'`. This module wraps the registered `chat` view builder and marks
 * the nodes inside an executed rewind's `[target, marker]` span hidden before
 * the builder sees them.
 *
 * The seam is private: `uiConversation.views` is a first-party registry and
 * `definition.create()` is not an extension point. Its shape is checked and it
 * is restored on unload.
 *
 * @module dsh-rewind/client/visibility
 */

import {
  RETIRED_REWIND_COMMAND,
  hasRewindMarker,
  rewindCutsOf,
  type ChatConversationViewNode,
  type RewindCut,
} from './hidden.ts'
import { registerRewindMarker } from './marker-node.ts'
import { rewindLog } from './log.ts'

interface BuilderLike {
  readonly empty: unknown
  replace(input: BuilderInput): unknown
  apply(input: BuilderApplyInput): unknown
  groupInput?(): unknown
  publish?(): void
}

interface BuilderInput {
  readonly nodes: readonly ChatConversationViewNode[]
  readonly timeline: unknown
  readonly changedTurns?: readonly number[]
}

interface BuilderApplyInput {
  readonly upserts: readonly ChatConversationViewNode[]
  readonly timeline: unknown
  readonly changedTurns?: readonly number[]
}

interface ViewDefinitionLike {
  readonly target?: string
  create?: () => unknown
}

interface ViewsLike {
  entries(): readonly ViewDefinitionLike[]
  subscribe?(listener: () => void): () => void
}

interface BindingLike {
  rebuild?(): void
}

interface UiConversationLike {
  readonly views?: ViewsLike
  /** Public Conversation Definition registry; publishes the marker node. */
  readonly events?: { register(definition: unknown): () => void }
  binding?(sessionId: string): BindingLike | undefined
}

interface SessionsLike {
  readonly list?: {
    getSnapshot(): {
      readonly ids?: readonly string[]
      readonly byId?: Readonly<Record<string, { readonly retainedBy?: Readonly<Record<string, number>> }>>
    }
  }
}

/** Context subset the installer needs; structurally satisfied by the client root. */
export interface VisibilityContext {
  get(name: string): unknown
  effect?(execute: () => (() => void) | void, label?: string): unknown
  inject?(names: readonly string[], callback: (scope: VisibilityContext) => void): unknown
  readonly sessions?: SessionsLike
}

interface PatchRecord {
  readonly original: () => unknown
  readonly wrapper: () => unknown
}

let patches = new Map<object, PatchRecord>()
let currentCleanup: (() => void) | undefined

/**
 * Wrap the registered `chat` view builder so rewind spans enter the builder as
 * `visibility: 'hidden'`. Idempotent across registry changes and HMR.
 * @param ctx - client root context.
 */
export function installChatViewVisibility(ctx: VisibilityContext): void {
  let stopped = false
  const start = (): (() => void) => {
    const scope = ctx.inject?.(['uiConversation'], child => {
      if (!stopped) installOn(child.get('uiConversation') as UiConversationLike | undefined, ctx.sessions)
    })
    // Contexts without `inject` (tests) read the service once.
    if (ctx.inject === undefined) {
      installOn(ctx.get('uiConversation') as UiConversationLike | undefined, ctx.sessions)
    }
    return () => {
      stopped = true
      currentCleanup?.()
      currentCleanup = undefined
      if (typeof scope === 'function') scope()
    }
  }
  if (ctx.effect === undefined) {
    start()
    return
  }
  ctx.effect(start, 'dsh-rewind chat visibility')
}

function installOn(ui: UiConversationLike | undefined, sessions: SessionsLike | undefined): void {
  currentCleanup?.()
  currentCleanup = undefined
  if (ui?.views === undefined) return

  // The marker Definition is the durable cut source (I9). It must be registered
  // before the first Chat builder runs so the marker node is already present.
  let disposeMarker: (() => void) | undefined
  try {
    if (ui.events === undefined) {
      rewindLog.error('visibility', 'uiConversation.events is unavailable; rewind spans cannot be derived')
    } else {
      disposeMarker = registerRewindMarker(ui.events)
    }
  } catch (error) {
    rewindLog.error('visibility', 'rewind-marker registration failed', error)
  }

  const views = ui.views
  const ensure = (): void => {
    try {
      const definition = views.entries().find(candidate => candidate.target === 'chat')
      if (definition === undefined || typeof definition.create !== 'function') return
      const current = patches.get(definition)
      const create = definition.create
      if (current !== undefined && create === current.wrapper) return
      const wrapper = function wrappedChatBuilder(this: unknown): unknown {
        return new RewindVisibilityBuilder(create.call(definition) as BuilderLike)
      }
      const mutable = definition as { create?: () => unknown }
      mutable.create = wrapper
      patches.set(definition, { original: create, wrapper })
      rewindLog.info('visibility', 'installed Chat snapshot visibility wrapper')
      rebuildOpenSessions(ui, sessions)
    } catch (error) {
      rewindLog.error('visibility', 'Chat visibility install probe failed', error)
    }
  }

  let unsubscribe: (() => void) | undefined
  try {
    unsubscribe = views.subscribe?.(ensure)
  } catch (error) {
    rewindLog.warn('visibility', 'Chat view subscription failed', error)
  }
  ensure()
  currentCleanup = () => {
    unsubscribe?.()
    disposeMarker?.()
    restorePatches()
    // Existing builders keep the wrapper until recreated.
    rebuildOpenSessions(ui, sessions)
  }
}

function restorePatches(): void {
  for (const [definition, record] of patches) {
    const mutable = definition as { create?: () => unknown }
    if (mutable.create === record.wrapper) mutable.create = record.original
  }
  patches = new Map()
}

function rebuildOpenSessions(ui: UiConversationLike, sessions: SessionsLike | undefined): void {
  const state = sessions?.list?.getSnapshot()
  if (state === undefined) return
  const ids = new Set([...(state.ids ?? []), ...Object.keys(state.byId ?? {})])
  for (const id of ids) {
    const row = state.byId?.[id]
    const retained = row?.retainedBy
    if (retained === undefined || !Object.values(retained).some(count => (count ?? 0) > 0)) continue
    try {
      ui.binding?.(id)?.rebuild?.()
    } catch (error) {
      rewindLog.warn('visibility', `chat rebuild failed for ${id}`, error)
    }
  }
}

/**
 * Structural wrapper over the registered Chat builder. It forwards every
 * builder method, keeps the original node objects, and only changes
 * `visibility`. A full replacement is used whenever the cut set changes;
 * otherwise it stays on the builder's incremental `apply` path.
 */
export class RewindVisibilityBuilder implements BuilderLike {
  private originals = new Map<string, ChatConversationViewNode>()
  private markers = new Map<string, ChatConversationViewNode>()
  private byTurn = new Map<number, Map<string, ChatConversationViewNode>>()
  private turnProcess = new Map<number, string>()
  private derived = new Map<string, ChatConversationViewNode>()
  private cuts: readonly RewindCut[] = []
  private cutSignature = '[]'
  private lastSignature = '[]'

  /** @param inner - the real Chat builder. */
  constructor(private readonly inner: BuilderLike) {}

  get empty(): unknown {
    return this.inner.empty
  }

  replace(input: BuilderInput): unknown {
    this.setAll(input.nodes)
    this.lastSignature = this.cutSignature
    return this.inner.replace({ nodes: this.deriveAll(), timeline: input.timeline, ...changed(input) })
  }

  apply(input: BuilderApplyInput): unknown {
    const affected = new Set<number>()
    let markersChanged = false
    for (const node of input.upserts) {
      const previous = this.originals.get(node.key)
      const previousTurn = previous === undefined ? undefined : turnOf(previous)
      const nextTurn = turnOf(node)
      if (previousTurn !== undefined) affected.add(previousTurn)
      if (nextTurn !== undefined) affected.add(nextTurn)
      if ((previous !== undefined && hasRewindMarker(previous)) || hasRewindMarker(node)) markersChanged = true
      this.setOriginal(node)
    }
    if (markersChanged) this.refreshCuts()
    if (this.cutSignature !== this.lastSignature) {
      this.lastSignature = this.cutSignature
      return this.inner.replace({ nodes: this.deriveAll(), timeline: input.timeline, ...changed(input) })
    }

    const cuts = this.cuts
    const upserts = new Map<string, ChatConversationViewNode>()
    for (const node of input.upserts) upserts.set(node.key, this.deriveOne(node, cuts))
    // A Turn-process summary can change visibility when one of its members does.
    for (const turn of affected) {
      const processKey = this.turnProcess.get(turn)
      const base = processKey === undefined ? undefined : this.originals.get(processKey)
      if (base === undefined) continue
      const next = this.deriveTurnProcess(base, cuts, turn, this.deriveOne(base, cuts))
      if (this.derived.get(processKey!) !== next) upserts.set(processKey!, next)
    }
    const list = [...upserts.values()]
    for (const node of list) this.derived.set(node.key, node)
    return this.inner.apply({ upserts: list, timeline: input.timeline, ...changed(input) })
  }

  groupInput(): unknown {
    return this.inner.groupInput?.()
  }

  publish(): void {
    this.inner.publish?.()
  }

  private setAll(nodes: readonly ChatConversationViewNode[]): void {
    this.originals.clear()
    this.markers.clear()
    this.byTurn.clear()
    this.turnProcess.clear()
    this.derived.clear()
    for (const node of nodes) this.setOriginal(node)
    this.refreshCuts()
  }

  private setOriginal(node: ChatConversationViewNode): void {
    const previous = this.originals.get(node.key)
    if (previous !== undefined) this.unindex(previous)
    this.originals.set(node.key, node)
    if (hasRewindMarker(node)) this.markers.set(node.key, node)
    const turn = turnOf(node)
    if (turn === undefined) return
    const members = this.byTurn.get(turn) ?? new Map<string, ChatConversationViewNode>()
    members.set(node.key, node)
    this.byTurn.set(turn, members)
    if (node.kind === 'turn-process') this.turnProcess.set(turn, node.key)
  }

  private unindex(node: ChatConversationViewNode): void {
    if (hasRewindMarker(node)) this.markers.delete(node.key)
    const turn = turnOf(node)
    if (turn === undefined) return
    const members = this.byTurn.get(turn)
    if (members === undefined) return
    members.delete(node.key)
    if (members.size === 0) this.byTurn.delete(turn)
    if (node.kind === 'turn-process' && this.turnProcess.get(turn) === node.key) {
      this.turnProcess.delete(turn)
      for (const member of members.values()) {
        if (member.kind === 'turn-process') {
          this.turnProcess.set(turn, member.key)
          break
        }
      }
    }
  }

  private refreshCuts(): void {
    this.cuts = rewindCutsOf(this.markers.values())
    this.cutSignature = JSON.stringify(
      this.cuts.map(cut => `${cut.target}:${cut.marker}`).sort(),
    )
  }

  private deriveAll(): readonly ChatConversationViewNode[] {
    const cuts = this.cuts
    const derived = new Map<string, ChatConversationViewNode>()
    for (const node of this.originals.values()) derived.set(node.key, this.deriveOne(node, cuts))
    for (const [turn, key] of this.turnProcess) {
      const base = this.originals.get(key)
      if (base === undefined) continue
      const current = derived.get(key) ?? this.deriveOne(base, cuts)
      derived.set(key, this.deriveTurnProcess(base, cuts, turn, current))
    }
    const result = [...derived.values()]
    this.derived = derived
    return result
  }

  private deriveOne(node: ChatConversationViewNode, cuts: readonly RewindCut[]): ChatConversationViewNode {
    const base = this.originals.get(node.key) ?? node
    if (hasRewindMarker(base)) return hidden(base)
    if (base.kind === 'command') {
      const command = base.data as {
        name?: string | null
        args?: string | null
        outcome?: { kind?: string; sourceEventSeq?: number } | null
      }
      if (command.name === RETIRED_REWIND_COMMAND) {
        const args = command.args ?? ''
        const probe = args.includes('preview') || args.includes('__candidates')
        // A successful retained-engine command is a rewind row. The live client
        // commands leave no command rows at all.
        const executed = command.outcome?.kind === 'success'
        if (probe || executed) return hidden(base)
      }
      return base
    }
    const contained = cuts.some(cut => cut.target <= base.anchorSeq && base.anchorSeq <= cut.marker)
    return contained ? hidden(base) : base
  }

  private deriveTurnProcess(
    base: ChatConversationViewNode,
    cuts: readonly RewindCut[],
    turn = turnOf(base),
    current = this.deriveOne(base, cuts),
  ): ChatConversationViewNode {
    if (turn === undefined || current.visibility === 'hidden') return current
    const members = this.byTurn.get(turn)
    if (members === undefined) return current
    let count = 0
    let allHidden = true
    for (const member of members.values()) {
      if (member.key === base.key) continue
      count += 1
      if (this.deriveOne(member, cuts).visibility !== 'hidden') {
        allHidden = false
        break
      }
    }
    // A window holding only the summary cannot judge the Turn honestly.
    if (count === 0) return current
    return allHidden ? hidden(base) : current
  }
}

function hidden(node: ChatConversationViewNode): ChatConversationViewNode {
  return node.visibility === 'hidden' ? node : { ...node, visibility: 'hidden' }
}

function turnOf(node: ChatConversationViewNode): number | undefined {
  const turn = node.location?.turn?.turn
  return typeof turn === 'number' ? turn : undefined
}

function changed(input: { readonly changedTurns?: readonly number[] }): { readonly changedTurns?: readonly number[] } {
  return input.changedTurns === undefined ? {} : { changedTurns: input.changedTurns }
}
