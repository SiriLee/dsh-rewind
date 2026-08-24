/**
 * Pure pending-message matching: pairs the rendered pending-steering bubble
 * rows with the session's transient queue mirror rows (`placement === 'steering'`).
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

/** One steering occurrence from the session queue mirror. */
export interface PendingSteeringItem {
  readonly id: string
  /** Complete editable text; null when the message contains non-text blocks. */
  readonly text: string | null
}

/**
 * Pair rows to steering items by index, verifying text equality per row.
 * @param rows - pending bubble rows in DOM order (== render order).
 * @param steering - steering queue items in host order (== render order).
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
 * @param steering - steering queue items in host order (== render order).
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

