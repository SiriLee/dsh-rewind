/**
 * @vitest-environment jsdom
 *
 * Client-plugin lifecycle wiring: the disposer `apply` yields is exactly what a
 * live disable runs. `tests/client-popover.test.ts` covers `closePopover`
 * itself; this file covers the WIRING — that the plugin's disposer calls it —
 * and the injected `<style data-plugin>` marker the harness reaps by.
 *
 * The client context is a hand fake with exactly the surface `apply` uses; a
 * mount that needs another service fails loudly. The configuration form is
 * served a minimal fake form (the card's own behaviour is covered by
 * `tests/client-settings-card.test.ts`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionFace } from '@deepseek-ai/dsh-api-session-controller/client'
import { apply, type ClientContext } from '../src/client/index.ts'
import { closePopover, openPopover, type PopoverOptions } from '../src/client/popover.ts'
import { CLASS } from '../src/client/styles.ts'

/** A disposer yielded by the plugin's lifecycle generator. */
type Disposer = () => unknown

/** What one mounted client plugin registered, plus its teardown. */
interface Mounted {
  readonly ctx: ClientContext
  /** Slot entries registered through `slots.register`, in order. */
  readonly slotEntries: readonly { readonly name: string; readonly id?: string; readonly key?: string }[]
  /** Commands the plugin decorated (`commandUi.decorate`). */
  readonly decorated: readonly string[]
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

/** Mount the client half on a minimal fake context. */
function mountClient(): Mounted {
  const disposers: Disposer[] = []
  const slotEntries: { name: string; id?: string; key?: string }[] = []
  const decorated: string[] = []
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
        subscribe: () => () => {},
        mutate: async () => true,
      }),
    },
    inject: () => {},
  } as unknown as ClientContext

  return {
    ctx,
    slotEntries,
    decorated,
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
    chatOf: () => undefined,
    watchChat: () => () => {},
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
  it('registers the rewind surface and decorates both commands', () => {
    const mounted = mountClient()
    apply(mounted.ctx)
    expect(mounted.slotEntries.map(entry => entry.name))
      .toEqual(['conversation.session.header.actions', 'plugins.bundle.config'])
    expect(mounted.slotEntries[0]?.id).toBe('dsh-rewind-portals')
    // The configuration form is keyed by the bundle's package name.
    expect(mounted.slotEntries[1]?.key).toBe('dsh-rewind-plugin')
    expect([...mounted.decorated].sort()).toEqual(['rewind', 'undo'])
    mounted.dispose()
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
