/**
 * @vitest-environment jsdom
 *
 * Takeover-store probes: the claim attribute is observed live, `uiOwner: self`
 * ignores it, the saved policy is followed, and teardown stops both.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLAIM_ATTRIBUTE, createTakeoverStore, claimOf, type UiOwner } from '../src/client/claim.ts'

let disposers: Array<() => void> = []

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
  document.documentElement.removeAttribute(CLAIM_ATTRIBUTE)
})

/** Build a store over a controllable owner policy. */
function store(initial: UiOwner = 'auto') {
  let owner: UiOwner = initial
  const ownerListeners = new Set<() => void>()
  const takeover = createTakeoverStore({
    readOwner: () => owner,
    subscribeOwner: (listener) => {
      ownerListeners.add(listener)
      return () => { ownerListeners.delete(listener) }
    },
    document,
  })
  disposers.push(() => takeover.dispose())
  return {
    takeover,
    setOwner(next: UiOwner) {
      owner = next
      for (const listener of [...ownerListeners]) listener()
    },
  }
}

describe('claimOf', () => {
  it('reads a trimmed claim and treats a blank one as absent', () => {
    document.documentElement.setAttribute(CLAIM_ATTRIBUTE, '  my-theme ')
    expect(claimOf(document)).toBe('my-theme')
    document.documentElement.setAttribute(CLAIM_ATTRIBUTE, '   ')
    expect(claimOf(document)).toBeUndefined()
    expect(claimOf(undefined)).toBeUndefined()
  })
})

describe('createTakeoverStore', () => {
  it('yields while auto and a claim is present, and restores when it leaves', async () => {
    const { takeover } = store()
    expect(takeover.getSnapshot()).toEqual({ owner: 'auto', claim: undefined, claimed: false })

    const listener = vi.fn()
    takeover.subscribe(listener)
    document.documentElement.setAttribute(CLAIM_ATTRIBUTE, 'my-theme')
    await vi.waitFor(() => { expect(takeover.getSnapshot().claimed).toBe(true) })
    expect(takeover.getSnapshot()).toEqual({ owner: 'auto', claim: 'my-theme', claimed: true })
    expect(listener).toHaveBeenCalled()

    document.documentElement.removeAttribute(CLAIM_ATTRIBUTE)
    await vi.waitFor(() => { expect(takeover.getSnapshot().claimed).toBe(false) })
    expect(takeover.getSnapshot().claim).toBeUndefined()
  })

  it('keeps the native UI under uiOwner self while still exposing the claim', async () => {
    const { takeover } = store('self')
    document.documentElement.setAttribute(CLAIM_ATTRIBUTE, 'my-theme')
    await vi.waitFor(() => { expect(takeover.getSnapshot().claim).toBe('my-theme') })
    expect(takeover.getSnapshot().claimed).toBe(false)
  })

  it('follows saved-policy changes', () => {
    const { takeover, setOwner } = store()
    document.documentElement.setAttribute(CLAIM_ATTRIBUTE, 'my-theme')
    return vi.waitFor(() => {
      expect(takeover.getSnapshot().claimed).toBe(true)
    }).then(() => {
      setOwner('self')
      expect(takeover.getSnapshot()).toEqual({ owner: 'self', claim: 'my-theme', claimed: false })
      setOwner('auto')
      expect(takeover.getSnapshot().claimed).toBe(true)
    })
  })

  it('stops observing after dispose', async () => {
    const { takeover } = store()
    takeover.dispose()
    document.documentElement.setAttribute(CLAIM_ATTRIBUTE, 'late')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(takeover.getSnapshot()).toEqual({ owner: 'auto', claim: undefined, claimed: false })
  })
})
