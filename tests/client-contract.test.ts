/**
 * Entry-surface test for the public contract (docs/contract/client-contract.md): the
 * `./client` entry must re-export the canonical implementation — a re-derived
 * copy is how regressions escape (cf. dsh-chat-timeline#6). Behavior is
 * covered by hidden.test.ts; this file locks the entry.
 *
 * Compilation: typechecked by tsconfig.client-test.json (client surface +
 * this test), not by tsconfig.json — the host surface must not compile
 * src/client, where a Cordis Context declaration-merge clash (ISessions vs
 * dsh-session's SessionStore) misfires. The export surface is also asserted
 * by scripts/build.mjs on every build.
 */
import { describe, expect, it } from 'vitest'
import { hiddenSeqsOf, targetSeqOfArgs } from '../src/client/index.ts'
import {
  hiddenSeqsOf as hiddenSeqsOfInternal,
  targetSeqOfArgs as targetSeqOfArgsInternal,
} from '../src/client/hidden.ts'

describe('client contract entry (dsh-rewind-plugin/client)', () => {
  it('re-exports the canonical implementation, not a copy', () => {
    expect(hiddenSeqsOf).toBe(hiddenSeqsOfInternal)
    expect(targetSeqOfArgs).toBe(targetSeqOfArgsInternal)
  })

  it('is usable from the entry', () => {
    expect(targetSeqOfArgs('@5 chat')).toBe(5)
    expect(targetSeqOfArgs('preview @5 both')).toBe(5)
  })
})
