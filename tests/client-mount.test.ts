/**
 * @vitest-environment jsdom
 *
 * A2 mount probes: the official user/steering row components are taken over in
 * the slot ledger, the action is appended to the actions row the official
 * renderer constructs, and every structural mismatch degrades to the official
 * row. The last group pins the action itself (copy, aria, click → open).
 *
 * The ledger fake reads `this` exactly like the live service proxy, so a
 * detached method fails here instead of only in the browser. The official row
 * shape comes from `tests/support/chat-row.ts`.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { act, createElement, memo, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'

// jsdom + React act: the environment must opt in so act() does not warn.
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { rewindActionRenderer } from '../src/client/action.tsx'
import { installRowAction, type RowAction, type SlotLedger } from '../src/client/mount.tsx'
import { CLASS } from '../src/client/styles.ts'
import { ActionsRow, Bubble, officialRow, ROW_PROPS, ROW_TEXT } from './support/chat-row.ts'

type Props = Record<string, unknown>

/** One fake ledger entry, as the mount reads it. */
interface FakeEntry {
  component: unknown
  options: { key?: string }
}

/**
 * A ledger whose methods read `this`, exactly like the live slot service: its
 * methods are reached through a proxy that re-binds the caller per call, so a
 * detached method (a `const entries = slots.entries`) fails instead of working.
 */
class FakeLedger implements SlotLedger {
  readonly store: FakeEntry[] = []
  readonly tickKeys: string[] = []
  private readonly listeners: (() => void)[] = []

  constructor(initial: FakeEntry[] = []) {
    this.store.push(...initial)
  }

  entries(): readonly FakeEntry[] {
    return this.store
  }

  subscribe(_key: string, fn: () => void): () => void {
    this.listeners.push(fn)
    return () => {
      const at = this.listeners.indexOf(fn)
      if (at >= 0) this.listeners.splice(at, 1)
    }
  }

  register(options: { readonly name: string; readonly key?: string }): () => void {
    this.tickKeys.push(options.key ?? '')
    return () => {}
  }

  /** Fire the registration subscription, as the real ledger does on a change. */
  notify(): void {
    for (const fn of [...this.listeners]) fn()
  }
}

/** A row element with no actions-row constructor at all. */
const rowWithoutActions = (): ReactNode => createElement('div', { 'data-row': '' }, 'plain row')

const t = (key: string): string => key

/** The row props, optionally overridden per probe. */
function rowProps(overrides: Props = {}): Props {
  return { ...ROW_PROPS, ...overrides }
}

const mounted: { root: Root; container: HTMLElement }[] = []

/** Render a component into a fresh container; returns it. */
function render(component: unknown, props: Props = rowProps()): HTMLElement {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  act(() => { root.render(createElement(component as () => ReactNode, props)) })
  mounted.push({ root, container })
  return container
}

/** The action classes inside one rendered row, in DOM order. */
function actionOrder(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('[data-actions] > *')).map((node) => {
    if (node.hasAttribute('data-copy')) return 'copy'
    if (node.hasAttribute('data-existing')) return 'existing'
    if (node.classList.contains(CLASS.action)) return 'action'
    return 'other'
  })
}

/** The row's action button, if the mount injected one. */
function rewoundButton(container: HTMLElement): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(`button.${CLASS.action}`)
}

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => { root.unmount() })
    container.remove()
  }
  document.body.innerHTML = ''
})

describe('row takeover', () => {
  it('appends the action to the official actions row and keeps the row intact', () => {
    const ledger = new FakeLedger([{ component: officialRow, options: { key: 'user' } }])
    const opened: { row: RowAction; anchor: HTMLElement }[] = []
    const dispose = installRowAction({
      slots: ledger,
      render: rewindActionRenderer(t, () => true, (row, anchor) => opened.push({ row, anchor })),
    })
    // The ledger identity is what the outlets render, so the mount replaced it.
    expect(ledger.store[0]!.component).not.toBe(officialRow)

    const container = render(ledger.store[0]!.component)
    expect(container.querySelector('[data-copy]')).not.toBeNull()
    expect(container.querySelector('[data-bubble]')?.textContent).toBe('message body')
    expect(actionOrder(container)).toEqual(['copy', 'action'])

    const button = rewoundButton(container)
    expect(button).not.toBeNull()
    expect(button?.getAttribute('aria-label')).toBe('button.aria')
    expect(button?.dataset['tooltip']).toBe('button.title')
    act(() => { button!.click() })
    expect(opened).toHaveLength(1)
    expect(opened[0]!.row).toEqual({ sessionId: 's1', seq: 7, time: 1_700_000_000_000, text: ROW_TEXT })
    expect(opened[0]!.anchor).toBe(button)
    dispose()
  })

  it('takes over the steering row too', () => {
    const ledger = new FakeLedger([{ component: officialRow, options: { key: 'steering' } }])
    const dispose = installRowAction({ slots: ledger, render: () => createElement('i', { 'data-extra': '' }) })
    expect(ledger.store[0]!.component).not.toBe(officialRow)
    const container = render(ledger.store[0]!.component)
    expect(container.querySelector('[data-extra]')).not.toBeNull()
    dispose()
  })

  it('keeps an already injected extra action ahead of the rewind action', () => {
    const withExtra = memo(function WithExtra(): ReactNode {
      return createElement(Bubble, {
        text: ROW_TEXT,
        actions: () => createElement(ActionsRow, { extraActions: createElement('i', { 'data-existing': '' }) }),
      })
    })
    const ledger = new FakeLedger([{ component: withExtra, options: { key: 'user' } }])
    const dispose = installRowAction({
      slots: ledger,
      render: rewindActionRenderer(t, () => true, () => {}),
    })
    const container = render(ledger.store[0]!.component)
    expect(actionOrder(container)).toEqual(['copy', 'existing', 'action'])
    dispose()
  })

  it('leaves a row without an actions constructor untouched', () => {
    const ledger = new FakeLedger([{ component: rowWithoutActions, options: { key: 'user' } }])
    const dispose = installRowAction({ slots: ledger, render: () => createElement('i', { 'data-extra': '' }) })
    const container = render(ledger.store[0]!.component)
    expect(container.textContent).toContain('plain row')
    expect(container.querySelector('[data-extra]')).toBeNull()
    dispose()
  })

  it('leaves a row alone when the actions constructor returns a non-element', () => {
    const badActions = memo(function BadActions(): ReactNode {
      return createElement(Bubble, { text: ROW_TEXT, actions: () => 'not an element' })
    })
    const ledger = new FakeLedger([{ component: badActions, options: { key: 'user' } }])
    const dispose = installRowAction({ slots: ledger, render: () => createElement('i', { 'data-extra': '' }) })
    const container = render(ledger.store[0]!.component)
    expect(container.textContent).toContain('message body')
    expect(container.querySelector('[data-extra]')).toBeNull()
    dispose()
  })

  it('leaves a row alone when the node carries no rewind address', () => {
    const ledger = new FakeLedger([{ component: officialRow, options: { key: 'user' } }])
    const dispose = installRowAction({ slots: ledger, render: () => createElement('i', { 'data-extra': '' }) })
    const container = render(ledger.store[0]!.component, { sessionId: 's1', node: { kind: 'user', data: {} } })
    expect(container.querySelector('[data-copy]')).not.toBeNull()
    expect(container.querySelector('[data-extra]')).toBeNull()
    dispose()
  })

  it('skips entries it cannot render and rows of other kinds', () => {
    const ledger = new FakeLedger([
      { component: officialRow, options: { key: 'assistant' } },
      { component: { not: 'callable' }, options: { key: 'user' } },
    ])
    const dispose = installRowAction({ slots: ledger, render: () => createElement('i', { 'data-extra': '' }) })
    expect(ledger.store[0]!.component).toBe(officialRow)
    expect(ledger.store[1]!.component).toEqual({ not: 'callable' })
    dispose()
  })

  it('wraps an entry registered after the mount', () => {
    const ledger = new FakeLedger()
    const dispose = installRowAction({ slots: ledger, render: () => createElement('i', { 'data-extra': '' }) })
    ledger.store.push({ component: officialRow, options: { key: 'user' } })
    ledger.notify()
    expect(ledger.store[0]!.component).not.toBe(officialRow)
    expect(render(ledger.store[0]!.component).querySelector('[data-extra]')).not.toBeNull()
    dispose()
  })

  it('nudges the ledger version once per takeover so a mounted row re-reads its identity', () => {
    const ledger = new FakeLedger([{ component: officialRow, options: { key: 'user' } }])
    const dispose = installRowAction({ slots: ledger, render: () => null })
    expect(ledger.tickKeys).toHaveLength(1)
    // A later registration notification takes nothing over, so it must not nudge again.
    ledger.notify()
    expect(ledger.tickKeys).toHaveLength(1)
    dispose()
  })

  it('degrades to a no-op when the ledger exposes no entries', () => {
    expect(() => installRowAction({ slots: {}, render: () => null })()).not.toThrow()
  })
})

describe('teardown', () => {
  it('restores the official component identity and removes the action', () => {
    const ledger = new FakeLedger([{ component: officialRow, options: { key: 'user' } }])
    const disposal = installRowAction({ slots: ledger, render: () => createElement('i', { 'data-extra': '' }) })
    const wrapped = ledger.store[0]!.component
    const container = render(wrapped)
    expect(container.querySelector('[data-extra]')).not.toBeNull()

    disposal()
    expect(ledger.store[0]!.component).toBe(officialRow)
    const rerendered = render(officialRow)
    expect(rerendered.querySelector('[data-extra]')).toBeNull()
    expect(rerendered.querySelector('[data-copy]')).not.toBeNull()
  })

  it('restores only the identity it still owns', () => {
    // A later takeover of the same entry is not ours to undo.
    const ledger = new FakeLedger([{ component: officialRow, options: { key: 'user' } }])
    const disposal = installRowAction({ slots: ledger, render: () => null })
    const later = (): null => null
    ledger.store[0]!.component = later
    disposal()
    expect(ledger.store[0]!.component).toBe(later)
  })
})

describe('action eligibility', () => {
  it('renders nothing for a row whose session cannot rewind', () => {
    const ledger = new FakeLedger([{ component: officialRow, options: { key: 'user' } }])
    const dispose = installRowAction({
      slots: ledger,
      render: rewindActionRenderer(t, () => false, () => { throw new Error('must not open') }),
    })
    const container = render(ledger.store[0]!.component)
    expect(container.querySelector('[data-copy]')).not.toBeNull()
    expect(rewoundButton(container)).toBeNull()
    dispose()
  })
})
