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

/**
 * Extract the rewind target seq from a `/rewind` command's structured `args`
 * (e.g. `@5 chat`, `preview @5 both`). Locale-independent — never parses the
 * host's human outcome copy.
 */
export function targetSeqOfArgs(args: string | null | undefined): number | undefined {
  if (args === undefined || args === null) return undefined
  const match = args.match(/@(\d+)/)
  return match !== null ? Number(match[1]) : undefined
}

/**
 * True when a `/rewind` command node is an EXECUTED rewind for `seq` — the
 * admission form the popover drives (`@<seq> chat` / `both`) that settled
 * with a marker-carrying success outcome. The composer refill waits for
 * exactly this node after the user confirms, so a history-loaded command can
 * never trigger a fill.
 */
export function isExecutedRewindCommand(node: CommandNode, seq: number): boolean {
  if (node.name !== 'rewind' || node.outcome?.kind !== 'success') return false
  // A success WITHOUT a marker rewound nothing (an impact preview, or the
  // step-2 "choose a mode" hint from the now-blocked manual text flow).
  if (node.outcome.sourceEventSeq === undefined) return false
  const args = node.args ?? ''
  return new RegExp(`(?:^|\\s)@${seq}(?:\\s|$)`).test(args)
}

/**
 * Whether a preview outcome reports tracked file changes — the availability
 * of the "rewind conversation and code" option (Claude Code hides the
 * code-restore options when the checkpoint has no tracked changes).
 *
 * Reads ONLY the machine-readable `impact=<n>` trailer the host appends to
 * preview text. Older host output without the trailer is treated as having no
 * changes (never guesses from human copy). Unknown/absent text degrades to
 * always-show so a working option is never hidden on a failed probe.
 */
export function hasFileImpact(text: string | undefined): boolean {
  if (text === undefined) return true
  const match = text.match(/impact=(\d+)/)
  if (match !== null) return Number(match[1]) > 0
  return false
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
 * Each executed rewind cuts ONE span `[target, marker]`: the target message
 * and everything after it, up to the marker appended at rewind time. Spans are
 * kept SEPARATE (never collapsed to a single `[min target, max marker]`)
 * because a later rewind to a LATER point leaves a visible gap of new traffic
 * between the earlier marker and the later target — collapsing the spans would
 * hide that still-on-surface gap. Endpoints come from the command nodes:
 * `sourceEventSeq` is the marker's log seq, and the outcome text carries the
 * target seq.
 */
export function hiddenSeqsOf(snap: HiddenChat): Set<number> {
  const hidden = new Set<number>()
  const spans: Array<{ start: number; end: number }> = []
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
    const target = targetSeqOfArgs(command.args)
    if (target !== undefined) {
      spans.push({ start: target, end: marker })
    }
  }
  for (const key of snap.order) {
    const node = snap.nodes.get(key)
    if (node === undefined) continue
    const anchor = node.anchorSeq
    if (spans.some(span => anchor >= span.start && anchor <= span.end)) {
      hidden.add(anchor)
    }
  }
  return hidden
}
