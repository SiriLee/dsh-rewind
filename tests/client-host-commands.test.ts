/**
 * The per-session Host command cache: it allows a name only after a successful
 * catalog read, retries a failed read, and drops a read that invalidation
 * superseded.
 */
import { describe, expect, it, vi } from 'vitest'
import { HostCommandNames } from '../src/client/host-commands.ts'

/** Flush one probe's promise chain. */
function settle(): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, 0) })
}

describe('HostCommandNames', () => {
  it('reads a catalog once and only then allows a name', async () => {
    let resolve!: (names: readonly string[] | undefined) => void
    const fetch = vi.fn(() => new Promise<readonly string[] | undefined>((done) => { resolve = done }))
    const host = new HostCommandNames(fetch)

    expect(host.allows('s1', 'rewind')).toBe(false)
    expect(host.allows('s1', 'rewind')).toBe(false)
    expect(fetch).toHaveBeenCalledTimes(1)

    resolve([])
    await settle()
    expect(host.allows('s1', 'rewind')).toBe(true)
  })

  it('hides a host-owned name and allows the rest', async () => {
    const host = new HostCommandNames(async () => ['rewind'])
    host.warm('s1')
    await settle()

    expect(host.allows('s1', 'rewind')).toBe(false)
    expect(host.allows('s1', 'undo')).toBe(true)
  })

  it('stays dormant after a failed read and retries', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(['rewind'])
    const host = new HostCommandNames(fetch)

    expect(host.allows('s1', 'rewind')).toBe(false)
    await settle()
    expect(fetch).toHaveBeenCalledTimes(1)

    expect(host.allows('s1', 'rewind')).toBe(false)
    await settle()
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(host.allows('s1', 'rewind')).toBe(false)
    expect(host.allows('s1', 'undo')).toBe(true)
  })

  it('drops cached and in-flight catalogs on invalidation', async () => {
    let release!: (names: readonly string[] | undefined) => void
    const host = new HostCommandNames(sessionId => sessionId === 's1'
      ? new Promise<readonly string[] | undefined>((done) => { release = done })
      : Promise.resolve([]))

    host.warm('s1')
    host.warm('s2')
    await settle()
    expect(host.allows('s2', 'rewind')).toBe(true)

    host.invalidate('s1')
    release(['rewind'])
    await settle()
    expect(host.allows('s1', 'rewind')).toBe(false)

    host.invalidateAll()
    expect(host.allows('s2', 'rewind')).toBe(false)
  })
})
