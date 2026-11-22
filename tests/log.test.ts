/**
 * @vitest-environment jsdom
 *
 * dsh-rewind client logger layering: `error`/`warn` are the always-on anomaly
 * guard, while `info`/`debug` only print once the
 * `localStorage['dsh-rewind.debug']` switch selects the namespace — so a
 * normal user's console stays clean by default, and a reporter flips one key
 * to see the verbose internals. Pins: always-on levels, default-off verbose,
 * wildcard / exact / comma-separated namespace matching, empty=off, and that
 * gated verbose lines route to the always-visible `console.info` (never the
 * `console.debug` "Verbose" level Chrome hides by default).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { rewindLog } from '../src/client/log.ts'

const KEY = 'dsh-rewind.debug'

/**
 * Node 26 exposes a global `localStorage` that is unavailable without
 * `--localstorage-file`, and jsdom's window is left without one in that
 * environment. The logger only needs get/set/remove, so give the window a
 * plain in-memory store for this test.
 */
const values = new Map<string, string>()
Object.defineProperty(window, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  } satisfies Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
})

afterEach(() => {
  window.localStorage.removeItem(KEY)
  vi.restoreAllMocks()
})

describe('log layering (verbose off by default)', () => {
  it('emits error/warn unconditionally (anomaly guard)', () => {
    const error = vi.spyOn(console, 'error').mockReturnValue(undefined)
    const warn = vi.spyOn(console, 'warn').mockReturnValue(undefined)
    rewindLog.error('settings', 'boom')
    rewindLog.warn('hiding', 'anomaly')
    expect(error).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('suppresses info/debug when the switch is absent (default, unset)', () => {
    const info = vi.spyOn(console, 'info').mockReturnValue(undefined)
    const debug = vi.spyOn(console, 'debug').mockReturnValue(undefined)
    rewindLog.info('refill', 'composer write')
    rewindLog.debug('hiding', 'per-batch')
    expect(info).not.toHaveBeenCalled()
    expect(debug).not.toHaveBeenCalled()
  })

  it('treats an empty switch value as off', () => {
    window.localStorage.setItem(KEY, '')
    const info = vi.spyOn(console, 'info').mockReturnValue(undefined)
    rewindLog.info('refill', 'm')
    expect(info).not.toHaveBeenCalled()
  })

  it('enables info/debug when the switch is on (wildcard dsh-rewind*)', () => {
    window.localStorage.setItem(KEY, 'dsh-rewind*')
    const info = vi.spyOn(console, 'info').mockReturnValue(undefined)
    const debug = vi.spyOn(console, 'debug').mockReturnValue(undefined)
    rewindLog.info('refill', 'm')
    rewindLog.debug('hiding', 'h')
    expect(info).toHaveBeenCalledTimes(2)
    // Gated verbose must be visible by default, never the hidden console.debug.
    expect(debug).not.toHaveBeenCalled()
  })

  it('filters by namespace: refill only, hiding stays silent', () => {
    window.localStorage.setItem(KEY, 'dsh-rewind:refill')
    const info = vi.spyOn(console, 'info').mockReturnValue(undefined)
    rewindLog.info('refill', 'm')
    rewindLog.debug('hiding', 'h')
    expect(info).toHaveBeenCalledTimes(1) // refill emitted; hiding gated off
  })

  it('supports comma-separated namespaces', () => {
    window.localStorage.setItem(KEY, 'dsh-rewind:refill,dsh-rewind:hiding')
    const info = vi.spyOn(console, 'info').mockReturnValue(undefined)
    rewindLog.info('refill', 'm')
    rewindLog.debug('hiding', 'h')
    rewindLog.debug('popover', 'p')
    expect(info).toHaveBeenCalledTimes(2) // refill + hiding matched; popover not
  })
})
