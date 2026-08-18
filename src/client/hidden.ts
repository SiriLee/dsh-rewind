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

/** True when a `/rewind` command node is an impact preview — the internal probe
 * the popover runs (`/rewind preview @seq both`) to fetch the restore/delete
 * list. Previews never surface in the transcript (their result is shown in the
 * popover), so their flow node is hidden in every state. */
function isPreviewCommand(command: CommandNode): boolean {
  return (command.args ?? '').includes('preview')
}

/**
 * Anchor seqs that must be hidden from the rendered transcript so the user
 * sees the conversation as the agent sees it: every impact-preview flow node
 * (pending, succeeded, or errored — it only exists to feed the popover) and
 * every SUCCESSFUL executed `/rewind` command row, plus every message
 * withdrawn by a rewind — the target message itself, everything after it, and
 * the (empty, unrendered) marker.
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
    // A preview probe is internal: hide its flow node immediately — while
    // still pending, once succeeded, and even on error — so no row flashes in
    // the transcript while the popover shows the impact. Previews never
    // contribute to the cut range (nothing was actually rewound).
    if (isPreviewCommand(command)) {
      hidden.add(command.seq)
      continue
    }
    // Only SUCCESSFUL executed rewinds are hidden (their result is noise once
    // the conversation is rewound). A failed executed rewind must stay visible
    // so the user sees the error instead of silently missing the rewind.
    if (command.outcome?.kind !== 'success') continue
    // A success WITHOUT a marker rewound nothing (the step-2 "choose a mode"
    // hint from the now-blocked manual text flow): leave its row visible and
    // do not extend the cut range.
    const marker = command.outcome.sourceEventSeq
    if (marker === undefined) continue
    hidden.add(command.seq)
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
