/**
 * Contract-code copy mapping: the transport returns stable codes, the client
 * localizes them through its own dictionaries. Unknown codes are failures, never
 * successes, and fall back to the generic internal message.
 *
 * @module dsh-rewind/client/errors
 */

import type { RewindKey } from './locales.ts'

/** The dictionary key for one contract failure code. */
export function contractErrorKey(code: string): RewindKey {
  switch (code) {
    case 'head-changed': return 'error.head-changed'
    case 'turn-running': return 'error.turn-running'
    case 'commit-in-flight': return 'error.commit-in-flight'
    default: return 'error.internal'
  }
}

/** The dictionary key for one file-effect availability reason. */
export function availabilityKey(reason: string): RewindKey {
  switch (reason) {
    case 'checkpointing-disabled': return 'files.unavailable.checkpointing-disabled'
    case 'store-unsupported': return 'files.unavailable.store-unsupported'
    default: return 'files.unavailable'
  }
}
