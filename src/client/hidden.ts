/**
 * Pure computation of the chat rows a rewind hides from the rendered
 * transcript. Extracted from the client plugin (`src/client/index.ts`) so the
 * multi-rewind cut logic stays unit-testable without a DOM.
 *
 * @module dsh-rewind/client/hidden
 */

import type { CommandNode } from '@deepseek-ai/dsh-client-ui-conversation/client'

/** A chat-snapshot view node as the hiding / composer-refill logic reads it.
 * The harness's view node shape plus the `anchorSeq` the chat snapshot carries
 * (the plugin reads `anchorSeq` off each node; it is not declared on the
 * harness's `ConversationViewNode`). */
export interface ChatConversationViewNode {
  readonly key: string
  readonly kind?: string
  readonly data?: unknown
  readonly anchorSeq: number
}

/** Minimal chat snapshot reader the hiding logic needs. */
export interface HiddenChat {
  readonly order: readonly string[]
  readonly nodes: { get(key: string): ChatConversationViewNode | undefined }
}

/**
 * Reader for one session's live chat snapshot: the chat is served by the
 * `uiConversation` service's named "chat" view (contributed by
 * dsh-client-ui-chat through the uiSession slot hook).
 */
export type ChatOf = (
  session: { readonly sessionId: string } | undefined,
) => HiddenChat | undefined

/**
 * Subscribe to one session's live chat-update signal, for waiting on a chat
 * snapshot change without polling. The `uiConversation` "chat" view's own
 * `subscribe` is the chat-update signal; `cb` fires whenever the
 * chat snapshot invalidates.
 */
export type ChatWatch = (sessionId: string, cb: () => void) => () => void

/**
 * Choose the chat-update subscription for `waitForCommand`: the
 * `uiConversation` "chat" view's own `subscribe`. Extracted as a pure
 * channel-selection step so the resolver is unit-testable; the resolver is
 * injected by the caller (see `watchChat` in index.ts). Never throws.
 */
export function resolveChatWatch(
  resolveView: (sessionId: string) => { subscribe?(cb: () => void): () => void } | undefined,
  sessionId: string,
  cb: () => void,
): () => void {
  const view = resolveView(sessionId)
  return view?.subscribe?.(cb) ?? (() => {})
}

/**
 * Resolve the chat snapshot from the `uiConversation` "chat" view. The view's
 * `getSnapshot()` returns undefined until the named view is registered, which
 * degrades to `undefined` (no targets, no hiding — never a crash).
 */
export function chatSnapshotOf(
  chatView: { getSnapshot(): unknown } | undefined,
): HiddenChat | undefined {
  return (chatView?.getSnapshot() ?? undefined) as HiddenChat | undefined
}

/**
 * The plain text of the human message at `seq` in the chat snapshot, for
 * filling the composer after a withdraw. Accepts BOTH `user` and `steering`
 * nodes: a plan-mode (`/plan <text>`) input is delivered through the agent
 * inbox next-step and claimed, so it renders as `steering`, and its text must
 * still return to the composer (`portals.tsx` `runRewindAndFill`). State absent
 * → undefined; a message with no text blocks → ''. Same text-blocks join the
 * candidate side uses.
 */
export function messageTextAt(chat: HiddenChat | undefined, seq: number): string | undefined {
  if (chat === undefined) return undefined
  for (const key of chat.order) {
    const node = chat.nodes.get(key)
    if (node === undefined || (node.kind !== 'user' && node.kind !== 'steering')) continue
    const data = node.data as {
      seq?: number
      content?: readonly { type?: string; text?: string }[]
    }
    if (data.seq === seq) {
      return data.content
        ?.map(block => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
        .join('')
    }
  }
  return undefined
}

/**
 * A durable image reference carried by an `image` content block in the chat
 * snapshot, read structurally (the harness's `ImageAttachmentRef` from
 * dsh-attachment, without importing it, so the plugin survives harness
 * drift). Fields beyond `attachmentId`/`mediaType` pass through to the
 * durable image URL loader unchanged.
 */
export interface MessageImageRef {
  readonly attachmentId: string
  readonly mediaType: string
  readonly bytes?: number
  readonly width?: number
  readonly height?: number
  readonly name?: string
}

/**
 * The durable image references of the human message at `seq` in the chat
 * snapshot, in message order. The composer-refill counterpart of
 * `messageTextAt` (see `portals.tsx` `runRewindAndFill`): rewinding an
 * image-bearing message restores its pictures into the composer so the
 * withdraw does not silently drop them.
 *
 * Reads the same node kinds as `messageTextAt` (`user` and `steering`).
 * Blocks tolerate malformed or missing references (skipped, never a throw),
 * and `image/offload` projections leave the durable reference in place —
 * which is all the URL loader needs. `file` blocks are intentionally
 * excluded: the harness exposes no client-side file-bytes loader (file
 * uploads go one-way), so a file is not restorable.
 * State absent → undefined; a message without images → [].
 */
export function messageAttachmentsAt(chat: HiddenChat | undefined, seq: number): readonly MessageImageRef[] | undefined {
  if (chat === undefined) return undefined
  for (const key of chat.order) {
    const node = chat.nodes.get(key)
    if (node === undefined || (node.kind !== 'user' && node.kind !== 'steering')) continue
    const data = node.data as {
      seq?: number
      content?: readonly {
        type?: string
        attachment?: {
          attachmentId?: unknown
          mediaType?: unknown
          bytes?: unknown
          width?: unknown
          height?: unknown
          name?: unknown
        }
      }[]
    }
    if (data.seq !== seq) continue
    const images: MessageImageRef[] = []
    for (const block of data.content ?? []) {
      if (block.type !== 'image') continue
      const attachment = block.attachment
      if (typeof attachment?.attachmentId !== 'string' || typeof attachment.mediaType !== 'string') continue
      images.push({
        attachmentId: attachment.attachmentId,
        mediaType: attachment.mediaType,
        bytes: typeof attachment.bytes === 'number' ? attachment.bytes : undefined,
        width: typeof attachment.width === 'number' ? attachment.width : undefined,
        height: typeof attachment.height === 'number' ? attachment.height : undefined,
        name: typeof attachment.name === 'string' ? attachment.name : undefined,
      })
    }
    return images
  }
  return undefined
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
 * changes (never guesses from human copy). Absent text (undefined) degrades to
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
 * True when a `/rewind` command node is the internal candidate-list probe
 * (`/rewind __candidates`) the popupSelect runs to fetch the FULL candidate
 * list from the host. Like previews, its flow node never surfaces in the
 * transcript — it only feeds the popup — so it is hidden in every state.
 */
export function isCandidateCommand(command: CommandNode): boolean {
  return (command.args ?? '').includes('__candidates')
}

/**
 * One executed rewind's cut: the target seq through the marker's seq, plus the
 * fractional slack the harness's synthetic anchors need (see `CUT_END_SLACK`).
 * The upper bound is stored EXCLUSIVE so the slack is applied once here rather
 * than on every membership test.
 */
interface CutSpan {
  readonly start: number
  readonly endExclusive: number
}

/**
 * How far past the marker a cut still reaches, in anchorSeq units.
 *
 * The Chat target anchors some rows at a FRACTIONAL position inside their
 * durable event's neighborhood rather than at the event's own integer seq: a
 * turn footer at `turn/end.seq + 0.1`, the Turn-process summary at
 * `controlAnchorSeq - 0.1`, an interrupted assistant prefix at `turn/end.seq -
 * 0.9` (harness `CHAT_SYNTHETIC_SEQ_OFFSETS`). Those rows belong to events
 * INSIDE the cut, so an integer-inclusive test left them on screen — the
 * "已停止" header and the per-turn copy/branch row survived a rewind because
 * of it. The bound stays within one seq, so a row anchored at the FIRST seq
 * after the marker still stays visible and the slack never swallows later
 * traffic.
 */
const CUT_END_SLACK = 1

/**
 * Coalesce rewind cut spans into disjoint, ascending ranges.
 *
 * Two half-open spans `[start, endExclusive)` that touch or overlap describe
 * one continuous cut and merge. Touching ranges merge too — an earlier marker's
 * slack always overlaps the next target, and both describe one withdrawn run.
 * Membership then costs one binary search per node instead of a scan of every
 * span, which is what keeps `hiddenSeqsOf` linear in the nodes rather than
 * nodes × rewinds.
 *
 * @param spans - one `[target, marker + slack)` range per executed rewind.
 * @returns the merged ranges, ascending by start.
 */
function coalesceCuts(spans: readonly CutSpan[]): readonly CutSpan[] {
  if (spans.length < 2) return spans
  const sorted = [...spans].sort((left, right) => left.start - right.start || left.endExclusive - right.endExclusive)
  const merged: CutSpan[] = []
  for (const span of sorted) {
    const last = merged[merged.length - 1]
    if (last !== undefined && span.start <= last.endExclusive) {
      if (span.endExclusive > last.endExclusive) merged[merged.length - 1] = { start: last.start, endExclusive: span.endExclusive }
      continue
    }
    merged.push(span)
  }
  return merged
}

/**
 * Whether an anchor seq falls inside any coalesced cut range.
 * @param cuts - coalesced half-open ranges, ascending by start (see `coalesceCuts`).
 * @param seq - the anchor seq to test.
 * @returns true when a rewind withdrew that seq.
 */
function cutsContain(cuts: readonly CutSpan[], seq: number): boolean {
  let low = 0
  let high = cuts.length - 1
  while (low <= high) {
    const middle = (low + high) >> 1
    const cut = cuts[middle]!
    if (seq < cut.start) high = middle - 1
    else if (seq >= cut.endExclusive) low = middle + 1
    else return true
  }
  return false
}

/**
 * Anchor seqs that must be hidden from the rendered transcript so the user sees
 * the conversation as the agent sees it: every impact-preview flow node (it only
 * exists to feed the popover) and every SUCCESSFUL executed `/rewind` command
 * row, plus every message a rewind withdrew — the target, everything after it,
 * and the (unrendered) marker.
 *
 * Each executed rewind cuts ONE span `[target, marker]`, and callers must keep
 * the spans SEPARATE: collapsing them to `[min target, max marker]` would hide a
 * still-on-surface gap of new traffic between an earlier marker and a later
 * target. Endpoints come from the command nodes (`sourceEventSeq` is the
 * marker's log seq; the outcome text carries the target seq).
 */
export function hiddenSeqsOf(snap: HiddenChat): Set<number> {
  const hidden = new Set<number>()
  const spans: CutSpan[] = []
  for (const key of snap.order) {
    const node = snap.nodes.get(key)
    if (node === undefined || node.kind !== 'command') continue
    const command = node.data as CommandNode
    if (command.name !== 'rewind') continue
    // An internal probe (preview or candidate-list fetch) is hidden in every
    // state — pending, succeeded, or errored — so no row flashes in the
    // transcript while the popover/popup shows its result. Probes never
    // contribute to the cut range (nothing was actually rewound).
    if (isPreviewCommand(command) || isCandidateCommand(command)) {
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
      spans.push({ start: target, endExclusive: marker + CUT_END_SLACK })
    }
  }
  const cuts = coalesceCuts(spans)
  for (const key of snap.order) {
    const node = snap.nodes.get(key)
    if (node === undefined) continue
    if (cutsContain(cuts, node.anchorSeq)) hidden.add(node.anchorSeq)
  }
  return hidden
}
