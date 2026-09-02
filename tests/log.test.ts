/**
 * @vitest-environment jsdom
 *
 * dsh-rewind client logger layering: `error`/`warn` are the always-on anomaly
 * guard, while `info`/`debug` only print once the
 * `localStorage['dsh-rewind.debug']` switch selects the namespace — so a
 * normal user's console stays clean by default, and a reporter flips one key
 * to see the verbose internals. Pins: always-on levels, default-off verbose,
 * wildcard / exact / comma-separated namespace matching, and empty=off.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { rewindLog } from '../src/client/log.ts'

const KEY = 'dsh-rewind.debug'

afterEach(() => {
  localStorage.removeItem(KEY)
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
    localStorage.setItem(KEY, '')
    const info = vi.spyOn(console, 'info').mockReturnValue(undefined)
    rewindLog.info('refill', 'm')
    expect(info).not.toHaveBeenCalled()
  })

  it('enables info/debug when the switch is on (wildcard dsh-rewind*)', () => {
    localStorage.setItem(KEY, 'dsh-rewind*')
    const info = vi.spyOn(console, 'info').mockReturnValue(undefined)
    const debug = vi.spyOn(console, 'debug').mockReturnValue(undefined)
    rewindLog.info('refill', 'm')
    rewindLog.debug('hiding', 'h')
    expect(info).toHaveBeenCalledTimes(1)
    expect(debug).toHaveBeenCalledTimes(1)
  })

  it('filters by namespace: refill only, hiding stays silent', () => {
    localStorage.setItem(KEY, 'dsh-rewind:refill')
    const info = vi.spyOn(console, 'info').mockReturnValue(undefined)
    const debug = vi.spyOn(console, 'debug').mockReturnValue(undefined)
    rewindLog.info('refill', 'm')
    rewindLog.debug('hiding', 'h')
    expect(info).toHaveBeenCalledTimes(1)
    expect(debug).not.toHaveBeenCalled()
  })

  it('supports comma-separated namespaces', () => {
    localStorage.setItem(KEY, 'dsh-rewind:refill,dsh-rewind:hiding')
    const info = vi.spyOn(console, 'info').mockReturnValue(undefined)
    const debug = vi.spyOn(console, 'debug').mockReturnValue(undefined)
    rewindLog.info('refill', 'm')
    rewindLog.debug('hiding', 'h')
    rewindLog.debug('popover', 'p')
    expect(info).toHaveBeenCalledTimes(1)
    expect(debug).toHaveBeenCalledTimes(1) // hiding matched, popover not
  })
})
