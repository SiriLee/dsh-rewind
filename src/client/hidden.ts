/**
 * Pure Chat-snapshot readers and rewind-marker cut derivation.
 *
 * @module dsh-rewind/client/hidden
 */

/** The retired engine channel; its rows appear only in older session logs. */
export const RETIRED_REWIND_COMMAND = 'rewind-plugin'

/** A Chat-snapshot view node as the client readers see it. */
export interface ChatConversationViewNode {
  readonly key: string
  readonly kind?: string
  readonly data?: unknown
  readonly anchorSeq: number
  /** Owning Turn, when the node has one (used by the visibility summary pass). */
  readonly location?: { readonly turn?: { readonly turn?: unknown; readonly start?: unknown } }
  /** Chat-only row visibility; absent on older test doubles. */
  readonly visibility?: 'visible' | 'hidden'
}

/** Minimal Chat-snapshot reader the client helpers need. */
export interface HiddenChat {
  readonly order: readonly string[]
  readonly nodes: {
    get(key: string): ChatConversationViewNode | undefined
    /** Every materialized node, including hidden ones. Absent on older snapshots. */
    values?(): readonly ChatConversationViewNode[]
  }
}

/**
 * Every materialized Chat node, preferring the store's own values (which also
 * includes rows the visibility layer hid) and falling back to the visible
 * order for older snapshots / test doubles.
 * @param chat - the live chat snapshot, when available.
 * @returns all nodes in store insertion order.
 */
export function chatNodesOf(chat: HiddenChat | undefined): readonly ChatConversationViewNode[] {
  if (chat === undefined) return EMPTY_NODES
  const values = chat.nodes.values
  if (typeof values === 'function') return [...values.call(chat.nodes)]
  const nodes: ChatConversationViewNode[] = []
  for (const key of chat.order) {
    const node = chat.nodes.get(key)
    if (node !== undefined) nodes.push(node)
  }
  return nodes
}

const EMPTY_NODES: readonly ChatConversationViewNode[] = []

/**
 * Reader for one session's live chat snapshot: the chat is served by the
 * `uiConversation` service's named "chat" view (contributed by
 * dsh-client-ui-chat through the uiSession slot hook).
 */
export type ChatOf = (
  session: { readonly sessionId: string } | undefined,
) => HiddenChat | undefined

/**
 * Resolve the chat snapshot from the `uiConversation` "chat" view. The view's
 * `getSnapshot()` returns undefined until the named view is registered, which
 * degrades to `undefined` (no targets — never a crash).
 */
export function chatSnapshotOf(
  chatView: { getSnapshot(): unknown } | undefined,
): HiddenChat | undefined {
  return (chatView?.getSnapshot() ?? undefined) as HiddenChat | undefined
}

/**
 * A durable image reference carried by an `image` content block in the chat
 * snapshot, read structurally (the harness's `ImageAttachmentRef` from
 * dsh-attachment, without importing it, so the plugin survives harness
 * drift). The fields are optional here so the reader tolerates older or
 * partial snapshots; the image read only runs for a complete reference.
 */
export interface MessageImageRef {
  readonly attachmentId: string
  readonly mediaType: string
  readonly bytes?: number
  readonly width?: number
  readonly height?: number
  readonly name?: string
}

/** One wire content block that may carry a durable image reference. */
export interface ImageBlockLike {
  readonly type?: string
  readonly attachment?: {
    readonly attachmentId?: unknown
    readonly mediaType?: unknown
    readonly bytes?: unknown
    readonly width?: unknown
    readonly height?: unknown
    readonly name?: unknown
  }
}

/**
 * Image references carried by a message's content blocks, in order.
 * Malformed and non-image blocks are skipped; `file` blocks are not restorable.
 * @param content - one message's content blocks.
 * @returns the image references, in message order.
 */
export function imageRefsOf(content: readonly ImageBlockLike[] | undefined): readonly MessageImageRef[] {
  const images: MessageImageRef[] = []
  for (const block of content ?? []) {
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

/** The Conversation Definition kind that publishes the marker node. */
export const REWIND_MARKER_KIND = 'rewind-marker'

/** The marker node's cut coordinates. */
export interface RewindMarkerData {
  /** First withdrawn anchor seq (the target user message). */
  readonly target: number
  /** The marker event's seq, the last withdrawn anchor seq. */
  readonly marker: number
}

/** True for a Chat node carrying the marker's cut coordinates. */
export function hasRewindMarker(node: ChatConversationViewNode): boolean {
  const data = node.data as { readonly rewind?: unknown } | null | undefined
  return typeof data?.rewind === 'object' && data.rewind !== null
}

/** One executed rewind's cut: the target seq through the marker's seq, inclusive. */
export interface RewindCut {
  /** First withdrawn anchor seq. */
  readonly target: number
  /** Marker log seq, the last withdrawn anchor seq. */
  readonly marker: number
}

/**
 * Read every executed rewind cut from the marker nodes a Chat builder receives.
 * The marker node is produced by this plugin's marker Definition from the
 * durable rewind marker event, so the cut survives reloads and is independent
 * of how the rewind was triggered.
 * @param nodes - materialized marker nodes.
 * @returns one cut per valid marker node, in input order.
 */
export function rewindCutsOf(nodes: Iterable<ChatConversationViewNode>): RewindCut[] {
  const cuts: RewindCut[] = []
  for (const node of nodes) {
    const data = (node.data as { readonly rewind?: Partial<RewindMarkerData> } | null | undefined)?.rewind
    if (typeof data?.target !== 'number' || !Number.isSafeInteger(data.target) || data.target < 0) continue
    if (typeof data.marker !== 'number' || !Number.isSafeInteger(data.marker)) continue
    if (data.target > data.marker) continue
    cuts.push({ target: data.target, marker: data.marker })
  }
  return cuts
}
