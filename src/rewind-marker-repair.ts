/**
 * Pure repair core for legacy rewind markers.
 *
 * The `/dsh-rewind-fix` command rewrites the OLD plugin's rewind marker — a
 * bare `assistant/message(turn=N, step=0)` (form A) or a ghost-frame
 * `[step/start][assistant/message][step/end]` inside a closed turn (form B) —
 * into the CURRENT marker shape (form C): an empty-content `user/message` whose
 * `source` cites the plugin and whose `surfaceOp`/`sourceEventSeqs` still carry
 * the surface replace. Form C is what a 0.1.3 harness accepts.
 *
 * This module is PURE: it only recognizes event shapes and rewrites them. It
 * does zero IO and has no dependency on the harness session services. The
 * session-log IO layer (read/write) and the command orchestration live
 * elsewhere; here we export the transform plus the shared C-marker contract so
 * the running plugin and the repair agree on the exact marker data shape.
 *
 * Correctness contract:
 *   - A → C is an in-place retype (seq does NOT shift).
 *   - B → C deletes the two ghost `step/start`/`step/end` events AND re-denses
 *     every surviving event's `seq`, so the whole log is one global compaction —
 *     the same mechanism DSH's own compaction/forward-migration uses.
 *   - Every reference (surfaceOp/sourceEventSeqs/data.*) is rewritten through a
 *     single `oldSeq → newSeq` map, because deleting frames shifts every later
 *     event and a later marker's references may cite an earlier marker's seq.
 *   - A marker that survives is retargeted to form C and participates in the
 *     renumbering, so references INTO it follow the map too.
 *
 * The transform never mutates its inputs: input events are copied and the
 * mutable reference fields are rebuilt onto fresh objects (a decoded event's
 * `data` is deep-frozen, so mutating a range in place would throw).
 */
import type { SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

/** The rewind-marker source the current plugin writes (form C contract). */
export const REWIND_MARKER_SOURCE = { kind: 'plugin', plugin: 'dsh-rewind' } as const

/** The rewind-marker message content: empty (closest to "invisible"). */
export const REWIND_MARKER_CONTENT: readonly ContentBlock[] = []

/**
 * Build the form-C marker `data` (the `user/message` payload). When `id` is
 * supplied it is preserved verbatim (the repair keeps the original marker's
 * `message.id`); when omitted a fresh id is generated so the running plugin can
 * reuse this contract for its live `buildMarker()`.
 */
export function buildRewindMarkerData(id?: string): Record<string, unknown> {
  return {
    role: 'user',
    content: REWIND_MARKER_CONTENT,
    source: { ...REWIND_MARKER_SOURCE },
    ...(id !== undefined ? { id } : {}),
  }
}

/** The surface `replace` op carried by a rewind marker. */
export interface ReplaceSurfaceOp {
  op: 'replace'
  start: number
  end: number
}

/** Type guard for the surface `replace` op. */
export function isReplaceSurfaceOp(value: unknown): value is ReplaceSurfaceOp {
  return typeof value === 'object' && value !== null
    && (value as { op?: unknown }).op === 'replace'
    && typeof (value as { start?: unknown }).start === 'number'
    && typeof (value as { end?: unknown }).end === 'number'
}

/** Is `event` a legacy rewind marker in either form A or B? */
export function isLegacyRewindMarker(event: Readonly<SessionEvent>): boolean {
  return isLegacyRewindMarkerRow(asRow(event))
}

/** Is `event` already a form-C rewind marker? (the target shape) */
export function isFormCMarker(event: Readonly<SessionEvent>): boolean {
  return isFormCMarkerRow(asRow(event))
}

/** Result of {@link repairRewindMarkers}. */
export interface RepairOutput {
  /** The repaired events, densely seq'd, in log order. */
  events: SessionEvent[]
  /** original event seq → new dense seq for every SURVIVING event. */
  mapSeq: ReadonlyMap<number, number>
  /** Per-form counts observed in the repaired run. */
  stats: { a: number; b: number; c: number; removedGhosts: number }
}

/**
 * Rewrite any number of stacked rewind markers (forms A and B, interleaved)
 * into form C in one global compaction.
 *
 * @param input - the decoded event list, in log order. Not mutated.
 * @returns the repaired event list, the oldSeq→newSeq map, and per-form counts.
 * @throws {Error} when a surviving reference points at a seq that was consumed
 *   (a removed ghost frame); failing closed avoids writing a corrupt log.
 */
export function repairRewindMarkers(input: ReadonlyArray<SessionEvent | unknown>): RepairOutput {
  const rows = input.map(toRow)
  const stats = { a: 0, b: 0, c: 0, removedGhosts: 0 }
  for (const row of rows) {
    if (isFormCMarkerRow(row)) stats.c += 1
  }

  // Collect the ghost-frame indices to remove: a B marker's immediately
  // preceding `step/start` and following `step/end`. A marker without both
  // neighbors is form A (bare) and retypes in place with no seq shift.
  const removed = new Set<number>()
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]!
    if (!isLegacyRewindMarkerRow(row)) continue
    const prev = rows[i - 1]
    const next = rows[i + 1]
    const hasBefore = prev !== undefined && prev.type === 'step/start'
    const hasAfter = next !== undefined && next.type === 'step/end'
    if (hasBefore && hasAfter) {
      removed.add(i - 1)
      removed.add(i + 1)
      stats.b += 1
      stats.removedGhosts += 2
    } else {
      // A bare marker (or a marker with only a partial orphan frame, which we
      // leave for the migration chain to triage rather than write half a frame).
      stats.a += 1
    }
  }

  // Build the surviving list and the oldSeq→newSeq map in one pass.
  const survivors: SessionEvent[] = []
  const oldToNew = new Map<number, number>()
  for (let i = 0; i < rows.length; i += 1) {
    if (removed.has(i)) continue
    const original = rows[i]!
    const newSeq = survivors.length
    oldToNew.set(original.seq, newSeq)
    survivors.push(isLegacyRewindMarkerRow(original)
      ? toEvent(retargetToC(original, newSeq))
      : toEvent({ ...original, seq: newSeq }))
  }

  // Rewrite every reference through the map.
  const mapSeq = (old: number): number => {
    const mapped = oldToNew.get(old)
    if (mapped === undefined) {
      throw new Error(`rewind-fix: reference targets consumed seq ${old} (not a surviving event)`)
    }
    return mapped
  }
  const events = survivors.map((event) => toEvent(remapReferences(toRow(event), mapSeq)))

  return { events, mapSeq: oldToNew, stats }
}

/** Mutable structural view of an event (typed loosely so the transform can touch refs). */
interface Row {
  type: string
  seq: number
  time: number
  data: Record<string, unknown>
  surfaceOp?: unknown
  sourceEventSeqs?: number[]
  ignorable?: true
}

/** Row-level predicate: legacy rewind marker (form A or B). */
function isLegacyRewindMarkerRow(row: Row): boolean {
  if (row.type !== 'assistant/message') return false
  const message = row.data['message'] as Record<string, unknown> | undefined
  const source = message?.['source'] as Record<string, unknown> | undefined
  if (source?.['kind'] !== 'model') return false
  if (source?.['provider'] !== 'dsh-rewind' || source?.['model'] !== 'rewind-marker') return false
  return isReplaceSurfaceOp(row.surfaceOp)
}

/** Row-level predicate: already form-C rewind marker (the target shape). */
function isFormCMarkerRow(row: Row): boolean {
  if (row.type !== 'user/message') return false
  const source = row.data['source'] as Record<string, unknown> | undefined
  return source?.['kind'] === 'plugin' && source?.['plugin'] === 'dsh-rewind'
}

/** Rebuild a mutable {@link Row} from an event, never mutating the input. */
function asRow(event: Readonly<SessionEvent>): Row {
  const e = event as SessionEvent & { data: Record<string, unknown>; surfaceOp?: unknown; sourceEventSeqs?: number[]; ignorable?: true }
  return {
    type: e.type as string,
    seq: e.seq as number,
    time: e.time,
    data: { ...(e.data as Record<string, unknown>) },
    ...('surfaceOp' in e ? { surfaceOp: e.surfaceOp } : {}),
    ...(Array.isArray(e.sourceEventSeqs) ? { sourceEventSeqs: [...e.sourceEventSeqs] } : {}),
    ...('ignorable' in e ? { ignorable: e.ignorable } : {}),
  }
}

function toRow(event: unknown): Row {
  return asRow(event as SessionEvent)
}

/** Build a real {@link SessionEvent} object from a {@link Row}. */
function toEvent(row: Row): SessionEvent {
  const e: Record<string, unknown> = {
    type: row.type,
    seq: row.seq as SessionSeq,
    time: row.time,
    data: row.data,
  }
  if (row.surfaceOp !== undefined) e['surfaceOp'] = row.surfaceOp
  if (row.sourceEventSeqs !== undefined) e['sourceEventSeqs'] = row.sourceEventSeqs
  if (row.ignorable !== undefined) e['ignorable'] = row.ignorable
  return e as unknown as SessionEvent
}

/** The `data.*` seq-array reference fields the transform rewrites. */
type DataSeqListKey = 'shadowedSeqs' | 'messageSeqs'

/** Retarget an A/B marker row into a form-C `user/message` row at `seq`. */
function retargetToC(row: Row, seq: number): Row {
  const message = row.data['message'] as Record<string, unknown> | undefined
  const id = typeof message?.['id'] === 'string' ? message['id'] : undefined
  return {
    type: 'user/message',
    seq,
    time: row.time,
    data: buildRewindMarkerData(id),
    surfaceOp: row.surfaceOp,
    sourceEventSeqs: row.sourceEventSeqs,
  }
}

/** Rewrite every reference in `row` through `mapSeq` (oldSeq → newSeq). */
function remapReferences(row: Row, mapSeq: (old: number) => number): Row {
  const map = (value: number): number => mapSeq(value)

  if (row.sourceEventSeqs !== undefined) {
    row.sourceEventSeqs = row.sourceEventSeqs.map(map)
  }
  if (isReplaceSurfaceOp(row.surfaceOp)) {
    row.surfaceOp = { op: 'replace', start: map(row.surfaceOp.start), end: map(row.surfaceOp.end) }
  }

  const data = row.data
  // `data` is a shallow copy of the (deep-frozen) decoded payload, so a nested
  // range object is still frozen. Rebuild a NEW range object and assign it
  // onto the mutable copy rather than mutating the frozen original.
  const range = data['shadowedRange'] as { start: number; end: number } | undefined
  if (range !== undefined && typeof range === 'object') {
    data['shadowedRange'] = { start: map(range.start), end: map(range.end) }
  }
  for (const key of ['shadowedSeqs', 'messageSeqs'] as const satisfies readonly DataSeqListKey[]) {
    const seqs = data[key] as number[] | undefined
    if (Array.isArray(seqs)) data[key] = seqs.map(map)
  }
  const singleSeq = data['sourceEventSeq'] as number | undefined
  if (typeof singleSeq === 'number') data['sourceEventSeq'] = map(singleSeq)

  // The `/rewind` command's `args` target (`@<seq>`) is ALSO a rewind reference:
  // the client derives the USER-SIDE hide span from it (`hiddenSeqsOf` reads
  // `args @<target>` + `outcome.sourceEventSeq`), while the agent-side hide
  // reads the marker's `surfaceOp`/`sourceEventSeqs`. After the global seq
  // renumbering the marker references are remapped here, so the `@<seq>` in
  // `args` must follow the same map or the two sides diverge (rewound messages
  // stay visible in the UI). `@(\d+)` is the rewind-target token the plugin
  // writes; a bare index target (no `@`) and the mode words (`chat`/`both`)
  // never match it. A target that points at a consumed seq fails closed, so a
  // corrupted reference rolls the whole session back rather than masking it.
  if (row.type === 'command/run' && data['name'] === 'rewind') {
    const args = data['args']
    if (typeof args === 'string') {
      data['args'] = args.replace(/@(\d+)/g, (match, seqText: string) => {
        const seq = Number(seqText)
        return Number.isSafeInteger(seq) ? `@${mapSeq(seq)}` : match
      })
    }
  }

  return row
}

/** Result of {@link repairStaleArgs}. */
export interface StaleArgsRepair {
  /** The coherence-repaired events, in log order. */
  readonly events: SessionEvent[]
  /** Number of `/rewind` command `args` targets rewritten. */
  readonly fixed: number
}

/** The rewind-target seq parsed from a `/rewind` command's `args` string. */
export function rewindTargetSeqOfArgs(args: unknown): number | undefined {
  if (typeof args !== 'string') return undefined
  const match = args.match(/@(\d+)/)
  return match !== null ? Number(match[1]) : undefined
}

/**
 * C→C coherence repair: after a legacy→C migration renumbered a session's
 * seqs, a `/rewind` command's `args @<seq>` target can remain in the OLD
 * numbering while its (form-C) marker carries the NEW `surfaceOp.start`. The
 * client `hiddenSeqsOf` derives the USER-side hide span from
 * `args @<target>` + `outcome.sourceEventSeq`; when the two diverge it hides
 * the wrong set (the AGENT-side hide reads the marker's `sourceEventSeqs`,
 * which IS correctly remapped). This rewrites each such `@<seq>` to the
 * marker's `surfaceOp.start` — the authoritative post-migration target.
 *
 * Matching follows the same channel `hiddenSeqsOf` uses: a command/run is
 * joined to its marker via the command/done with the same `commandId` (whose
 * `sourceEventSeq` cites the marker seq). It is a no-op for a coherent session
 * (a fresh live rewind, or one already repaired), so it is idempotent and safe
 * to run on every closed session. It never mutates its input: a rewritten
 * command/run is rebuilt onto a fresh event object.
 */
export function repairStaleArgs(input: readonly SessionEvent[]): StaleArgsRepair {
  const markerBySeq = new Map<number, SessionEvent>()
  for (const event of input) {
    if (isFormCMarker(event)) markerBySeq.set(event.seq, event)
  }
  const markerSeqByCommandId = new Map<string, number>()
  for (const event of input) {
    if (event.type !== 'command/done') continue
    const data = event.data as { commandId?: unknown; sourceEventSeq?: unknown }
    if (typeof data.commandId === 'string' && typeof data.sourceEventSeq === 'number') {
      markerSeqByCommandId.set(data.commandId, data.sourceEventSeq)
    }
  }

  let fixed = 0
  const events = input.map((event): SessionEvent => {
    if (event.type !== 'command/run') return event
    const data = event.data as { name?: unknown; commandId?: unknown; args?: unknown }
    if (data.name !== 'rewind' || typeof data.commandId !== 'string' || typeof data.args !== 'string') {
      return event
    }
    const markerSeq = markerSeqByCommandId.get(data.commandId)
    const marker = markerSeq === undefined ? undefined : markerBySeq.get(markerSeq)
    const start = (marker as unknown as { surfaceOp?: { start?: unknown } } | undefined)?.surfaceOp?.start
    const target = rewindTargetSeqOfArgs(data.args)
    if (start === undefined || target === undefined || target === start) return event
    const newArgs = data.args.replace(new RegExp(`@${target}(?!\\d)`), `@${start}`)
    if (newArgs === data.args) return event
    fixed += 1
    return { ...event, data: { ...data, args: newArgs } } as SessionEvent
  })
  return { events, fixed }
}
