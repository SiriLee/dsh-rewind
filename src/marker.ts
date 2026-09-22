/**
 * The rewind marker's message-source identity, shared by the host and the
 * client.
 *
 * A producer owns its source `kind` outright (`MessageSourceMap` is
 * merge-extensible and has no catch-all `plugin` kind since session format v4),
 * so this module declares `dsh-rewind` and owns the one predicate that
 * recognizes the marker. Keeping it in a leaf with no cordis or node imports
 * lets the browser half name the marker without pulling in the host plugin.
 *
 * @module dsh-rewind/marker
 */

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-rewind': { kind: 'dsh-rewind' }
  }
}

/** Producer kind carried by every marker this plugin appends. */
export const REWIND_MARKER_KIND = 'dsh-rewind'

/** The marker's source: one producer-owned kind, no private fields. */
export const REWIND_MARKER_SOURCE = Object.freeze({ kind: REWIND_MARKER_KIND } as const)

/**
 * Test whether a persisted message source identifies a rewind marker.
 *
 * Three shapes are recognized because a marker's source is immutable once
 * written: the current producer-owned kind, the released v3 plugin wrapper
 * (`{ kind: 'plugin', plugin: 'dsh-rewind' }`) on logs this build has not yet
 * rewritten, and the migrated form of that wrapper (`plugin:dsh-rewind`) that
 * the v3→v4 conversion produces for a producer it does not know by name.
 * @param source - source restored from a surface user message, or any stored
 *   value: a log written by an earlier build carries shapes the current union
 *   no longer names.
 * @returns whether the source carries the rewind brand.
 */
export function isRewindMarker(source: unknown): boolean {
  const candidate = source as { kind?: unknown; plugin?: unknown }
  if (candidate.kind === REWIND_MARKER_KIND) return true
  if (candidate.kind === `plugin:${REWIND_MARKER_KIND}`) return true
  return candidate.kind === 'plugin' && candidate.plugin === REWIND_MARKER_KIND
}
