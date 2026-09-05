/**
 * Client-side structural faces over the harness-conversation types the client
 * half reads. Typed locally so the plugin never imports the conversation UI
 * packages' types (which drift between harness versions) and survives harness
 * version drift.
 *
 * Only `import type` consumers use these; they are erased at build time.
 *
 * @module dsh-rewind/client/dsh-types
 */

/** A chat-snapshot node the hiding / composer-refill logic reads. */
export interface ChatConversationViewNode {
  readonly key: string
  readonly kind?: string
  readonly data?: unknown
  readonly anchorSeq: number
}

/** A `/rewind` (or candidate-probe) command node, also reached as node.data. */
export interface CommandNode {
  readonly name?: string
  readonly args?: string | null
  readonly seq: number
  readonly outcome?: { readonly kind: 'success' | 'error'; readonly text?: string; readonly sourceEventSeq?: number } | null
}

/** A user / steering chat row: `node.data` of a `user`/`steering` node. */
export interface UserMessageNode {
  readonly seq: number
  readonly time: number
  readonly content: readonly { type: string; text?: unknown }[]
  readonly source?: unknown
}

/** The live session face the client plugin reads (chat/composer). */
export interface SessionFace {
  readonly sessionId: string
  command(command: string): Promise<{ ok: boolean; value?: { matched?: boolean } }>
  subscribe(cb: () => void): () => void
  cancel(): Promise<void>
  getSnapshot(): { chat?: unknown; queue: readonly { id: string; placement: string; preview: string; text: string | null }[]; subagent: unknown }
  updateQueue(id: string, op: { kind: 'remove' }): Promise<void>
}

/** The client plugin root context read by `apply(ctx)`. */
export interface ClientContext {
  effect(execute: () => Iterable<unknown>, label?: string): unknown
  locale: {
    register(namespace: string, messages: Record<string, Record<string, string>>): unknown
    bind(namespace: string): (key: string) => string
    subscribe(cb: () => void): () => void
  }
  sessions: {
    binding(id: unknown): { session: SessionFace } | undefined
    list: { getSnapshot(): { current?: string } }
    scope?(id: unknown): unknown
  }
  get(name: string): unknown
  slots: unknown
  commandUi: unknown
}
