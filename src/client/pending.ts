/**
 * Pure pending-message matching: pairs the rendered pre-admission steering
 * bubble rows with the session's `next-step` inbox rows.
 *
 * Both sides derive from the host's next-step inbox order — the ChatView
 * renders `pendingSteering` in array order and the queue mirror keeps the same
 * host order — so index-primary matching is reliable. Text equality is still
 * verified as a per-row cross-check, and a row that fails (or a row with no
 * mirror item, or a mirror item with no row) is skipped INDIVIDUALLY: one bad
 * row never takes down the other rows' buttons. The matching text is the
 * bubble's message text WITHOUT its actions container — the harness copy
 * button's Tooltip mounts a label bubble inside that container on hover, so
 * the full row textContent would flip between "message" and "message+Copy"
 * with the mouse, flickering the button (see `bubbleTextOf` in portals.tsx).
 *
 * DSH 0.1.6-alpha.2 removed the `SessionSnapshot.queue` mirror (and the host's
 * `queue-mirror.ts`), so these rows now come from the session's own `inbox`
 * projection (`next-turn` = queued, `next-step` = steering, user-sourced rows
 * only — see `steeringItemsOf`). `steeringItemsOf` derives the retract fields
 * from those rows with the SAME rules the harness QueueDock uses, so the DOM
 * text this module matches and the preview the popover shows cannot drift from
 * what the dock renders.
 *
 * The browser half lives in `portals.tsx`; this module stays DOM-free so the
 * matching contract is unit-testable in a plain node environment.
 *
 * @module dsh-rewind/client/pending
 */

/** One rendered pending-steering bubble row (only the fields matching reads). */
export interface PendingRow {
  /** The bubble's message text, excluding the actions container (see module doc). */
  readonly text: string
}

/** One wire content block of an inbox row (only the fields the derivation reads). */
export interface InboxBlockLike {
  /** Wire block type (`text` | `image` | `file` | …). */
  readonly type: string
  /** The block's text, on a `text` block. */
  readonly text?: string
}

/** One pending-inbox row (the alpha.2 `inbox` projection element). */
export interface InboxMessageLike {
  /** Agent-owned inbox occurrence identity; the harness brands it as `MessageId`. */
  readonly id: string
  /** Wire content blocks, in prompt order. */
  readonly content: readonly InboxBlockLike[]
  /** Message origin; only `kind: 'user'` rows are retractable (see `steeringItemsOf`). */
  readonly source?: { readonly kind?: string } | undefined
}

/**
 * The alpha.2 `inbox` projection value: the agent's pending input folded per
 * target order. Replaces the removed `SessionSnapshot.queue` mirror.
 */
export interface InboxLike {
  /** Messages claimed at the next turn boundary. */
  readonly 'next-turn': readonly InboxMessageLike[]
  /** Messages injected at the next step boundary (user or plugin/command). */
  readonly 'next-step': readonly InboxMessageLike[]
}

/** One steering occurrence derived from the session's inbox projection. */
export interface PendingSteeringItem {
  readonly id: string
  /** Complete editable text; null when the message contains non-text blocks. */
  readonly text: string | null
  /** Space-collapsed preview with image/file blocks excluded (the harness QueueDock rule). */
  readonly preview: string
}

/** Preview width of the harness QueueDock, in code points. */
const QUEUE_PREVIEW_CHARS = 200

/**
 * Complete editable text of one inbox row: the joined text blocks, or null
 * when the row carries any non-text block. Mirror of the harness QueueDock's
 * `textOf` (the owner of these rows).
 * @param content - the row's wire content blocks.
 * @returns the complete text, or null.
 */
function textOf(content: readonly InboxBlockLike[]): string | null {
  if (!content.every(block => block.type === 'text')) return null
  return content.map(block => block.text ?? '').join('')
}

/**
 * Space-collapsed preview of one inbox row, excluding image/file blocks and
 * truncated to {@link QUEUE_PREVIEW_CHARS} code points. Mirror of the harness
 * QueueDock's `previewOf`.
 * @param content - the row's wire content blocks.
 * @returns the preview text.
 */
function previewOf(content: readonly InboxBlockLike[]): string {
  const flat = content
    .filter(block => block.type !== 'image' && block.type !== 'file')
    .map(block => (block.type === 'text' ? block.text ?? '' : `[${block.type}]`))
    .join(' ').replace(/\s+/g, ' ').trim()
  const chars = Array.from(flat)
  return chars.length > QUEUE_PREVIEW_CHARS ? `${chars.slice(0, QUEUE_PREVIEW_CHARS).join('')}…` : flat
}

/**
 * Project the inbox `next-step` rows into the fields the retract path needs.
 *
 * ONLY user-sourced rows are steering. The host's deleted mapping
 * (`queueItemsFromInbox`) classified a `next-step` row as `steering` when
 * `message.source.kind === 'user'` and as `context` otherwise, and this plugin
 * has only ever retracted the former. A `context` row is a plugin/command
 * injection the user never typed, so it must not be offered a retract button —
 * and, because `retractSpan` removes the target AND everything after it in the
 * list, keeping those rows would also let one retract silently drop injected
 * messages. The rendered rows the matcher pairs against are the browser's own
 * submission echoes (user rows by construction), so a context row would
 * additionally shift the positional match and cost every later row its button.
 * @param nextStep - the inbox projection's `next-step` list (absent before the
 *   fold state exists, hence `undefined`).
 * @returns one item per USER steering row, in host (FIFO) order.
 */
export function steeringItemsOf(nextStep: readonly InboxMessageLike[] | undefined): readonly PendingSteeringItem[] {
  return (nextStep ?? [])
    .filter(item => item.source?.kind === 'user')
    .map(item => ({
      id: item.id,
      text: textOf(item.content),
      preview: previewOf(item.content),
    }))
}

/**
 * Pair rows to steering items by index, verifying text equality per row.
 * @param rows - pending bubble rows in DOM order (== render order).
 * @param steering - steering items in host order (== render order).
 * @returns the item id for each row, or null for rows that cannot be matched
 *   safely (missing counterpart, text mismatch). A bad row never affects the
 *   other rows.
 */
export function matchPendingRows(
  rows: readonly PendingRow[],
  steering: readonly PendingSteeringItem[],
): readonly (string | null)[] {
  const matched: (string | null)[] = []
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!
    const item = steering[i]
    if (item !== undefined && row.text === (item.text ?? '')) {
      matched.push(item.id)
    } else {
      matched.push(null)
    }
  }
  return matched
}

/**
 * The pending-steering ids a "rewind to this pre-sent message" retracts: the
 * target occurrence and every steering message after it, in inbox (FIFO)
 * order. Queued (next-turn) messages are deliberately NOT included — the
 * harness QueueDock already offers the user per-item edit/remove, so a rewind
 * must not silently drop messages the user may still want to send.
 * @param steering - steering items in host order (== render order).
 * @param targetId - the rewind target's inbox occurrence id.
 * @returns the ids to remove, oldest-first; empty when the target is no
 *   longer pending (already claimed/consumed).
 */
export function retractSpan(
  steering: readonly { readonly id: string }[],
  targetId: string,
): readonly string[] {
  const index = steering.findIndex((item) => item.id === targetId)
  if (index === -1) return []
  return steering.slice(index).map((item) => item.id)
}

