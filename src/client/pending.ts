/**
 * Pure pending-message matching: pairs the rendered pending-steering bubble
 * rows with the session's transient queue mirror rows (`placement === 'steering'`).
 *
 * Both sides derive from the host's next-step inbox order — the ChatView
 * renders `pendingSteering` in array order and the queue mirror keeps the same
 * host order — so index-primary matching is reliable. Text equality is still
 * verified as a cross-check, and ANY ambiguity (row-count mismatch, text
 * mismatch) makes the WHOLE batch skip: the plugin degrades to no buttons
 * rather than risk attaching a retract button to the wrong message.
 *
 * The browser half lives in `portals.tsx`; this module stays DOM-free so the
 * matching contract is unit-testable in a plain node environment.
 *
 * @module dsh-rewind/client/pending
 */

/** One rendered pending-steering bubble row (only the fields matching reads). */
export interface PendingRow {
  /** The row's rendered text content (the bubble text; empty for image-only rows). */
  readonly text: string
}

/** One steering occurrence from the session queue mirror. */
export interface PendingSteeringItem {
  readonly id: string
  /** Complete editable text; null when the message contains non-text blocks. */
  readonly text: string | null
}

/**
 * Pair rows to steering items by index, verifying text equality.
 * @param rows - pending bubble rows in DOM order (== render order).
 * @param steering - steering queue items in host order (== render order).
 * @returns the item id for each row, or null per row — and an all-null result
 *   whenever the batch cannot be matched safely (length mismatch or any text
 *   mismatch).
 */
export function matchPendingRows(
  rows: readonly PendingRow[],
  steering: readonly PendingSteeringItem[],
): readonly (string | null)[] {
  if (rows.length === 0 || rows.length !== steering.length) {
    return rows.map(() => null)
  }
  const matched: (string | null)[] = []
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!
    const item = steering[i]!
    if (row.text !== (item.text ?? '')) {
      // Any mismatch aborts the whole batch (safe degradation).
      return rows.map(() => null)
    }
    matched.push(item.id)
  }
  return matched
}
