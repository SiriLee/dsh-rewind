/**
 * @vitest-environment jsdom
 *
 * Unit tests for the client snapshot-cleanup configuration form
 * (src/client/settings-card.tsx): the pure staging/shell helpers and the React
 * form's behaviour.
 *
 * The form re-implements the harness's own `CardForm` + `ValueField` +
 * `PluginConfigForm` (those are package-internal), so these probes pin THEIR
 * semantics rather than an invented model: `overridden` previews what a save
 * would leave, `dirty`/`invalid` come from the plan, a reset stages a clear
 * whose text is the COMPOSITION value, an empty numeric draft means "use the
 * default", a failed save keeps the drafts, and an unavailable namespace
 * replaces the form with one status line.
 *
 * Compilation: typechecked by `tsconfig.client-test.json` (client surface +
 * JSX); excluded from `tsconfig.json` (host, no JSX).
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

// jsdom + React act: the environment must opt in so act() does not warn.
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
import { PLUGIN_PACKAGE } from '../src/client/build-info.ts'
import {
  SettingsCleanupCard,
  CLEANUP_SETTINGS_NAMESPACE,
  DEFAULT_MAX_AGE_DAYS,
  formatEnabled,
  formatMaxAge,
  invalidOf,
  overriddenOf,
  parseEnabled,
  parseMaxAge,
  planOf,
  shellOf,
  textOf,
  type CleanupCardApi,
  type CleanupField,
  type CleanupFieldReads,
  type CleanupValue,
  type StagedEdits,
} from '../src/client/settings-card.tsx'

const t = (key: string): string => key

/** The composition (base) layer the fake host resolves under the user layer. */
const BASE = { enabled: false, maxAgeDays: 30 } as const

/** Build a staged map from entries, in the order given. */
function stagedOf(...entries: readonly (readonly [CleanupField, string, boolean?])[]): StagedEdits {
  return new Map(entries.map(([field, text, clear]) => [field, { text, clear: clear === true }]))
}

/** The reads callback for one fixed {value, stored} pair per field. */
function readsOf(table: Partial<Record<CleanupField, { value: CleanupValue; stored: boolean }>>) {
  return (field: CleanupField) => table[field] ?? { value: undefined, stored: false }
}

describe('field specs (the official per-field parse/format)', () => {
  it('parses a positive integer, and an EMPTY draft as a clear', () => {
    // numberField: an empty draft clears, so leaving the control blank
    // re-inherits the default instead of blocking the save.
    expect(parseMaxAge('')).toEqual({ kind: 'clear' })
    expect(parseMaxAge('   ')).toEqual({ kind: 'clear' })
    expect(parseMaxAge('30')).toEqual({ kind: 'set', value: 30 })
    expect(parseMaxAge(' 5 ')).toEqual({ kind: 'set', value: 5 })
  })

  it('rejects the drafts the host schema would refuse', () => {
    for (const text of ['0', '-1', '2.5', '1e3', 'abc']) expect(parseMaxAge(text)).toBeUndefined()
  })

  it('formats stored values as draft text', () => {
    expect(formatMaxAge(30)).toBe('30')
    expect(formatMaxAge(undefined)).toBe('')
    expect(formatEnabled(true)).toBe('true')
    expect(formatEnabled(undefined)).toBe('false')
  })

  it('never clears the switch (the official control is two-state)', () => {
    expect(parseEnabled('true')).toEqual({ kind: 'set', value: true })
    expect(parseEnabled('false')).toEqual({ kind: 'set', value: false })
  })
})

describe('field state (the official field())', () => {
  const stored: CleanupFieldReads = { value: 45, stored: true }
  const inherited: CleanupFieldReads = { value: 30, stored: false }

  it('shows the effective value when nothing is staged', () => {
    expect(textOf('maxAgeDays', stagedOf(), stored)).toBe('45')
    expect(overriddenOf('maxAgeDays', stagedOf(), stored)).toBe(true)
    expect(overriddenOf('maxAgeDays', stagedOf(), inherited)).toBe(false)
    expect(invalidOf('maxAgeDays', stagedOf())).toBe(false)
  })

  it('lets a staged set answer for itself (the badge previews the save)', () => {
    // The field is NOT overridden yet, but saving would leave an override — the
    // official badge previews the save rather than the current document.
    const staged = stagedOf(['maxAgeDays', '7'])
    expect(textOf('maxAgeDays', staged, inherited)).toBe('7')
    expect(overriddenOf('maxAgeDays', staged, inherited)).toBe(true)
    expect(overriddenOf('maxAgeDays', staged, stored)).toBe(true)
  })

  it('answers false for a staged clear, and never marks it invalid', () => {
    const staged = stagedOf(['maxAgeDays', '30', true])
    expect(textOf('maxAgeDays', staged, stored)).toBe('30')
    expect(overriddenOf('maxAgeDays', staged, stored)).toBe(false)
    expect(invalidOf('maxAgeDays', staged)).toBe(false)
  })

  it('marks an unparseable draft invalid and not overridden', () => {
    const staged = stagedOf(['maxAgeDays', 'abc'])
    expect(invalidOf('maxAgeDays', staged)).toBe(true)
    expect(overriddenOf('maxAgeDays', staged, stored)).toBe(false)
  })
})

describe('the save plan (the official plan())', () => {
  const stored = readsOf({ maxAgeDays: { value: 45, stored: true } })
  const inherited = readsOf({ maxAgeDays: { value: 30, stored: false } })

  it('plans nothing when nothing is staged', () => {
    expect(planOf(stagedOf(), stored)).toEqual([])
  })

  it('plans only a real change', () => {
    expect(planOf(stagedOf(['maxAgeDays', '7']), stored))
      .toEqual([{ field: 'maxAgeDays', kind: 'set', value: 7 }])
    // Editing back to the effective value is not an edit.
    expect(planOf(stagedOf(['maxAgeDays', '45']), stored)).toEqual([])
  })

  it('plans a clear only when the user layer actually carries the field', () => {
    expect(planOf(stagedOf(['maxAgeDays', '30', true]), stored))
      .toEqual([{ field: 'maxAgeDays', kind: 'clear' }])
    expect(planOf(stagedOf(['maxAgeDays', '30', true]), inherited)).toEqual([])
    // An EMPTY draft is a clear too (the numberField spec).
    expect(planOf(stagedOf(['maxAgeDays', '']), stored))
      .toEqual([{ field: 'maxAgeDays', kind: 'clear' }])
  })

  it('keeps an invalid draft in the plan so the save refuses instead of dropping it', () => {
    expect(planOf(stagedOf(['maxAgeDays', 'abc']), stored))
      .toEqual([{ field: 'maxAgeDays', kind: 'invalid' }])
  })

  it('keeps the staging order', () => {
    const plan = planOf(
      stagedOf(['enabled', 'true'], ['maxAgeDays', '7']),
      readsOf({ enabled: { value: false, stored: false }, maxAgeDays: { value: 45, stored: true } }),
    )
    expect(plan.map(entry => entry.field)).toEqual(['enabled', 'maxAgeDays'])
  })
})

describe('the shell (the official shell())', () => {
  const flags = { saving: false, failed: false }
  it('derives dirty and invalid from the plan', () => {
    expect(shellOf([], flags)).toEqual({ dirty: false, invalid: false, saving: false, failed: false })
    expect(shellOf([{ field: 'maxAgeDays', kind: 'set', value: 7 }], flags))
      .toMatchObject({ dirty: true, invalid: false })
    // An invalid entry is still an edit (dirty) AND blocks the save.
    expect(shellOf([{ field: 'maxAgeDays', kind: 'invalid' }], flags))
      .toMatchObject({ dirty: true, invalid: true })
    expect(shellOf([], { saving: true, failed: true })).toMatchObject({ saving: true, failed: true })
  })
})

describe('client constants', () => {
  it('pins the settings namespace to the host-verified literal', () => {
    expect(CLEANUP_SETTINGS_NAMESPACE).toBe('dsh-rewind-snapshot-cleanup')
    expect(CLEANUP_SETTINGS_NAMESPACE).toMatch(/^[a-z][a-z0-9-]*$/)
  })

  it('pins the default it duplicates from the Host policy', () => {
    // The card cannot import the host module, so it copies the default; the host
    // suite pins the same literal. Drift would show a placeholder that is not
    // the value an empty draft actually falls back to.
    expect(DEFAULT_MAX_AGE_DAYS).toBe(30)
  })

  it('identifies the bundle exactly as package.json does', () => {
    // Three consumers depend on this one identity: the client entry id the
    // loader registers, the `plugins.bundle.config` key the Plugins page
    // dispatches a bundle's form by, and the `data-plugin` marker the
    // harness's owned-style fallback matches.
    const root = join(dirname(fileURLToPath(import.meta.url)), '..')
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name: string }
    expect(PLUGIN_PACKAGE).toBe(pkg.name)
    expect(PLUGIN_PACKAGE).toBe('dsh-rewind-plugin')
  })
})

/** One recorded host write. */
type HostWrite = { readonly op: 'set' | 'unset'; readonly field: CleanupField; readonly value?: CleanupValue }

/**
 * A fake settings scope: it resolves the effective value as `base ⊕ user`, and
 * answers every write with the read-back the official `CardForm` checks (a
 * rejected write leaves the user layer untouched).
 */
function fakeApi(options: {
  readonly user?: Partial<Record<CleanupField, CleanupValue>>
  readonly status?: 'loading' | 'ready' | 'unavailable'
  readonly writable?: boolean
  readonly reject?: CleanupField
} = {}) {
  let user: Partial<Record<CleanupField, CleanupValue>> = { ...options.user }
  const listeners = new Set<() => void>()
  const writes: HostWrite[] = []
  const notify = () => { for (const cb of listeners) cb() }
  const api: CleanupCardApi = {
    available: () => (options.status ?? 'ready') === 'ready',
    writable: () => options.writable !== false,
    read: (field) => ({ ...BASE, ...user })[field],
    base: (field) => BASE[field],
    stored: (field) => Object.hasOwn(user, field),
    set: async (field, value) => {
      writes.push({ op: 'set', field, value })
      if (options.reject === field) return false
      user = { ...user, [field]: value }
      notify()
      return user[field] === value
    },
    unset: async (field) => {
      writes.push({ op: 'unset', field })
      if (options.reject === field) return false
      const next = { ...user }
      delete next[field]
      user = next
      notify()
      return !Object.hasOwn(user, field)
    },
    subscribe: (cb) => { listeners.add(cb); return () => { listeners.delete(cb) } },
  }
  return { api, writes }
}

/** Unmount the current root inside `act`, so React's cleanup is not a stray update. */
function unmount(): void {
  const root = host
  host = null
  if (root !== null) act(() => { root.unmount() })
}

let host: Root | null = null
afterEach(() => { unmount() })

const findButton = (el: Element, label: string): HTMLButtonElement | undefined =>
  Array.from(el.querySelectorAll('button')).find((b) => b.textContent === label)

/** Mount the form under jsdom and return the root + helper finders. */
function mount(api: CleanupCardApi, view: 'summary' | 'page' = 'page') {
  const el = document.createElement('div')
  document.body.appendChild(el)
  host = createRoot(el)
  act(() => { host!.render(createElement(SettingsCleanupCard, { api, t, view })) })
  return {
    root: el,
    unmount,
    switch: () => el.querySelector<HTMLButtonElement>('[role="switch"]'),
    input: () => el.querySelector<HTMLInputElement>('#dsh-rewind-cleanup-maxage'),
    message: () => el.querySelector<HTMLParagraphElement>('#dsh-rewind-cleanup-maxage-message'),
    save: () => findButton(el, 'cleanup.save'),
    reset: () => findButton(el, 'cleanup.reset'),
  }
}

/** Drive a controlled <input> value change the way React expects in jsdom. */
function setText(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  setter?.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('SettingsCleanupCard', () => {
  it('renders nothing for the summary view the page only uses for one-liners', () => {
    const view = mount(fakeApi().api, 'summary')
    expect(view.root.textContent).toBe('')
    expect(view.root.querySelector('[role="switch"]')).toBeNull()
  })

  it('replaces the whole form with the unavailable line when the namespace is not served', () => {
    // The official shell treats a still-loading namespace as unavailable too.
    const view = mount(fakeApi({ status: 'loading' }).api)
    expect(view.root.textContent).toBe('cleanup.unavailable')
    expect(view.switch()).toBeNull()
    expect(view.save()).toBeUndefined()
  })

  it('says so, and disables every control, on a read-only settings source', () => {
    const view = mount(fakeApi({ user: { enabled: true, maxAgeDays: 7 }, writable: false }).api)
    expect(view.root.textContent).toContain('cleanup.readonly')
    expect(view.switch()?.disabled).toBe(true)
    expect(view.input()?.disabled).toBe(true)
    // Not dirty either, so the save is blocked by the official `!dirty` term.
    expect(view.save()?.disabled).toBe(true)
  })

  it('hides the max-age field while the switch is off, and shows it when on', () => {
    const off = mount(fakeApi().api)
    expect(off.switch()?.getAttribute('aria-checked')).toBe('false')
    expect(off.root.textContent).toContain('cleanup.auto.off')
    expect(off.input()).toBeNull()
    off.unmount()

    const on = mount(fakeApi({ user: { enabled: true, maxAgeDays: 30 } }).api)
    expect(on.switch()?.getAttribute('aria-checked')).toBe('true')
    expect(on.root.textContent).toContain('cleanup.auto.on')
    expect(on.input()?.value).toBe('30')
    // The message paragraph is wired to the input the official way.
    expect(on.input()?.getAttribute('aria-describedby')).toBe('dsh-rewind-cleanup-maxage-message')
    expect(on.message()?.textContent).toBe('cleanup.maxAge.hint')
  })

  it('shows the overridden badge and reset for a staged set, before any save', () => {
    // The field is inherited (not stored) but saving WOULD leave an override.
    const { api } = fakeApi()
    const view = mount(api)
    act(() => { view.switch()?.click() })
    expect(view.root.textContent).not.toContain('cleanup.overridden')
    act(() => { setText(view.input()!, '7') })
    expect(view.root.textContent).toContain('cleanup.overridden')
    expect(view.reset()).toBeDefined()
  })

  it('stages a reset whose text is the COMPOSITION value', () => {
    const { api } = fakeApi({ user: { enabled: true, maxAgeDays: 45 } })
    const view = mount(api)
    expect(view.input()?.value).toBe('45')
    act(() => { view.reset()?.click() })
    // The official resetField shows what the field reverts to, immediately and
    // without writing.
    expect(view.input()?.value).toBe('30')
    expect(view.root.textContent).not.toContain('cleanup.overridden')
    expect(view.save()?.disabled).toBe(false)
  })

  it('blocks the save on an invalid draft and wires the invalid copy', () => {
    const { api } = fakeApi({ user: { enabled: true, maxAgeDays: 30 } })
    const view = mount(api)
    act(() => { setText(view.input()!, 'abc') })
    expect(view.input()?.getAttribute('aria-invalid')).toBe('true')
    expect(view.message()?.textContent).toBe('cleanup.invalid')
    expect(view.save()?.disabled).toBe(true)
  })

  it('treats an empty draft as a clear (the numberField spec)', async () => {
    const { api, writes } = fakeApi({ user: { enabled: true, maxAgeDays: 45 } })
    const view = mount(api)
    act(() => { setText(view.input()!, '') })
    expect(view.input()?.getAttribute('aria-invalid')).toBeNull()
    expect(view.save()?.disabled).toBe(false)
    await act(async () => { view.save()?.click() })
    expect(writes).toEqual([{ op: 'unset', field: 'maxAgeDays' }])
    // The read-back re-renders the effective (inherited) value.
    expect(view.input()?.value).toBe('30')
  })

  it('stages without writing, then writes every field in order and drops the drafts', async () => {
    const { api, writes } = fakeApi({ user: { maxAgeDays: 45 } })
    const view = mount(api)
    act(() => { view.switch()?.click() })
    expect(view.switch()?.getAttribute('aria-checked')).toBe('true')
    expect(view.save()?.disabled).toBe(false)
    act(() => { setText(view.input()!, '7') })
    expect(writes).toHaveLength(0) // staged, never written before the save
    await act(async () => { view.save()?.click() })
    expect(writes).toEqual([
      { op: 'set', field: 'enabled', value: true },
      { op: 'set', field: 'maxAgeDays', value: 7 },
    ])
    expect(view.input()?.value).toBe('7')
    // The write landed, so the field now really is overridden: the badge stays
    // and only the drafts are gone (the save button is clean again).
    expect(view.root.textContent).toContain('cleanup.overridden')
    expect(view.save()?.disabled).toBe(true)
  })

  it('keeps the drafts and shows the fixed failure line when a write does not land', async () => {
    const { api } = fakeApi({ user: { enabled: true, maxAgeDays: 30 }, reject: 'maxAgeDays' })
    const view = mount(api)
    act(() => { setText(view.input()!, '5') })
    await act(async () => { view.save()?.click() })
    expect(view.root.textContent).toContain('cleanup.saveFailed')
    // The official form keeps the drafts so the user can correct them...
    expect(view.input()?.value).toBe('5')
    expect(view.save()?.disabled).toBe(false)
    // ...and the next edit clears the failure line.
    act(() => { setText(view.input()!, '6') })
    expect(view.root.textContent).not.toContain('cleanup.saveFailed')
  })

  it('keeps the staged draft when the document moves underneath it', async () => {
    const { api } = fakeApi({ user: { enabled: true, maxAgeDays: 45 } })
    const view = mount(api)
    act(() => { setText(view.input()!, '7') })
    expect(view.input()?.value).toBe('7')
    // Another writer (the command, or another browser) moves the document.
    await act(async () => { await api.set('maxAgeDays', 12) })
    expect(view.input()?.value).toBe('7') // the staged draft is untouched
  })
})
