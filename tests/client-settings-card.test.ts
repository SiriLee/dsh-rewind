/**
 * @vitest-environment jsdom
 *
 * Unit tests for the client snapshot-cleanup configuration card
 * (src/client/settings-card.tsx). The staging model, the field controls, and
 * the form frame are the harness's own, so these probes pin what THIS card
 * owns: the two field specs, the labels map, the permission toggle's read of
 * the staged draft, and the write plan the shared model produces over a fake
 * entry form.
 *
 * Compilation: typechecked by `tsconfig.client-test.json` (client surface +
 * JSX); excluded from `tsconfig.json` (host, no JSX).
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

// jsdom + React act: the environment must opt in so act() does not warn.
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
import { PLUGIN_PACKAGE } from '../src/client/build-info.ts'
import {
  CLEANUP_ENTRY_ID,
  DEFAULT_MAX_AGE_DAYS,
  SettingsCleanupCard,
  cleanupForm,
  formLabels,
  type CleanupFormScope,
  type CleanupPolicy,
} from '../src/client/settings-card.tsx'

const t = (key: string): string => key

/** The composition (base) layer the fake host resolves under the user layer. */
const BASE = { enabled: false, maxAgeDays: 30 } as const

/** One recorded entry write. */
type Write = { readonly op: 'set' | 'unset'; readonly path: readonly string[]; readonly value?: unknown }

/** One raw stored field value as the fake entry form holds it. */
type UserValue = boolean | number

/**
 * A fake per-entry configuration form: it resolves the effective value as
 * `base ⊕ user`, and answers `mutate` with a read-back (a rejected write leaves
 * the user layer untouched).
 */
function fakeForm(options: {
  readonly user?: Partial<Record<keyof CleanupPolicy, UserValue>>
  readonly status?: 'loading' | 'ready' | 'unavailable'
  readonly writable?: boolean
  readonly rejectPath?: string
} = {}) {
  let user: Record<string, UserValue> = { ...options.user }
  const listeners = new Set<() => void>()
  const writes: Write[] = []
  const notify = () => { for (const cb of listeners) cb() }
  const scope: CleanupFormScope<CleanupPolicy> = {
    getSnapshot: () => ({
      status: options.status ?? 'ready',
      value: { ...BASE, ...user },
      base: BASE,
      user: { ...user },
      writable: options.writable !== false,
      revision: 1,
    }),
    subscribe: (cb) => { listeners.add(cb); return () => { listeners.delete(cb) } },
    mutate: async (ops) => {
      for (const op of ops) {
        writes.push({ op: op.op, path: op.path, ...(op.op === 'set' ? { value: op.value } : {}) })
        if (options.rejectPath !== undefined && op.path[0] === options.rejectPath) return false
        if (op.op === 'set') user = { ...user, [op.path[0]!]: op.value as UserValue }
        else delete user[op.path[0]!]
      }
      notify()
      return true
    },
  }
  return { scope, writes }
}

/** The mounted card root; null between tests. */
let host: Root | null = null

/** Unmount the current root inside `act`, so React's cleanup is not a stray update. */
function unmount(): void {
  const root = host
  host = null
  if (root !== null) act(() => { root.unmount() })
}
afterEach(() => { unmount() })

/** Mount the card through its form bundle, exactly as the slot registration does. */
function mount(options: Parameters<typeof fakeForm>[0] = {}, view: 'summary' | 'page' = 'page') {
  const { scope, writes } = fakeForm(options)
  const { form, store, labels } = cleanupForm(scope, t)
  const el = document.createElement('div')
  document.body.appendChild(el)
  host = createRoot(el)
  // Bridge the store's subscription to a re-render, the way the slot
  // renderer's selector hook does on a real Plugins page.
  const render = () => {
    act(() => {
      host!.render(createElement(SettingsCleanupCard, {
        view,
        t,
        hooks: { cleanupCard: store },
        ...form.actions(),
      }))
    })
  }
  const off = store.subscribe(render)
  render()
  return {
    root: el,
    writes,
    form,
    labels,
    unmount: () => { off(); unmount() },
    switch: () => el.querySelector<HTMLButtonElement>('[role="switch"]'),
    input: () => el.querySelector<HTMLInputElement>('input'),
    save: () => Array.from(el.querySelectorAll('button')).find(b => b.textContent === 'cleanup.save'),
    reset: () => Array.from(el.querySelectorAll('button')).find(b => b.textContent === 'cleanup.reset'),
    discard: () => Array.from(el.querySelectorAll('button')).find(b => b.textContent === 'discard'),
  }
}

/**
 * Drive the field's change handler the way its controlled input does in the
 * browser: jsdom does not run React's delegated change plugin, so the handler
 * is read off the element's React props.
 */
function typeInto(el: HTMLInputElement, value: string): void {
  const key = Object.keys(el).find(name => name.startsWith('__reactProps'))
  const props = key === undefined
    ? undefined
    : (el as unknown as Record<string, { onChange?: (event: { target: { value: string } }) => void }>)[key]
  const onChange = props?.onChange
  if (onChange === undefined) throw new Error('input has no React onChange')
  act(() => { onChange({ target: { value } }) })
}

const click = (el: Element | null | undefined): void => {
  act(() => { el?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

describe('field specs (what this card adds to the harness form model)', () => {
  it('stages the toggle as a set, never a clear', async () => {
    const view = mount()
    expect(view.switch()?.getAttribute('aria-checked')).toBe('false')
    click(view.switch())
    expect(view.switch()?.getAttribute('aria-checked')).toBe('true')
    click(view.save())
    await vi.waitFor(() => { expect(view.writes).toHaveLength(1) })
    expect(view.writes).toEqual([{ op: 'set', path: ['enabled'], value: true }])
  })

  it('blocks the whole save on an unparsable day count (the number field spec)', async () => {
    const view = mount()
    click(view.switch()) // enable, so the numeric field renders
    typeInto(view.input()!, 'abc')
    // One invalid draft refuses the save, so even the valid toggle edit is not
    // written (the official guard: a save never drops a staged edit).
    click(view.save())
    await Promise.resolve()
    expect(view.writes).toEqual([])
    expect(view.form.field('maxAgeDays').invalid).toBe(true)
  })

  it('passes a zero day count to the host, whose schema is the authority', async () => {
    // The shared number field accepts any finite number; the positive-integer
    // rule lives in the host's `Config` schema, so a refused write is reported
    // as a save failure rather than pre-blocked in the UI.
    const view = mount()
    click(view.switch())
    typeInto(view.input()!, '0')
    click(view.save())
    await vi.waitFor(() => { expect(view.writes).toContainEqual({ op: 'set', path: ['maxAgeDays'], value: 0 }) })
  })

  it('treats an empty draft as a clear', async () => {
    const view = mount({ user: { maxAgeDays: 7 } })
    click(view.switch())
    typeInto(view.input()!, '')
    click(view.save())
    await vi.waitFor(() => { expect(view.writes).toContainEqual({ op: 'unset', path: ['maxAgeDays'] }) })
  })

  it('resets an overridden day count to the inherited value', async () => {
    // The official field renders its reset control only while the user layer
    // carries the field; resetting stages a clear so the value re-inherits.
    const view = mount({ user: { enabled: true, maxAgeDays: 7 } })
    expect(view.input()?.value).toBe('7')
    click(view.reset())
    expect(view.input()?.value).toBe(String(BASE.maxAgeDays))
    click(view.save())
    await vi.waitFor(() => { expect(view.writes).toContainEqual({ op: 'unset', path: ['maxAgeDays'] }) })
  })

  it('drops every staged edit on discard', () => {
    const view = mount()
    click(view.switch())
    expect(view.switch()?.getAttribute('aria-checked')).toBe('true')
    click(view.discard())
    expect(view.switch()?.getAttribute('aria-checked')).toBe('false')
    expect(view.writes).toEqual([])
  })
})

describe('SettingsCleanupCard', () => {
  it('renders nothing for the summary view the page only uses for one-liners', () => {
    const view = mount({}, 'summary')
    expect(view.root.textContent).toBe('')
    expect(view.root.querySelector('[role="switch"]')).toBeNull()
  })

  it('replaces the form with the unavailable line when the entry is not served', () => {
    const view = mount({ status: 'unavailable' })
    expect(view.root.textContent).toBe('cleanup.unavailable')
    expect(view.root.querySelector('[role="switch"]')).toBeNull()
  })

  it('shows the day field only while the toggle reads on', () => {
    const off = mount({ user: { enabled: false } })
    expect(off.switch()?.getAttribute('aria-checked')).toBe('false')
    expect(off.input()).toBeNull()
    off.unmount()

    const on = mount({ user: { enabled: true } })
    expect(on.switch()?.getAttribute('aria-checked')).toBe('true')
    expect(on.input()).not.toBeNull()
  })

  it('disables every control on a read-only document', () => {
    const view = mount({ writable: false, user: { enabled: true } })
    expect(view.switch()?.disabled).toBe(true)
    expect(view.input()?.disabled).toBe(true)
    expect(view.root.textContent).toContain('cleanup.readonly')
  })

  it('keeps the drafts and reports the failure when a write does not land', async () => {
    const view = mount({ rejectPath: 'enabled' })
    click(view.switch())
    click(view.save())
    await vi.waitFor(() => { expect(view.root.textContent).toContain('cleanup.saveFailed') })
    // The draft survives: the toggle still reads the staged value.
    expect(view.switch()?.getAttribute('aria-checked')).toBe('true')
  })
})

describe('client constants and labels', () => {
  it('identifies the bundle entry exactly as package.json does', () => {
    // Two consumers depend on this one identity: the profile entry id the host
    // resolves the configuration under, and the `plugins.bundle.config` key the
    // Plugins page dispatches a bundle's form by.
    const root = join(dirname(fileURLToPath(import.meta.url)), '..')
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name: string }
    expect(CLEANUP_ENTRY_ID).toBe(pkg.name)
    expect(CLEANUP_ENTRY_ID).toBe(PLUGIN_PACKAGE)
    expect(CLEANUP_ENTRY_ID).toBe('dsh-rewind-plugin')
  })

  it('pins the placeholder default the host schema applies', () => {
    // The card cannot import the host module, so it copies the default; the host
    // suite pins the same value from the other side.
    expect(DEFAULT_MAX_AGE_DAYS).toBe(30)
  })

  it('maps every label the shared form frame asks for', () => {
    expect(formLabels(t)).toEqual({
      unavailable: 'cleanup.unavailable',
      readOnly: 'cleanup.readonly',
      saveFailed: 'cleanup.saveFailed',
      save: 'cleanup.save',
      saving: 'cleanup.saving',
    })
  })
})
