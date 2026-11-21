/**
 * Third-party action-interface takeover.
 *
 * A page claims the action interface by setting
 * `data-dsh-rewind-claim="<name>"` on the document root. The claim only affects
 * the TRIGGER surface (row action, mode popover, pending retract buttons); the
 * engine, commands, visibility and configuration surface keep working, and
 * `uiOwner: self` ignores the claim entirely. The claim name is diagnostic and display
 * data only; the engine never validates that the claimant renders anything.
 *
 * @module dsh-rewind/client/claim
 */

import { rewindLog } from './log.ts'

/** Who owns the action interface while a claim is present. */
export type UiOwner = 'auto' | 'self'

/** The document attribute a third-party UI sets to claim the action interface. */
export const CLAIM_ATTRIBUTE = 'data-dsh-rewind-claim'

/** One resolved takeover state. */
export interface TakeoverSnapshot {
  /** The configured owner policy. */
  readonly owner: UiOwner
  /** The claim's diagnostic name, when the attribute is present. */
  readonly claim: string | undefined
  /** Whether the native action UI must yield now. */
  readonly claimed: boolean
}

/** The observable takeover state the client surfaces read. */
export interface TakeoverStore {
  getSnapshot(): TakeoverSnapshot
  subscribe(listener: () => void): () => void
}

/** Inputs the store needs from the client plugin. */
export interface TakeoverOptions {
  /** Read the live `uiOwner` setting. */
  readOwner(): UiOwner
  /** Observe saved-setting changes. */
  subscribeOwner(listener: () => void): () => void
  /** Document to observe; omitted outside a browser. */
  document?: Document
}

/** The claim as written, trimmed, or undefined when absent/blank. */
export function claimOf(document: Document | undefined): string | undefined {
  const raw = document?.documentElement?.getAttribute(CLAIM_ATTRIBUTE)?.trim()
  return raw === undefined || raw === '' ? undefined : raw
}

/**
 * Build the takeover store and start observing the claim attribute.
 * @param options - live owner policy, its subscription, and the document.
 * @returns the observable store plus its disposer.
 */
export function createTakeoverStore(options: TakeoverOptions): TakeoverStore & { dispose(): void } {
  const document = options.document
  const owner = (): UiOwner => (options.readOwner() === 'self' ? 'self' : 'auto')
  let snapshot: TakeoverSnapshot = resolve()
  const listeners = new Set<() => void>()
  let disposed = false

  function resolve(): TakeoverSnapshot {
    const currentOwner = owner()
    const claim = claimOf(document)
    return { owner: currentOwner, claim, claimed: currentOwner === 'auto' && claim !== undefined }
  }

  function publish(): void {
    if (disposed) return
    const next = resolve()
    if (next.owner === snapshot.owner && next.claim === snapshot.claim && next.claimed === snapshot.claimed) return
    snapshot = next
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch (error) {
        rewindLog.warn('claim', 'takeover listener threw', error)
      }
    }
  }

  let unsubscribeOwner: () => void = () => {}
  try {
    unsubscribeOwner = options.subscribeOwner(publish)
  } catch (error) {
    rewindLog.warn('claim', 'owner-setting subscription failed', error)
  }

  let observer: MutationObserver | undefined
  if (document?.documentElement !== undefined && typeof MutationObserver !== 'undefined') {
    try {
      observer = new MutationObserver(publish)
      observer.observe(document.documentElement, { attributes: true, attributeFilter: [CLAIM_ATTRIBUTE] })
    } catch (error) {
      rewindLog.warn('claim', 'claim observation failed', error)
    }
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    dispose() {
      if (disposed) return
      disposed = true
      listeners.clear()
      observer?.disconnect()
      try {
        unsubscribeOwner()
      } catch (error) {
        rewindLog.warn('claim', 'owner-setting unsubscribe failed', error)
      }
    },
  }
}
