import type { ContentBlock } from '@deepseek-ai/dsh-llm'

/**
 * The rewind marker's message-source identity.
 *
 * A producer owns its source `kind` outright (`MessageSourceMap` is
 * merge-extensible and has no catch-all `plugin` kind since session format v4),
 * so this module declares the `dsh-rewind` source every marker carries. Kept in
 * a leaf with no cordis or node imports.
 *
 * @module dsh-rewind/marker
 */

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-rewind': { kind: 'dsh-rewind' }
  }
}

/** Producer kind carried by every marker this plugin appends. */
const REWIND_MARKER_KIND = 'dsh-rewind'

/**
 * The marker's constant content. It must stay provider-independent: the log is
 * append-only while the model serving a session may change, and a strict
 * OpenAI-compatible gateway rejects an empty user message (HTTP 400, Issue #21).
 */
export const REWIND_MARKER_CONTENT: readonly ContentBlock[] = Object.freeze([
  Object.freeze({ type: 'text', text: '(empty message)' }),
])

/** The marker's source: one producer-owned kind, no private fields. */
export const REWIND_MARKER_SOURCE = Object.freeze({ kind: REWIND_MARKER_KIND } as const)
