/**
 * Pure pending-message matching: pairs the rendered pre-admission steering
 * bubble rows with the session's `next-step` inbox rows.
 *
 * Both sides follow the same host order, so index-primary matching is reliable;
 * the match key is still verified per row, and a row that fails (or has no
 * counterpart) is skipped INDIVIDUALLY: one bad row never takes down the other
 * rows' buttons. The key is `(text, attachment count)`: a text-only row must
 * match its text exactly, while an attachment-bearing row matches on the count,
 * because its rendered attachment block contributes text (a file name, an
 * image's loading label) that no inbox row reproduces.
 *
 * The compared text excludes the bubble's actions container — the copy
 * button's Tooltip mounts its label inside that button, so the row's
 * `textContent` flips with the mouse — and the message-attachment block (see
 * `bubbleTextOf` in portals.tsx).
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
  /** Message-attachment blocks the row renders; compared against the item's count. */
  readonly attachments: number
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
  /** Complete editable text; null when the message carries no text block at all. */
  readonly text: string | null
  /** Non-text blocks (image/file/…) the message carries, in prompt order. */
  readonly attachments: number
  /** Space-collapsed preview with image/file blocks excluded (the harness QueueDock rule). */
  readonly preview: string
}

/** Preview width of the harness QueueDock, in code points. */
const QUEUE_PREVIEW_CHARS = 200

/**
 * Complete editable text of one inbox row: the joined text blocks, or null when
 * the row has no text block at all. Unlike the harness QueueDock's `textOf`, a
 * message that mixes text with attachments still has text.
 * @param content - the row's wire content blocks.
 * @returns the complete text, or null.
 */
function textOf(content: readonly InboxBlockLike[]): string | null {
  const texts = content.filter(block => block.type === 'text')
  if (texts.length === 0) return null
  return texts.map(block => block.text ?? '').join('')
}

/**
 * The attachment half of the match key: how many non-text blocks one inbox row
 * carries.
 * @param content - the row's wire content blocks.
 * @returns the non-text block count.
 */
function attachmentsCountOf(content: readonly InboxBlockLike[]): number {
  return content.filter(block => block.type !== 'text').length
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
 * ONLY user-sourced rows are steering: the host's deleted mapping
 * (`queueItemsFromInbox`) called a `next-step` row `steering` for
 * `source.kind === 'user'` and `context` otherwise, and this plugin has only
 * ever retracted the former. An injected row must not get a button, and because
 * `retractSpan` removes the target AND its future it must not be swept into a
 * retract either; keeping it would also shift the positional match against the
 * rendered submission echoes and cost every later row its button.
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
      attachments: attachmentsCountOf(item.content),
      preview: previewOf(item.content),
    }))
}

/**
 * Pair rows to steering items by index, verifying the match key per row: the
 * visible text when the message has no attachments, otherwise the attachment
 * count. Exact text equality cannot apply to an attachment-bearing row — which
 * is why its ↶ button never mounted — because the rendered attachment block
 * contributes text no inbox row reproduces.
 *
 * @param rows - pending bubble rows in DOM order (== render order).
 * @param steering - steering items in host order (== render order).
 * @returns the item id for each row, or null for rows that cannot be matched
 *   safely (missing counterpart, key mismatch). A bad row never affects the
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
    matched.push(item !== undefined && matches(item, row) ? item.id : null)
  }
  return matched
}

/**
 * Whether one rendered row is the given inbox occurrence.
 * @param item - the steering item derived from the inbox row.
 * @param row - the rendered bubble row at the same index.
 * @returns whether the row may be paired with the item.
 */
function matches(item: PendingSteeringItem, row: PendingRow): boolean {
  if (item.attachments > 0) return row.attachments === item.attachments
  return row.text === (item.text ?? '')
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

