/**
 * @vitest-environment jsdom
 *
 * Client-plugin lifecycle wiring: the disposer `apply` yields is exactly what a
 * live disable runs. `tests/client-popover.test.ts` covers `closePopover`
 * itself; this file covers the WIRING — the disposer calling it, the injected
 * `<style data-plugin>` marker the harness reaps by, the Chat-row takeover and
 * its restore, and the action's click → mode-popover path.
 *
 * The client context is a hand fake with exactly the surface `apply` uses; a
 * mount that needs another service fails loudly. The configuration form is
 * served a minimal fake form (the card's own behaviour is covered by
 * `tests/client-settings-card.test.ts`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { SessionFace } from '@deepseek-ai/dsh-api-session-controller/client'

// jsdom + React act: the environment must opt in so act() does not warn.
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { apply, type ClientContext } from '../src/client/index.ts'
import { closePopover, openPopover, type PopoverOptions } from '../src/client/popover.ts'
import { isRewindInertSession } from '../src/client/rewind-flow.ts'
import { CLASS } from '../src/client/styles.ts'
import { officialRow, ROW_PROPS, ROW_TEXT } from './support/chat-row.ts'

/** A disposer yielded by the plugin's lifecycle generator. */
type Disposer = () => unknown

/** What one mounted client plugin registered, plus its teardown. */
interface Mounted {
  readonly ctx: ClientContext
  /** Slot entries registered through `slots.register`, in order. */
  readonly slotEntries: readonly { readonly name: string; readonly id?: string; readonly key?: string }[]
  /** Commands the plugin decorated (`commandUi.decorate`). */
  readonly decorated: readonly string[]
  /** Subscriptions the cleanup form opened on its configuration scope. */
  readonly formSubscriptions: () => number
  /** Releases of those subscriptions (the model's `dispose`). */
  readonly formUnsubscriptions: () => number
  /** Run every disposer in reverse registration order, as a fiber does. */
  dispose(): void
}

/** Drive one `ctx.effect` callback: a disposer-returning function or a generator. */
function collect(fn: unknown, into: Disposer[]): void {
  if (typeof fn !== 'function') return
  const result = (fn as () => unknown)()
  if (typeof result === 'function') {
    into.push(result as Disposer)
    return
  }
  const next = (result as { next?: unknown } | null)?.next
  if (typeof next !== 'function') return
  const it = result as Iterator<unknown>
  for (;;) {
    const step = it.next()
    if (step.done === true) break
    if (typeof step.value === 'function') into.push(step.value as Disposer)
  }
}

/** One Chat-row ledger entry the mount can take over. */
interface FakeNodeEntry {
  component: unknown
  readonly options: { readonly key?: string }
}

/** Mount the client half on a minimal fake context. */
function mountClient(nodes: FakeNodeEntry[] = []): Mounted {
  const disposers: Disposer[] = []
  const slotEntries: { name: string; id?: string; key?: string }[] = []
  const decorated: string[] = []
  // The cleanup form's subscription to its configuration scope: the plugin must
  // release it on unload, so both ends are counted.
  const subscribeScope = vi.fn(() => () => {})
  const unsubscribeScope = vi.fn(() => {})
  const locale = {
    register: () => () => {},
    bind: () => (key: string) => key,
    subscribe: () => () => {},
  }
  const slots = {
    inject: (_name: string, install: () => () => void) => {
      const off = install()
      if (typeof off === 'function') disposers.push(off)
      return off
    },
    register: (entry: { name: string; id?: string; key?: string }) => {
      slotEntries.push(entry)
      return () => {}
    },
    // The Chat-row ledger the A2 mount reads and ticks. Empty by default, so
    // the baseline mount stays button-free and registers nothing extra.
    entries: (key: string) => (key === 'conversation.chat.node' ? nodes : []),
    subscribe: () => () => {},
  }
  const ctx = {
    effect: (fn: unknown) => { collect(fn, disposers); return () => {} },
    locale,
    slots,
    sessions: {
      binding: () => undefined,
      list: { getSnapshot: () => ({ ids: [], byId: {}, phase: 'ready' }) },
    },
    get: (name: string) => (name === 'commandUi'
      ? { decorate: (spec: { name: string }) => { decorated.push(spec.name); return () => {} } }
      : undefined),
    // The per-entry configuration form the cleanup card stages over. A minimal
    // read/write face is enough for the registration probe; the card's own
    // behaviour is covered by tests/client-settings-card.test.ts.
    configForms: {
      get: () => ({
        getSnapshot: () => ({ status: 'ready', value: undefined, base: {}, user: {}, writable: true, revision: 0 }),
        subscribe: (cb: () => void) => {
          subscribeScope()
          return () => { unsubscribeScope(); void cb }
        },
        mutate: async () => true,
      }),
    },
    inject: () => {},
  } as unknown as ClientContext

  return {
    ctx,
    slotEntries,
    decorated,
    formSubscriptions: () => subscribeScope.mock.calls.length,
    formUnsubscriptions: () => unsubscribeScope.mock.calls.length,
    dispose: () => {
      for (const dispose of disposers.splice(0).reverse()) void dispose()
    },
  }
}

/** A session face the popover's background preview probe can settle against. */
function fakeSession(): SessionFace {
  return {
    sessionId: 's1',
    command: vi.fn(async () => ({ ok: true, value: { matched: false } })),
    subscribe: vi.fn(() => () => {}),
    getSnapshot: vi.fn(() => ({ subagent: null })),
  } as unknown as SessionFace
}

/** Open the durable mode popover against `session` (no DOM rows needed). */
function open(session: SessionFace, t: PopoverOptions['t']): void {
  openPopover({
    session,
    seq: 5,
    time: 0,
    preview: 'hello',
    anchor: document.body,
    t,
    onRewind: () => {},
  })
}

afterEach(() => {
  closePopover()
  document.body.innerHTML = ''
  document.head.querySelectorAll('style[data-plugin]').forEach(node => { node.remove() })
  vi.restoreAllMocks()
})

describe('client plugin lifecycle', () => {
  it('registers only the configuration card and decorates both commands', () => {
    const mounted = mountClient()
    apply(mounted.ctx)
    // The plugin REGISTERS no conversation slot: the per-message action lives in
    // the official rows' own actions row through the component takeover below,
    // so without a Chat-row ledger the only slot entry is the configuration
    // card, keyed by the bundle's package name.
    expect(mounted.slotEntries.map(entry => entry.name)).toEqual(['plugins.bundle.config'])
    expect(mounted.slotEntries[0]?.key).toBe('dsh-rewind-plugin')
    expect([...mounted.decorated].sort()).toEqual(['rewind', 'undo'])
    mounted.dispose()
  })

  it('takes over the user and steering row renderers and restores them on unload', () => {
    // The A2 action is a child of the official actions row, so the plugin
    // replaces the two row component identities in the ledger — and must give
    // them back exactly, leaving other kinds alone.
    const officialUser = (): null => null
    const officialSteering = (): null => null
    const assistant = (): null => null
    const nodes: FakeNodeEntry[] = [
      { component: officialUser, options: { key: 'user' } },
      { component: assistant, options: { key: 'assistant-step' } },
      { component: officialSteering, options: { key: 'steering' } },
    ]
    const mounted = mountClient(nodes)
    apply(mounted.ctx)
    expect(nodes[0]!.component).not.toBe(officialUser)
    expect(nodes[2]!.component).not.toBe(officialSteering)
    expect(nodes[1]!.component).toBe(assistant)
    mounted.dispose()
    expect(nodes[0]!.component).toBe(officialUser)
    expect(nodes[2]!.component).toBe(officialSteering)
  })

  it('keeps the rest of the plugin alive when the Chat-row ledger throws', () => {
    // The action mount is the only surface allowed to fail on its own: a ledger
    // whose shape drifted must cost the button, not the command decoration or
    // the visibility layer.
    const mounted = mountClient()
    ;(mounted.ctx.slots as { entries: () => never }).entries = () => {
      throw new Error('ledger shape drift')
    }
    vi.spyOn(console, 'error').mockReturnValue(undefined)
    expect(() => { apply(mounted.ctx) }).not.toThrow()
    expect([...mounted.decorated].sort()).toEqual(['rewind', 'undo'])
    expect(document.head.querySelector('style[data-plugin="dsh-rewind-plugin"]')).not.toBeNull()
    mounted.dispose()
  })

  it('opens the mode popover for the row that owns the clicked action', () => {
    // The end-to-end wiring of the new surface: takeover -> render -> click ->
    // the same popover the `/rewind` flow opens, carrying this row's target.
    vi.spyOn(console, 'warn').mockReturnValue(undefined)
    const nodes: FakeNodeEntry[] = [{ component: officialRow, options: { key: 'user' } }]
    const mounted = mountClient(nodes)
    // The row's props name its session; the action resolves the live face.
    ;(mounted.ctx.sessions as unknown as { binding: (id: string) => unknown }).binding =
      () => ({ session: fakeSession() })
    apply(mounted.ctx)

    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    act(() => { root.render(createElement(nodes[0]!.component as () => ReactNode, ROW_PROPS)) })
    const button = container.querySelector<HTMLButtonElement>('button.dsh-rewind-action')
    expect(button?.getAttribute('aria-label')).toBe('button.aria')

    act(() => { button!.click() })
    expect(document.querySelector(`.${CLASS.popover}`)).not.toBeNull()
    expect(document.querySelector(`.${CLASS.popoverTarget}`)?.textContent).toBe(ROW_TEXT)
    expect(button?.getAttribute('aria-expanded')).toBe('true')

    act(() => { root.unmount() })
    mounted.dispose()
  })

  it('releases the configuration form subscription on unload', () => {
    // The staged form model subscribes to its entry's shared form on
    // construction; a fiber that unmounts must release it instead of leaving the
    // card's listener reachable through the scope.
    const mounted = mountClient()
    apply(mounted.ctx)
    expect(mounted.formSubscriptions()).toBe(1)
    expect(mounted.formUnsubscriptions()).toBe(0)
    mounted.dispose()
    expect(mounted.formUnsubscriptions()).toBe(1)
  })

  it('injects its styles under the package identity the harness reaps by', () => {
    const mounted = mountClient()
    apply(mounted.ctx)
    // The owned-style fallback matches `data-plugin` against the loader row id.
    expect(document.head.querySelector('style[data-plugin="dsh-rewind-plugin"]')).not.toBeNull()
    mounted.dispose()
    expect(document.head.querySelector('style[data-plugin="dsh-rewind-plugin"]')).toBeNull()
  })

  it('closes an open mode popover when the plugin is unloaded', () => {
    vi.spyOn(console, 'warn').mockReturnValue(undefined)
    const mounted = mountClient()
    apply(mounted.ctx)
    const t = ((key: string) => key) as unknown as PopoverOptions['t']
    open(fakeSession(), t)
    expect(document.querySelector(`.${CLASS.popover}`)).not.toBeNull()

    // Exactly what a live disable runs.
    mounted.dispose()
    expect(document.querySelector(`.${CLASS.popover}`)).toBeNull()
  })
})

describe('rewind-inert gate', () => {
  it('treats a direct-subagent session as inert and a plain session as usable', () => {
    expect(isRewindInertSession({ subagent: null })).toBe(false)
    expect(isRewindInertSession({ subagent: undefined })).toBe(false)
    expect(isRewindInertSession({ subagent: { address: { mode: 'continuable' } } })).toBe(true)
  })
})
