/**
 * A2 element-tree mount: one extra action inside the official user/steering
 * message rows.
 *
 * The actions row is built by the official renderer, so the action can only be
 * added while that row is constructed. The mount takes over the slot entry's
 * component identity, calls the official renderer with the props the slot
 * composed for it, and replaces the row element's `actions` constructor: the
 * official constructor runs first, and the actions row it returns receives the
 * extra action through its `extraActions` prop.
 *
 * Both element types (the row and the actions row) are preserved, so React
 * reuses their fibers, and every prop this module does not touch is passed
 * through unchanged. The action becomes a child of the actions row, so it
 * mounts, unmounts and inherits the row's visibility with the Copy button
 * instead of chasing the DOM.
 *
 * Any shape mismatch returns the official element as-is: the worst outcome is a
 * missing action, never a broken row.
 *
 * @module dsh-rewind/client/mount
 */

import { cloneElement, Fragment, isValidElement, type ReactElement, type ReactNode } from 'react'

/** The keyed slot whose entries render one Chat row per node kind. */
const CHAT_NODE_SLOT = 'conversation.chat.node'

/** Row keys whose actions row carries the action (user and steering share one renderer). */
const ROW_KEYS: ReadonlySet<string> = new Set(['user', 'steering'])

/** Shipped chat rows use the default priority. Shadow renderers may delegate to them. */
const SHIPPED_ROW_PRIORITY = 0

/** A shadow slot may forward row props without the shipped row's chain capability. */
const NO_SLOT_CHAIN = (): null => null

/** Probe key of the version tick: a cell no node kind ever dispatches to. */
const TICK_KEY = 'dsh-rewind:mount'

/** One rendered row the action is offered for. */
export interface RowAction {
  /** Session rendering the row. */
  readonly sessionId: string
  /** Durable log seq of the message. */
  readonly seq: number
  /** Message time, epoch ms. */
  readonly time: number
  /** The row's joined text — the Copy target, known only when the actions row is built. */
  readonly text: string
}

/** Build the action element for one row; `null` leaves the actions row untouched. */
export type RowActionRenderer = (row: RowAction) => ReactNode

/** A registered slot entry, as the live ledger exposes it. */
interface LedgerEntry {
  /** The registered component identity; replacing it replaces what the row renders. */
  component: unknown
  readonly options: { readonly key?: string; readonly priority?: number }
}

/** The live slot-ledger surface the mount reads. */
export interface SlotLedger {
  /** Entries of one slot key, in registration order. */
  entries?(key: string): readonly LedgerEntry[]
  /** Registration changes of one slot key (microtask-batched). */
  subscribe?(key: string, fn: () => void): () => void
  /** Registration path, used only for the version tick. */
  register?(options: { readonly name: string; readonly key?: string }, component: () => null): () => void
}

/** Mount inputs. */
export interface RowActionMount {
  readonly slots: SlotLedger
  readonly render: RowActionRenderer
}

/** The bare render function of a registered component. */
type Renderer = (props: Record<string, unknown>) => ReactNode

/** The row element's replaceable actions-row constructor. */
type ActionsConstructor = (text: string) => ReactNode

/** Read a registered component's renderer, unwrapping `memo`/`forwardRef`. */
function rendererOf(component: unknown): Renderer | undefined {
  if (typeof component === 'function') return component as Renderer
  if (component === null || typeof component !== 'object') return undefined
  const type = (component as { type?: unknown }).type
  return typeof type === 'function' ? type as Renderer : undefined
}

/** Read the row's addressing fields, or undefined when the node shape is not the expected one. */
function targetOf(props: Record<string, unknown>): Omit<RowAction, 'text'> | undefined {
  const sessionId = props['sessionId']
  const data = (props['node'] as { readonly data?: { readonly seq?: unknown; readonly time?: unknown } } | undefined)?.data
  if (typeof sessionId !== 'string' || typeof data?.seq !== 'number' || typeof data.time !== 'number') return undefined
  return { sessionId, seq: data.seq, time: data.time }
}

/**
 * Wrap one official renderer so the actions row it constructs gains the action.
 * The renderer is invoked directly instead of being rendered as an element:
 * only the element it returns exposes the actions constructor to rewrite. Safe
 * while the row renderer stays hook-free (the user/steering renderer is today).
 * @param official - the official renderer, called with the composed row props.
 * @param render - the action element factory.
 * @returns the renderer that replaces the official one in the ledger.
 */
function rowWithAction(official: Renderer, render: RowActionRenderer): Renderer {
  return function RowWithAction(props: Record<string, unknown>): ReactNode {
    const row = official(typeof props['renderSlotChain'] === 'function'
      ? props
      : { ...props, renderSlotChain: NO_SLOT_CHAIN })
    const target = targetOf(props)
    if (target === undefined || !isValidElement(row)) return row
    const actions = (row.props as { actions?: unknown }).actions
    if (typeof actions !== 'function') return row
    const buildActions = actions as ActionsConstructor
    const withAction = (text: string): ReactNode => {
      const actionsRow = buildActions(text)
      if (!isValidElement(actionsRow)) return actionsRow
      try {
        const element = render({ ...target, text })
        if (element === null || element === undefined) return actionsRow
        const existing = (actionsRow.props as { extraActions?: ReactNode }).extraActions
        return cloneElement(actionsRow as ReactElement<{ extraActions?: ReactNode }>, {
          extraActions: <Fragment>{existing}{element}</Fragment>,
        })
      } catch {
        // A failing action must leave the official actions row intact.
        return actionsRow
      }
    }
    return cloneElement(row as ReactElement<{ actions?: unknown }>, { actions: withAction })
  }
}

/**
 * Take over the user/steering row components so every rendered row's actions row
 * carries `render`'s element.
 *
 * Ledger methods are always called on `slots` itself: the live service is a
 * proxy that re-binds the caller context per call, so a method detached into a
 * local would lose its `this`.
 *
 * Wrapping runs synchronously with the registration (and at install for entries
 * already registered), so a row's first render already sees the new identity.
 * Outlets re-read an identity only on a registration change, so an already
 * rendered row is nudged once (see `tick`).
 *
 * @param mount - ledger surface and action renderer.
 * @returns teardown restoring the taken-over component identities.
 */
export function installRowAction({ slots, render }: RowActionMount): () => void {
  if (typeof slots.entries !== 'function') return () => {}
  const readEntries = (key: string): readonly LedgerEntry[] => slots.entries!(key)
  /** Taken-over entries and the exact identity each replaced. */
  const taken = new Map<LedgerEntry, { readonly original: unknown; readonly replacement: Renderer }>()

  const takeOver = (entry: LedgerEntry): boolean => {
    if (taken.has(entry)) return false
    const official = rendererOf(entry.component)
    if (official === undefined) return false
    const replacement = rowWithAction(official, render)
    taken.set(entry, { original: entry.component, replacement })
    entry.component = replacement
    return true
  }

  /** Move the slot's ledger version once, so mounted outlets read the new identity. */
  const tick = (): void => {
    if (typeof slots.register !== 'function') return
    try {
      slots.register({ name: CHAT_NODE_SLOT, key: TICK_KEY }, () => null)()
    } catch {
      // The tick only shortens the wait for a re-render; a refused registration
      // must not fail the mount.
    }
  }

  const sync = (): void => {
    let changed = false
    for (const entry of readEntries(CHAT_NODE_SLOT)) {
      const key = entry.options.key
      if (key === undefined || !ROW_KEYS.has(key)) continue
      // A shadow may find the shipped row by excluding its own component identity.
      // Replacing that identity would make it select itself and recurse.
      if ((entry.options.priority ?? SHIPPED_ROW_PRIORITY) !== SHIPPED_ROW_PRIORITY) continue
      changed = takeOver(entry) || changed
    }
    if (changed) tick()
  }

  sync()
  const unsubscribe = slots.subscribe?.(CHAT_NODE_SLOT, sync)
  return () => {
    unsubscribe?.()
    for (const [entry, record] of taken) {
      // Restore only our own identity: a later takeover of the same entry stays.
      if (entry.component === record.replacement) entry.component = record.original
    }
    taken.clear()
  }
}
