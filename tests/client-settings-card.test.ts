/**
 * @vitest-environment jsdom
 *
 * Unit tests for the client snapshot-cleanup configuration form
 * (src/client/settings-card.tsx): the pure draft/validation/staging helpers, the
 * cross-config constants (the client copies the host namespace literal because
 * the client build cannot import the host module, and the bundle slot key must
 * equal `package.json`'s name), and the React form's staged-edit behaviour.
 *
 * The form now lives on the sidebar Plugins page (`plugins.bundle.config`),
 * where the page draws the title itself — hence no collapse shell and no
 * Discard control, matching the harness's own plugin configuration forms.
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
import {
  SettingsCleanupCard,
  CLEANUP_SETTINGS_NAMESPACE,
  CLEANUP_SLOT_KEY,
  configOf,
  dirtyOf,
  draftFrom,
  maxAgeOf,
  opsOf,
  type CleanupCardApi,
  type CleanupField,
  type CleanupOp,
  type CleanupPolicy,
} from '../src/client/settings-card.tsx'

const t = (key: string): string => key

/** The composition-layer (base) policy the fake host resolves over. */
const BASE: CleanupPolicy = { enabled: false, maxAgeDays: 30 }

describe('maxAgeOf', () => {
  it('accepts a positive integer', () => {
    expect(maxAgeOf('30')).toBe(30)
    expect(maxAgeOf(' 5 ')).toBe(5)
  })
  it('rejects empty, non-digits, zero, and negatives', () => {
    expect(maxAgeOf('')).toBeNull()
    expect(maxAgeOf('abc')).toBeNull()
    expect(maxAgeOf('0')).toBeNull()
    expect(maxAgeOf('-1')).toBeNull()
    expect(maxAgeOf('2.5')).toBeNull()
    expect(maxAgeOf('1e3')).toBeNull()
  })
})

describe('draft / config / dirty helpers', () => {
  const policy = { enabled: true, maxAgeDays: 30 }
  it('draftFrom defaults when the view has not loaded', () => {
    expect(draftFrom(undefined)).toEqual({ enabled: false, maxAgeDays: '' })
    expect(draftFrom(policy)).toEqual({ enabled: true, maxAgeDays: '30' })
  })
  it('configOf returns the policy when valid, else null', () => {
    expect(configOf({ enabled: false, maxAgeDays: '7' })).toEqual({ enabled: false, maxAgeDays: 7 })
    expect(configOf({ enabled: true, maxAgeDays: '0' })).toBeNull()
    expect(configOf({ enabled: true, maxAgeDays: 'abc' })).toBeNull()
  })
  it('dirtyOf detects a switch or max-age change', () => {
    const base = draftFrom(policy)
    expect(dirtyOf(base, base)).toBe(false)
    expect(dirtyOf(base, { enabled: false, maxAgeDays: '30' })).toBe(true)
    expect(dirtyOf(base, { enabled: true, maxAgeDays: '31' })).toBe(true)
  })
})

describe('opsOf (what a save would write)', () => {
  const base = { enabled: true, maxAgeDays: '30' }
  it('writes only the fields that changed', () => {
    expect(opsOf(base, base, [])).toEqual([])
    expect(opsOf(base, { enabled: false, maxAgeDays: '30' }, []))
      .toEqual([{ field: 'enabled', kind: 'set', value: false }])
    expect(opsOf(base, { enabled: true, maxAgeDays: '7' }, []))
      .toEqual([{ field: 'maxAgeDays', kind: 'set', value: 7 }])
  })
  it('lets a staged reset win over an edit of the same field', () => {
    expect(opsOf(base, { enabled: false, maxAgeDays: '30' }, ['enabled']))
      .toEqual([{ field: 'enabled', kind: 'reset' }])
  })
  it('ignores the max-age field while the switch is off', () => {
    expect(opsOf(base, { enabled: false, maxAgeDays: '7' }, []))
      .toEqual([{ field: 'enabled', kind: 'set', value: false }])
  })
  it('never stages a max-age write from an invalid draft', () => {
    expect(opsOf(base, { enabled: true, maxAgeDays: 'abc' }, [])).toEqual([])
  })
})

describe('client constants', () => {
  it('pins the settings namespace to the host-verified literal', () => {
    // The client copies the host constant (see src/client/settings-card.tsx);
    // the host suite pins the same literal, so a drift fails one side.
    expect(CLEANUP_SETTINGS_NAMESPACE).toBe('dsh-rewind-snapshot-cleanup')
    expect(CLEANUP_SETTINGS_NAMESPACE).toMatch(/^[a-z][a-z0-9-]*$/)
  })
  it('keys the bundle config slot by the bundle package name', () => {
    // The Plugins page dispatches a bundle's form by `pkg.name`
    // (renderSlot('plugins.bundle.config', …, { entryKey: pkg.name })), so a
    // renamed package with a hardcoded key would silently lose its form.
    const root = join(dirname(fileURLToPath(import.meta.url)), '..')
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name: string }
    expect(CLEANUP_SLOT_KEY).toBe(pkg.name)
    expect(CLEANUP_SLOT_KEY).toBe('dsh-rewind-plugin')
  })
})

/** A fake api the card drives, mirroring the host's commit + re-read behaviour. */
function fakeApi(initial?: CleanupPolicy) {
  let value = initial
  let over: Record<CleanupField, boolean> = { enabled: false, maxAgeDays: false }
  let writable = true
  let fail = false
  const listeners = new Set<() => void>()
  const saved: CleanupOp[][] = []
  const api: CleanupCardApi = {
    read: () => value,
    overridden: () => over,
    writable: () => writable,
    save: async (ops) => {
      if (fail) throw new Error('boom')
      saved.push([...ops])
      // A reset resolves to the composition layer, not to the value on screen —
      // the same reconciliation the host performs after a commit.
      const next: { enabled: boolean; maxAgeDays: number } = {
        enabled: value?.enabled ?? BASE.enabled,
        maxAgeDays: value?.maxAgeDays ?? BASE.maxAgeDays,
      }
      for (const op of ops) {
        if (op.field === 'enabled') {
          if (op.kind === 'reset') { over = { ...over, enabled: false }; next.enabled = BASE.enabled }
          else next.enabled = op.value as boolean
        } else if (op.kind === 'reset') {
          over = { ...over, maxAgeDays: false }
          next.maxAgeDays = BASE.maxAgeDays
        } else {
          next.maxAgeDays = op.value as number
        }
      }
      value = next
      for (const cb of listeners) cb()
    },
    subscribe: (cb) => { listeners.add(cb); return () => { listeners.delete(cb) } },
  }
  return {
    api,
    saved,
    setOverridden: (next: Partial<Record<CleanupField, boolean>>) => { over = { ...over, ...next } },
    setWritable: (next: boolean) => { writable = next },
    failOn: () => { fail = true },
    failOff: () => { fail = false },
  }
}

let host: Root | null = null
afterEach(() => { host?.unmount(); host = null })

/** Mount the form under jsdom and return the root + helper finders. */
function mount(api: CleanupCardApi, view: 'summary' | 'page' = 'page') {
  const el = document.createElement('div')
  document.body.appendChild(el)
  host = createRoot(el)
  act(() => { host!.render(createElement(SettingsCleanupCard, { api, t, view })) })
  return {
    root: el,
    switch: () => el.querySelector<HTMLButtonElement>('[role="switch"]'),
    input: () => el.querySelector<HTMLInputElement>('#dsh-rewind-cleanup-maxage'),
    save: () => findButton(el, 'cleanup.save'),
  }
}

const findButton = (el: Element, label: string): HTMLButtonElement | undefined =>
  Array.from(el.querySelectorAll('button')).find((b) => b.textContent === label)

/** Drive a controlled <input> value change the way React expects in jsdom. */
function setText(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  setter?.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('SettingsCleanupCard', () => {
  it('renders nothing for the summary view the page only uses for one-liners', () => {
    const { api } = fakeApi({ enabled: true, maxAgeDays: 30 })
    const view = mount(api, 'summary')
    expect(view.root.textContent).toBe('')
    expect(view.root.querySelector('[role="switch"]')).toBeNull()
  })

  it('renders the switch and hides the max-age field while the switch is off', () => {
    const { api } = fakeApi({ enabled: false, maxAgeDays: 30 })
    const view = mount(api)
    expect(view.switch()?.getAttribute('aria-checked')).toBe('false')
    expect(view.root.textContent).toContain('cleanup.auto.off')
    expect(view.input()).toBeNull()
    expect(view.save()?.disabled).toBe(true)
  })

  it('shows the max-age field, hint, and an enabled save once the draft changes', () => {
    const { api } = fakeApi({ enabled: true, maxAgeDays: 30 })
    const view = mount(api)
    expect(view.input()?.value).toBe('30')
    expect(view.root.textContent).toContain('cleanup.maxAge.hint')
    act(() => { setText(view.input()!, '7') })
    expect(view.save()?.disabled).toBe(false)
  })

  it('blocks save on an invalid max-age and shows the invalid hint', () => {
    const { api } = fakeApi({ enabled: true, maxAgeDays: 30 })
    const view = mount(api)
    act(() => { setText(view.input()!, 'abc') })
    expect(view.save()?.disabled).toBe(true)
    expect(view.root.textContent).toContain('cleanup.invalid')
    expect(view.input()?.getAttribute('aria-invalid')).toBe('true')
  })

  it('writes the staged field operations and reconciles the draft afterwards', async () => {
    const { api, saved } = fakeApi({ enabled: true, maxAgeDays: 30 })
    const view = mount(api)
    act(() => { setText(view.input()!, '5') })
    await act(async () => { view.save()?.click() })
    expect(saved).toEqual([[{ field: 'maxAgeDays', kind: 'set', value: 5 }]])
    // Reconciled from the re-read value: the draft is clean again.
    expect(view.input()?.value).toBe('5')
    expect(view.save()?.disabled).toBe(true)
  })

  it('stages a reset that clears the field instead of writing a value', async () => {
    const { api, saved, setOverridden } = fakeApi({ enabled: true, maxAgeDays: 45 })
    setOverridden({ maxAgeDays: true })
    const view = mount(api)
    // The badge and the reset only exist while the user layer carries the field.
    expect(view.root.textContent).toContain('cleanup.overridden')
    const reset = findButton(view.root, 'cleanup.reset')
    expect(reset).toBeDefined()
    act(() => { reset!.click() })
    // Staged, not written: no control click performs a host mutation.
    expect(saved).toHaveLength(0)
    expect(view.input()?.value).toBe('45')
    expect(view.save()?.disabled).toBe(false)
    await act(async () => { view.save()?.click() })
    expect(saved).toEqual([[{ field: 'maxAgeDays', kind: 'reset' }]])
    // The reset resolved to the composition layer (30), not to the shown 45.
    expect(view.input()?.value).toBe('30')
    expect(view.root.textContent).not.toContain('cleanup.overridden')
  })

  it('disables every control and says so on a read-only settings source', () => {
    const { api, setWritable } = fakeApi({ enabled: true, maxAgeDays: 30 })
    setWritable(false)
    const view = mount(api)
    expect(view.root.textContent).toContain('cleanup.readonly')
    expect(view.switch()?.disabled).toBe(true)
    expect(view.input()?.disabled).toBe(true)
    expect(view.save()?.disabled).toBe(true)
  })

  it('surfaces a save failure without clobbering the draft', async () => {
    const { api, saved, failOn, failOff } = fakeApi({ enabled: true, maxAgeDays: 30 })
    const view = mount(api)
    act(() => { setText(view.input()!, '5') })
    failOn()
    await act(async () => { view.save()?.click() })
    expect(saved).toHaveLength(0)
    expect(view.root.textContent).toContain('cleanup.saveFailed')
    expect(view.input()?.value).toBe('5')
    failOff()
    await act(async () => { view.save()?.click() })
    expect(saved).toEqual([[{ field: 'maxAgeDays', kind: 'set', value: 5 }]])
  })
})
