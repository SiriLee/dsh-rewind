/**
 * Entry-surface test for the public contract (docs/contract/client-contract.md): the
 * `./client` entry must re-export the canonical implementation — a re-derived
 * copy is how regressions escape (cf. dsh-chat-timeline#6). Behavior is
 * covered by hidden.test.ts; this file locks the entry.
 *
 * It also locks the two slots the client half registers into against the
 * harness's `SlotMap` at COMPILE time: alpha.2 deleted `settings.plugin.item`,
 * and neither `slots.inject` (waits forever) nor a structural `SlotsLike` cast
 * reported it — the card silently stopped rendering.
 *
 * Compilation: typechecked by tsconfig.client-test.json (client surface +
 * this test), not by tsconfig.json — the host surface must not compile
 * src/client, where a Cordis Context declaration-merge clash (ISessions vs
 * dsh-session's SessionStore) misfires. The export surface is also asserted
 * by scripts/build.mjs on every build.
 */
import { describe, expect, it } from 'vitest'
import type { SlotMap } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the Plugins page's SlotMap entries (`plugins.item`,
// `plugins.bundle.config`, `plugins.row.config`) from the package that declares
// them. The client half never imports this package at runtime.
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { hiddenSeqsOf, targetSeqOfArgs } from '../src/client/index.ts'
import {
  hiddenSeqsOf as hiddenSeqsOfInternal,
  targetSeqOfArgs as targetSeqOfArgsInternal,
} from '../src/client/hidden.ts'

/**
 * The slots `src/client/index.ts` registers into: a slot the harness stops
 * declaring fails the typecheck here instead of silently never rendering.
 */
const REGISTERED_SLOTS: readonly (keyof SlotMap)[] = [
  // The per-message ↶ bridge.
  'conversation.session.header.actions',
  // The snapshot-cleanup form on the bundle's own page.
  'plugins.bundle.config',
]

describe('client contract entry (dsh-rewind-plugin/client)', () => {
  it('re-exports the canonical implementation, not a copy', () => {
    expect(hiddenSeqsOf).toBe(hiddenSeqsOfInternal)
    expect(targetSeqOfArgs).toBe(targetSeqOfArgsInternal)
  })

  it('is usable from the entry', () => {
    expect(targetSeqOfArgs('@5 chat')).toBe(5)
    expect(targetSeqOfArgs('preview @5 both')).toBe(5)
  })

  it('registers only slots the harness declares', () => {
    // The compile-time check is the type above; this pins the list so a future
    // addition cannot quietly drop one of the two registrations.
    expect([...REGISTERED_SLOTS].sort()).toEqual([
      'conversation.session.header.actions',
      'plugins.bundle.config',
    ])
  })
})
