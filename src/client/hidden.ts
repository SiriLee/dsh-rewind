/**
 * Pure computation of the chat rows a rewind hides from the rendered
 * transcript. Extracted from the client plugin (`src/client/index.ts`) so the
 * multi-rewind cut logic stays unit-testable without a DOM.
 *
 * @module dsh-rewind/client/hidden
 */

import type { ChatConversationViewNode, CommandNode } from '@deepseek-ai/dsh-client-runtime/client'

/** Minimal chat snapshot reader the hiding logic needs. */
export interface HiddenChat {
  readonly order: readonly string[]
  readonly nodes: { get(key: string): ChatConversationViewNode | undefined }
}

/** Extract the rewind target from a command outcome text ("已撤回 seq N..."). */
export function targetOfOutcome(text: string | undefined): number | undefined {
  if (text === undefined) return undefined
  const match = text.match(/seq (\d+)/)
  return match !== null ? Number(match[1]) : undefined
}

/**
 * Anchor seqs that must be hidden from the rendered transcript so the user
 * sees the conversation as the agent sees it: every EXECUTED `/rewind`
 * command row (one that appended a marker; preview-only rows stay visible
 * until a real rewind's range covers them) and every message withdrawn by a
 * rewind — the target message itself, everything after it, and the (empty,
 * unrendered) marker.
 *
 * The cut span is [min target, max marker] across ALL executed rewinds, not
 * just the newest one: every rewind withdraws its target and everything after
 * it, and a later rewind to a LATER point (after new traffic) must not re-show
 * rows an earlier rewind already cut. Endpoints come from the command nodes:
 * `sourceEventSeq` is the marker's log seq, and the outcome text carries the
 * target seq.
 */
export function hiddenSeqsOf(snap: HiddenChat): Set<number> {
  const hidden = new Set<number>()
  let minTarget = Number.POSITIVE_INFINITY
  let maxMarker = Number.NEGATIVE_INFINITY
  for (const key of snap.order) {
    const node = snap.nodes.get(key)
    if (node === undefined || node.kind !== 'command') continue
    const command = node.data as CommandNode
    if (command.name !== 'rewind') continue
    // Only SUCCESSFUL rewind commands are hidden (their result is noise once
    // the conversation is rewound). A failed rewind must stay visible so the
    // user sees the error instead of silently missing the rewind.
    if (command.outcome?.kind !== 'success') continue
    // A successful command without a marker (`sourceEventSeq`) only PREVIEWED
    // the impact — nothing was rewound, so its row stays visible (like a
    // failed rewind); only a real rewind's range may hide it below.
    if (command.outcome.sourceEventSeq === undefined) continue
    hidden.add(command.seq)
    const marker = command.outcome.sourceEventSeq
    const target = targetOfOutcome(command.outcome.text)
    if (target !== undefined) {
      if (target < minTarget) minTarget = target
      if (marker > maxMarker) maxMarker = marker
    }
  }
  if (Number.isFinite(minTarget)) {
    for (const key of snap.order) {
      const node = snap.nodes.get(key)
      if (node === undefined) continue
      const anchor = node.anchorSeq
      if (anchor >= minTarget && anchor <= maxMarker) hidden.add(anchor)
    }
  }
  return hidden
}
