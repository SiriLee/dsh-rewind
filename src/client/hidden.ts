/**
 * Pure computation of the chat rows a rewind hides from the rendered
 * transcript. Extracted from the client plugin (`src/client/index.ts`) so the
 * multi-rewind cut logic stays unit-testable without a DOM.
 *
 * @module dsh-rewind/client/hidden
 */

import type { ChatConversationViewNode, CommandNode } from './dsh-types.ts'

/** Minimal chat snapshot reader the hiding logic needs. */
export interface HiddenChat {
  readonly order: readonly string[]
  readonly nodes: { get(key: string): ChatConversationViewNode | undefined }
}

/**
 * Reader for one session's live chat snapshot. This is one of the plugin's
 * "0.1.1-rc.2 ↔ 0.1.2-rc.1" dual channels: 0.1.1-rc.2 serves the chat from the
 * session face snapshot, while 0.1.2-rc.1 (and the whole 0.1.2 line) serves it
 * from the `uiConversation` service's named "chat" view (contributed by
 * dsh-client-ui-chat through the uiSession slot hook). See
 * SiriLee/dsh-rewind#7.
 */
export type ChatOf = (
  session: { readonly sessionId: string; getSnapshot(): { chat?: unknown } } | undefined,
) => HiddenChat | undefined

/**
 * Subscribe to one session's live chat-update signal, for waiting on a chat
 * snapshot change without polling. Dual-channel, mirroring `chatOf`: the
 * 0.1.2-rc.1 `uiConversation` "chat" view when registered, else the session
 * face (0.1.1-rc.2, whose snapshot still carries `chat`, so its own
 * `subscribe` is the chat-update signal). `cb` fires whenever the chat
 * snapshot invalidates.
 */
export type ChatWatch = (sessionId: string, cb: () => void) => () => void

/**
 * Choose the chat-update subscription for `waitForCommand`: prefer the
 * `uiConversation` "chat" view's own `subscribe` when available (0.1.2-rc.1,
 * where the chat-update signal lives), else the session face's `subscribe`
 * (0.1.1-rc.2, whose snapshot still carries the chat, so its own subscribe is
 * the chat-update signal). Extracted as a pure channel-selection step so the
 * "view vs face" branch is unit-testable; the resolvers are injected by the
 * caller (see `watchChat` in index.ts). Never throws.
 */
export function resolveChatWatch(
  resolveView: (sessionId: string) => { subscribe?(cb: () => void): () => void } | undefined,
  resolveFace: (sessionId: string) => { subscribe(cb: () => void): () => void } | undefined,
  sessionId: string,
  cb: () => void,
): () => void {
  const view = resolveView(sessionId)
  if (view?.subscribe !== undefined) return view.subscribe(cb)
  const face = resolveFace(sessionId)
  return face?.subscribe(cb) ?? (() => {})
}

/**
 * Resolve the chat snapshot across the two harness channels: the session-face
 * snapshot first (0.1.1-rc.2 — on 0.1.2-rc.1 the face no longer carries
 * `chat`, so the field reads `undefined`), then the `uiConversation` "chat"
 * view. The view's `getSnapshot()` returns undefined until the named view is
 * registered, so both channels missing degrades to `undefined` (no targets, no
 * hiding — never a crash).
 */
export function chatSnapshotOf(
  face: { getSnapshot(): { chat?: unknown } } | undefined,
  chatView: { getSnapshot(): unknown } | undefined,
): HiddenChat | undefined {
  const legacy = face?.getSnapshot().chat as HiddenChat | undefined
  if (legacy !== undefined) return legacy
  return (chatView?.getSnapshot() ?? undefined) as HiddenChat | undefined
}

/**
 * The plain text of the human message at `seq` in the chat snapshot, for
 * filling the composer after a withdraw. Accepts BOTH `user` and `steering`
 * nodes: a plan-mode (`/plan <text>`) input is delivered through the agent
 * inbox next-step and claimed, so it renders as `steering`, and its text must
 * still return to the composer (`portals.tsx` `runRewindAndFill`) — the old
 * `user`-only read silently left it empty. State absent → undefined; a message
 * with no text blocks → ''. Same text-blocks join the candidate side uses.
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
 * True when a `/rewind` command node is the internal candidate-list probe
 * (`/rewind __candidates`) the popupSelect runs to fetch the FULL candidate
 * list from the host. Like previews, its flow node never surfaces in the
 * transcript — it only feeds the popup — so it is hidden in every state.
 */
export function isCandidateCommand(command: CommandNode): boolean {
  return (command.args ?? '').includes('__candidates')
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
