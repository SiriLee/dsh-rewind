/**
 * @vitest-environment jsdom
 *
 * Unit tests for the client snapshot-cleanup settings card
 * (src/client/settings-card.tsx): the pure draft/validation helpers, the
 * cross-config namespace constant equality (client copies the host literal
 * because the client build cannot import the host module), and the React card's
 * staged-edit behaviour (dirty/discard/blocked-save/collapse).
 *
 * Compilation: typechecked by `tsconfig.client-test.json` (client surface +
 * JSX); excluded from `tsconfig.json` (host, no JSX).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  SettingsCleanupCard,
  CLEANUP_SETTINGS_NAMESPACE,
  configOf,
  dirtyOf,
  draftFrom,
  maxAgeOf,
  type CleanupCardApi,
} from '../src/client/settings-card.tsx'

const t = (key: string): string => key

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

describe('client namespace literal', () => {
  it('pins the client literal to the host/ded-verified value', () => {
    // The client copies the host constant (see src/client/settings-card.tsx);
    // the host suite pins the same literal, so a drift fails one side.
    expect(CLEANUP_SETTINGS_NAMESPACE).toBe('dsh-rewind-snapshot-cleanup')
    expect(CLEANUP_SETTINGS_NAMESPACE).toMatch(/^[a-z][a-z0-9-]*$/)
  })
})

/** A fake api the card drives; save rejects when flagged to fail via `failOn`. */
function fakeApi(initial?: { enabled: boolean; maxAgeDays: number }): { api: CleanupCardApi; saved: Array<{ enabled: boolean; maxAgeDays: number }>; failOn: () => void; failOff: () => void } {
  let value = initial
  const listeners = new Set<() => void>()
  const saved: Array<{ enabled: boolean; maxAgeDays: number }> = []
  let fail = false
  const api: CleanupCardApi = {
    read: () => value,
    writable: () => true,
    save: async (next) => {
      if (fail) throw new Error('boom')
      saved.push(next)
      value = next
      listeners.forEach((cb) => cb())
    },
    subscribe: (cb) => { listeners.add(cb); return () => listeners.delete(cb) },
  }
  return {
    api,
    saved,
    failOn: () => { fail = true },
    failOff: () => { fail = false },
  }
}

let host: Root | null = null
afterEach(() => { host?.unmount(); host = null })

/** Mount the card under jsdom and return the root + helper finders. */
function mount(api: CleanupCardApi) {
  const el = document.createElement('div')
  document.body.appendChild(el)
  host = createRoot(el)
  act(() => { host!.render(createElement(SettingsCleanupCard, { api, t })) })
  return {
    root: el,
    checkbox: (path: string) => el.querySelector<HTMLInputElement>(path)!,
    input: (path: string) => el.querySelector<HTMLInputElement>(path)!,
    buttons: () => Array.from(el.querySelectorAll('button')).map((b) => b.textContent),
  }
}

const findButton = (el: Element, label: string): HTMLButtonElement =>
  Array.from(el.querySelectorAll('button')).find((b) => b.textContent === label)!

/** Drive a controlled <input> value change the way React expects in jsdom. */
function setText(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  setter?.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('SettingsCleanupCard', () => {
  it('renders collapsed (no max-age row) when the switch is off', () => {
    const { api } = fakeApi({ enabled: false, maxAgeDays: 30 })
    const view = mount(api)
    expect(view.checkbox('#dsh-rewind-cleanup-enabled').checked).toBe(false)
    expect(view.root.querySelector('#dsh-rewind-cleanup-maxage')).toBeNull()
    view.root.remove()
  })

  it('expands the max-age editor when the switch is on', () => {
    const { api } = fakeApi({ enabled: true, maxAgeDays: 30 })
    const view = mount(api)
    expect(view.checkbox('#dsh-rewind-cleanup-enabled').checked).toBe(true)
    expect(view.input('#dsh-rewind-cleanup-maxage').value).toBe('30')
    view.root.remove()
  })

  it('blocks save on an invalid max-age and shows the invalid hint', () => {
    const { api } = fakeApi({ enabled: true, maxAgeDays: 30 })
    const view = mount(api)
    act(() => { setText(view.input('#dsh-rewind-cleanup-maxage'), 'abc') })
    // The save button is disabled while the draft is invalid.
    const save = findButton(view.root, 'cleanup.save')
    expect(save.disabled).toBe(true)
    expect(view.root.textContent).toContain('cleanup.invalid')
    view.root.remove()
  })

  it('discard restores the baseline', () => {
    const { api } = fakeApi({ enabled: true, maxAgeDays: 30 })
    const view = mount(api)
    // Click() toggles the checkbox and fires React's onChange.
    act(() => { view.checkbox('#dsh-rewind-cleanup-enabled').click() })
    expect(view.checkbox('#dsh-rewind-cleanup-enabled').checked).toBe(false)
    expect(findButton(view.root, 'cleanup.save').disabled).toBe(false)
    act(() => { findButton(view.root, 'cleanup.discard').click() })
    expect(view.checkbox('#dsh-rewind-cleanup-enabled').checked).toBe(true)
    expect(findButton(view.root, 'cleanup.save').disabled).toBe(true)
    view.root.remove()
  })

  it('save applies the draft and reports failure without clobbering the draft', async () => {
    const { api, saved, failOn, failOff } = fakeApi({ enabled: true, maxAgeDays: 30 })
    const view = mount(api)
    act(() => { setText(view.input('#dsh-rewind-cleanup-maxage'), '5') })
    failOn()
    await act(async () => { findButton(view.root, 'cleanup.save').click() })
    expect(saved).toHaveLength(0)
    expect(view.root.textContent).toContain('cleanup.saveFailed') // failure surfaced
    expect(view.input('#dsh-rewind-cleanup-maxage').value).toBe('5')
    failOff()
    await act(async () => { findButton(view.root, 'cleanup.save').click() })
    expect(saved).toEqual([{ enabled: true, maxAgeDays: 5 }])
    view.root.remove()
  })
})
