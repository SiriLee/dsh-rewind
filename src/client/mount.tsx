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
 * A shadow seat — a lower-priority registration for the same key — wins the
 * cell and renders instead of the shipped row, so the shipped takeover alone
 * would leave the action on a component nobody renders. The mount therefore
 * also takes over the seat the outlet renders: a shadow that keeps the shipped
 * `actions` contract is already covered, and one that rebuilds the row gets the
 * action portaled into its own action strip.
 *
 * Any shape mismatch returns the official element as-is: the worst outcome is a
 * missing action, never a broken row.
 *
 * @module dsh-rewind/client/mount
 */

import {
  cloneElement,
  Fragment,
  isValidElement,
  useLayoutEffect,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { rewindLog } from './log.ts'

/** The keyed slot whose entries render one Chat row per node kind. */
const CHAT_NODE_SLOT = 'conversation.chat.node'

/** Row keys whose actions row carries the action (user and steering share one renderer). */
const ROW_KEYS: ReadonlySet<string> = new Set(['user', 'steering'])

/**
 * The shipped user/steering rows register at the default priority. A shadow
 * may sit in front and delegate by excluding its own identity, so the default
 * priority entry is taken over as the fallback and every shadow's delegate.
 */
const SHIPPED_ROW_PRIORITY = 0

/** The class fragment of a message row's action strip (official chrome and sibling anchors). */
const ACTIONS_STRIP_HINT = '_actions'

/** A shadow's forwarded props may lack the shipped row's child-chain seat. */
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

/** A ref to the row element a replacing shadow returned. */
interface RowRef {
  current: HTMLElement | null
}

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
 * The row's logged text, joined from the node's text blocks — the Copy target
 * the shadow path has no actions-row constructor to hand over.
 * @param props - the composed row props.
 * @returns the joined text, or the empty string when the node carries none.
 */
function rowTextOf(props: Record<string, unknown>): string {
  const content = (props['node'] as { readonly data?: { readonly content?: unknown } } | undefined)?.data?.content
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const { type, text: value } = block as { type?: unknown; text?: unknown }
    if (type === 'text' && typeof value === 'string') text += value
  }
  return text
}

/**
 * Locate the action strip of a row a shadow rebuilt: the `_actions` class
 * convention first (first in document order, so a code card's own toolbar
 * cannot win), then the clock-carrying container, then the last button's parent.
 * @param row - the rendered row element.
 * @returns the strip container, or null when the row exposes none.
 */
function actionsStripOf(row: HTMLElement): HTMLElement | null {
  const marked = row.querySelector<HTMLElement>(`[class*="${ACTIONS_STRIP_HINT}"]`)
  if (marked !== null) return marked
  const clocked = row.querySelector<HTMLElement>('[data-clock]')
  if (clocked !== null) return clocked
  return [...row.querySelectorAll('button')].at(-1)?.parentElement ?? null
}

/**
 * The action button, portaled into the strip a replacing shadow built. That
 * strip is the shadow's own React tree, so it is addressable only once
 * rendered; the portal keeps the button mounted with the row and inside the
 * strip's own hover and focus chrome.
 * @param rowRef - the rendered row element holding the strip.
 * @param target - the row the action addresses.
 * @param render - the action element factory.
 * @param onFault - receives a failed action render (the shadow's strip is still kept).
 * @returns the portaled action, or null while the strip is unknown.
 */
function ShadowRowAction({ rowRef, target, render, onFault }: {
  rowRef: RowRef
  target: RowAction
  render: RowActionRenderer
  onFault: (error: unknown) => void
}): ReactNode {
  const [strip, setStrip] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => {
    const row = rowRef.current
    const next = row === null ? null : actionsStripOf(row)
    // The same container is a no-op update, so this dependency-free effect settles.
    setStrip(current => (current === next ? current : next))
  })
  if (strip === null) return null
  try {
    const element = render(target)
    if (element === null || element === undefined) return null
    return createPortal(element, strip)
  } catch (error) {
    // A failing action must leave the shadow's own strip intact.
    onFault(error)
    return null
  }
}

/**
 * Wrap one official renderer so the actions row it constructs gains the action.
 * The renderer is invoked directly instead of being rendered as an element:
 * only the element it returns exposes the actions constructor to rewrite. Safe
 * while the row renderer stays hook-free (the user/steering renderer is today).
 * @param official - the official renderer, called with the composed row props.
 * @param render - the action element factory.
 * @param onFault - receives a failed action render (the row is still kept).
 * @returns the renderer that replaces the official one in the ledger.
 */
function rowWithAction(official: Renderer, render: RowActionRenderer, onFault: (error: unknown) => void): Renderer {
  return function RowWithAction(props: Record<string, unknown>): ReactNode {
    // Keep a host-supplied chain; a shadow's forwarded props may omit it.
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
      } catch (error) {
        // A failing action must leave the official actions row intact.
        onFault(error)
        return actionsRow
      }
    }
    return cloneElement(row as ReactElement<{ actions?: unknown }>, { actions: withAction })
  }
}

/**
 * Wrap one shadow renderer so a row it rebuilds still carries the action. A row
 * that keeps the shipped `actions` contract passes through untouched; one that
 * rebuilds itself is decorated through a portal.
 * @param official - the shadow renderer, called with the composed row props.
 * @param render - the action element factory.
 * @param shipped - the wrapped shipped renderer, the answer to a delegation.
 * @param onFault - receives a failed action render (the row is still kept).
 * @returns the renderer that replaces the shadow in the ledger.
 */
function rowWithShadowAction(
  official: Renderer,
  render: RowActionRenderer,
  shipped: Renderer,
  onFault: (error: unknown) => void,
): Renderer {
  /** Synchronous re-entry depth: a shadow calling its delegate as a function. */
  let depth = 0
  const wrapper: Renderer = function ShadowRowWithAction(props: Record<string, unknown>): ReactNode {
    if (depth > 0) return shipped(props)
    depth += 1
    let row: ReactNode
    try {
      row = official(props)
    } finally {
      depth -= 1
    }
    // A delegating shadow is handed this wrapper back, because the takeover
    // replaced its own identity; answer with the shipped row, which carries the
    // action, instead of recursing.
    if (isValidElement(row) && row.type === wrapper) return shipped(props)
    const target = targetOf(props)
    if (target === undefined || !isValidElement(row)) return row
    // A row keeping the shipped contract is already decorated by the shipped entry.
    if (typeof (row.props as { actions?: unknown }).actions === 'function') return row
    // Only a host element can carry the ref the strip is reached through.
    if (typeof row.type !== 'string') return row
    const rowRef: RowRef = { current: null }
    return (
      <Fragment>
        {cloneElement(row as ReactElement<{ ref?: RowRef }>, { ref: rowRef })}
        <ShadowRowAction rowRef={rowRef} target={{ ...target, text: rowTextOf(props) }} render={render} onFault={onFault} />
      </Fragment>
    )
  }
  return wrapper
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
  /** The wrapped shipped renderer per row key. */
  const shipped = new Map<string, Renderer>()

  /** Report the first action-render fault of this mount once, never per row. */
  let faultReported = false
  const reportFault = (error: unknown): void => {
    if (faultReported) return
    faultReported = true
    rewindLog.warn('action', 'rewind action render failed; the official actions row was kept', error)
  }

  /** Record one takeover: the entry object keeps its seat, its identity changes. */
  const takeOver = (entry: LedgerEntry, replacement: Renderer): true => {
    taken.set(entry, { original: entry.component, replacement })
    entry.component = replacement
    return true
  }

  /** Take over the shipped seat and record its wrapper in `shipped`. */
  const takeOverShipped = (entry: LedgerEntry, key: string): boolean => {
    if (taken.has(entry)) return false
    const official = rendererOf(entry.component)
    if (official === undefined) return false
    const replacement = rowWithAction(official, render, reportFault)
    shipped.set(key, replacement)
    return takeOver(entry, replacement)
  }

  /** Take over the winning shadow, once the shipped wrapper it may delegate to exists. */
  const takeOverShadow = (entry: LedgerEntry, key: string): boolean => {
    if (taken.has(entry)) return false
    const official = rendererOf(entry.component)
    const delegate = shipped.get(key)
    if (official === undefined || delegate === undefined) return false
    return takeOver(entry, rowWithShadowAction(official, render, delegate, reportFault))
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
    /** Per row key: the shipped seat and the lowest-priority seat in front of it. */
    const cells = new Map<string, { shipped?: LedgerEntry; winner?: LedgerEntry; winnerPriority: number }>()
    for (const entry of readEntries(CHAT_NODE_SLOT)) {
      const key = entry.options.key
      if (key === undefined || !ROW_KEYS.has(key)) continue
      const cell = cells.get(key) ?? { winnerPriority: SHIPPED_ROW_PRIORITY }
      const priority = entry.options.priority ?? SHIPPED_ROW_PRIORITY
      if (priority === SHIPPED_ROW_PRIORITY) cell.shipped = entry
      else if (priority < cell.winnerPriority) {
        cell.winner = entry
        cell.winnerPriority = priority
      }
      cells.set(key, cell)
    }
    for (const [key, cell] of cells) {
      // Shipped first: a shadow's delegate must exist before it is wrapped.
      if (cell.shipped !== undefined && takeOverShipped(cell.shipped, key)) changed = true
      // A seat in front of the shipped one wins the cell; a positive priority never does.
      if (cell.winner !== undefined && takeOverShadow(cell.winner, key)) changed = true
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
