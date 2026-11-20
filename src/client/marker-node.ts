/** The hidden data source for a rewind marker's withdrawn span. The Chat message
 * Definition rejects replace-surface markers, so this Definition publishes a
 * hidden node carrying the cut for the visibility wrapper.
 *
 * @module dsh-rewind/client/marker-node
 */

import { REWIND_MARKER_KIND, type RewindMarkerData } from './hidden.ts'

/** The producer kind carried by this plugin's marker events. */
const MARKER_SOURCE_KIND = 'dsh-rewind'

/** The event subset the marker Definition reads. */
interface MarkerEventLike {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: {
    readonly id?: unknown
    readonly source?: { readonly kind?: unknown }
    readonly content?: readonly { readonly type?: string; readonly text?: unknown }[]
  }
  readonly surfaceOp?: { readonly op?: unknown }
  readonly sourceEventSeqs?: readonly unknown[]
}

/** The assembled Context subset the Definition reads. */
interface MarkerContextLike {
  readonly start?: { readonly event?: MarkerEventLike }
  readonly state?: RewindMarkerData
}

/** The view node this Definition publishes: a hidden context node plus the cut. */
interface MarkerViewNode {
  readonly key: string
  readonly kind: 'context'
  readonly id: string
  readonly target: string
  readonly anchorSeq: number
  /** The marker is appended while idle, outside any turn. */
  readonly location: { readonly kind: 'session' }
  readonly data: {
    readonly seq: number
    readonly time: number
    readonly content: readonly { readonly type?: string; readonly text?: unknown }[]
    readonly source: unknown
    readonly producer: { readonly role: 'inject'; readonly label: string }
    readonly form: null
    readonly rewind: RewindMarkerData
  }
  readonly visibility: 'hidden'
}

/** The event-registry registration shape this plugin uses. */
export interface MarkerEventRegistry {
  register(definition: unknown): () => void
}

/** One marker Definition contribution. */
export interface RewindMarkerDefinition {
  readonly kind: string
  readonly target: 'chat'
  readonly match: {
    readonly 'user/message': (event: unknown) => { readonly id: string; readonly role: 'start' } | null
  }
  start(context: unknown, match: unknown): RewindMarkerData
  buildViewNode(context: unknown): MarkerViewNode | null
}

/** True for the exact surface-replace shape this plugin's marker carries. */
function isReplacementSurface(op: unknown): boolean {
  return typeof op === 'object' && op !== null && (op as { readonly op?: unknown }).op === 'replace'
}

/** Narrow one unknown value to the marker event shape. */
function markerEvent(value: unknown): MarkerEventLike | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  return value as MarkerEventLike
}

/** The stable Context key the assembler assigns to one match id. */
function markerKey(id: string): string {
  return `${REWIND_MARKER_KIND.length}:${REWIND_MARKER_KIND}${id}`
}

/**
 * Build the marker Definition. It matches only this plugin's marker: a
 * replacement-surface `user/message` carrying the producer source and a
 * non-empty durable source list. Content is deliberately not asserted; the
 * producer source is the distinguishing fact.
 * @returns the Definition the event registry registers.
 */
export function rewindMarkerDefinition(): RewindMarkerDefinition {
  const match = (value: unknown): { readonly id: string; readonly role: 'start' } | null => {
    const event = markerEvent(value)
    if (event?.type !== 'user/message') return null
    if (!isReplacementSurface(event.surfaceOp)) return null
    if (event.data.source?.kind !== MARKER_SOURCE_KIND) return null
    const id = event.data.id
    if (typeof id !== 'string' || id.length === 0) return null
    const sources = event.sourceEventSeqs
    if (!Array.isArray(sources) || sources.length === 0) return null
    if (!sources.every(seq => typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0)) return null
    return { id, role: 'start' }
  }
  return {
    kind: REWIND_MARKER_KIND,
    target: 'chat',
    // A table routes only user/message here; a function would join the
    // unrestricted set and be called for every event.
    match: { 'user/message': match },
    start(_context, match) {
      const event = markerEvent((match as { readonly event?: unknown } | null)?.event)
      const sources = event?.sourceEventSeqs
      if (event === undefined || !Array.isArray(sources) || sources.length === 0) {
        throw new Error('rewind-marker start requires a marker event')
      }
      return { target: sources[0] as number, marker: event.seq }
    },
    buildViewNode(context) {
      const value = context as MarkerContextLike
      const data = value.state
      const event = value.start?.event
      const id = event?.data.id
      if (data === undefined || event === undefined || typeof id !== 'string' || id.length === 0) return null
      // SEAM: this hidden `context` node with producer `inject` is the only
      // place the plugin relies on the Chat assembler tolerating a synthetic
      // node shape. Unit tests cannot exercise that assembler; verify this in a
      // real page first when reviewing, and keep the node Location present.
      // A known Chat kind keeps the target's own builder compatible; the wrapper
      // hides this context node before it can render and reads `rewind` for cuts.
      return {
        key: markerKey(id),
        kind: 'context',
        id,
        target: 'chat',
        anchorSeq: data.marker,
        location: { kind: 'session' },
        data: {
          seq: data.marker,
          time: event.time,
          content: event.data.content ?? [],
          source: event.data.source,
          producer: { role: 'inject', label: 'dsh-rewind' },
          form: null,
          rewind: data,
        },
        visibility: 'hidden',
      }
    },
  }
}

/**
 * Register the marker Definition for the caller's lifetime.
 * @param events - the `uiConversation.events` registry.
 * @returns the idempotent disposer.
 */
export function registerRewindMarker(events: MarkerEventRegistry): () => void {
  return events.register(rewindMarkerDefinition())
}
