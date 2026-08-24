/**
 * Entry-surface test for the public contract (docs/client-contract.md): the
 * `./client` entry must re-export the canonical implementation — a re-derived
 * copy is how regressions escape (cf. dsh-chat-timeline#6). Behavior is
 * covered by hidden.test.ts; this file locks the entry. Vitest runs it
 * outside the host typecheck surface on purpose: importing src/client/index.ts
 * pulls the client runtime into tsconfig.json's host graph, where a Cordis
 * Context declaration-merge clash (ISessions vs dsh-session's SessionStore)
 * misfires; scripts/build.mjs asserts the export surface on every build.
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
