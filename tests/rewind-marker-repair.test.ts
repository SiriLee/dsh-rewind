import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  isLegacyRewindMarker,
  isFormCMarker,
  repairRewindMarkers,
  buildRewindMarkerData,
} from '../src/rewind-marker-repair.ts'

type EventInput = Record<string, unknown>

/** Convenience: build an event object and cast to the public SessionEvent type. */
function ev(fields: EventInput): SessionEvent {
  return fields as unknown as SessionEvent
}

/** A normal completed turn, dense seq from `base`. */
function turn(base: number, n: number): SessionEvent[] {
  return [
    ev({ type: 'turn/start', seq: base + 0, time: 1, data: { turn: n } }),
    ev({ type: 'step/start', seq: base + 1, time: 1, data: { turn: n, step: 1 } }),
    ev({ type: 'user/message', seq: base + 2, time: 2, data: { role: 'user', content: [{ type: 'text', text: `q${n}` }], source: { kind: 'user' }, id: `u${n}` } }),
    ev({ type: 'assistant/message', seq: base + 3, time: 3, data: { turn: n, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: `a${n}` }], source: { kind: 'model', provider: 'p', model: 'm' }, id: `a${n}` } } }),
    ev({ type: 'step/end', seq: base + 4, time: 3, data: { turn: n, step: 1 } }),
    ev({ type: 'turn/end', seq: base + 5, time: 4, data: { turn: n, reason: { kind: 'completed' } } }),
  ]
}

/** A legacy form-C rewind marker (the shape V0.3.3 emitted): ghost-framed. */
function ghostMarker(base: number, id: string, start: number, end: number, seqs: number[]): SessionEvent[] {
  return [
    ev({ type: 'command/run', seq: base + 0, time: 9, data: {} }),
    ev({ type: 'step/start', seq: base + 1, time: 9, data: { turn: 99, step: 0 } }),
    ev({
      type: 'assistant/message', seq: base + 2, time: 9,
      data: { turn: 99, step: 0, message: { role: 'assistant', content: [], source: { kind: 'model', provider: 'dsh-rewind', model: 'rewind-marker' }, id } },
      surfaceOp: { op: 'replace', start, end },
      sourceEventSeqs: seqs,
    }),
    ev({ type: 'step/end', seq: base + 3, time: 9, data: { turn: 99, step: 0 } }),
    ev({ type: 'command/done', seq: base + 4, time: 9, data: {} }),
  ]
}

/** A legacy form-A rewind marker: bare assistant/message, no ghost frame. */
function bareMarker(base: number, id: string, start: number, end: number, seqs: number[]): SessionEvent[] {
  return [
    ev({ type: 'command/run', seq: base + 0, time: 9, data: {} }),
    ev({
      type: 'assistant/message', seq: base + 1, time: 9,
      data: { turn: 0, step: 0, message: { role: 'assistant', content: [], source: { kind: 'model', provider: 'dsh-rewind', model: 'rewind-marker' }, id } },
      surfaceOp: { op: 'replace', start, end },
      sourceEventSeqs: seqs,
    }),
    ev({ type: 'command/done', seq: base + 2, time: 9, data: {} }),
  ]
}

describe('rewind-marker-repair', () => {
  it('recognizes a legacy ghost-framed marker (form B) and rejects a normal assistant message', () => {
    const marker = ghostMarker(0, 'm1', 2, 5, [2, 5])[2]!
    expect(isLegacyRewindMarker(marker)).toBe(true)
    const normal = turn(0, 1)[3]!
    expect(isLegacyRewindMarker(normal)).toBe(false)
  })

  it('recognizes a form-C marker (idempotence baseline)', () => {
    const c = ev({
      type: 'user/message', seq: 0, time: 9,
      data: buildRewindMarkerData('m1'),
      surfaceOp: { op: 'replace', start: 2, end: 5 },
      sourceEventSeqs: [2, 5],
    })
    expect(isFormCMarker(c)).toBe(true)
    expect(isLegacyRewindMarker(c)).toBe(false)
  })

  it('B→C: deletes the 2 ghost frames, keeps command wrappers, re-denses seq, keeps the original id', () => {
    // turn(0) then a ghost marker at 6..10 (seq 8 is the marker), then turn(11).
    const input = [...turn(0, 1), ...ghostMarker(6, 'm-ghost', 2, 5, [2, 5]), ...turn(11, 2)]
    const { events, stats, mapSeq } = repairRewindMarkers(input)

    expect(stats).toEqual({ a: 0, b: 1, c: 0, removedGhosts: 2 })
    expect(events).toHaveLength(input.length - 2)

    // The marker is now a user/message at the position that was seq 8 → new seq 7.
    const marker = events[7]!
    expect(marker.type).toBe('user/message')
    expect(isFormCMarker(marker)).toBe(true)
    expect((marker.data as Record<string, unknown>)['id']).toBe('m-ghost')
    expect((marker.data as Record<string, unknown>)['role']).toBe('user')
    // The surface replace and sourceEventSeqs are preserved (refs predate the removal → unchanged).
    expect((marker as { surfaceOp?: unknown }).surfaceOp).toEqual({ op: 'replace', start: 2, end: 5 })
    expect((marker as { sourceEventSeqs?: number[] }).sourceEventSeqs).toEqual([2, 5])

    // Command wrappers survive; ghost step frames are gone.
    expect(events[6]!.type).toBe('command/run')
    expect(events[8]!.type).toBe('command/done')
    expect(events.some(e => e.type === 'step/start' && (e.data as Record<string, unknown>)['turn'] === 99)).toBe(false)

    // Dense seq: every survivor i has seq i.
    events.forEach((e, i) => expect(e.seq).toBe(i))

    // mapSeq covers every surviving original seq; the ghost seqs 7 and 9 are absent.
    expect(mapSeq.get(8)).toBe(7)
    expect(mapSeq.has(7)).toBe(false)
    expect(mapSeq.has(9)).toBe(false)
  })

  it('A→C: retypes in place with NO seq shift and preserves the id', () => {
    const input = [...turn(0, 1), ...bareMarker(6, 'm-bare', 2, 5, [2, 5]), ...turn(9, 2)]
    const { events, stats } = repairRewindMarkers(input)

    expect(stats).toEqual({ a: 1, b: 0, c: 0, removedGhosts: 0 })
    expect(events).toHaveLength(input.length) // no removals → seq unchanged

    const marker = events[7]!
    expect(marker.type).toBe('user/message')
    expect((marker.data as Record<string, unknown>)['id']).toBe('m-bare')
    events.forEach((e, i) => expect(e.seq).toBe(i))
  })

  it('rewrites reference fields through oldSeq→newSeq after a removal shifts them', () => {
    // turn(0), ghost marker at 6 (removes seq 7,9). A LATER compaction-like event
    // references seqs 11 and 14 (which shift by -2 after the removal).
    const input = [
      ...turn(0, 1),
      ...ghostMarker(6, 'm1', 2, 5, [2, 5]),
      ...turn(11, 2), // shifts to 9..14
      ev({
        type: 'compaction/summary', seq: 17, time: 20,
        data: {
          shadowedRange: { start: 11, end: 14 },
          shadowedSeqs: [11, 12, 13, 14],
          messageSeqs: [11, 14],
          sourceEventSeq: 14,
        },
      }),
    ]
    const { events } = repairRewindMarkers(input)
    const summary = events[events.length - 1]!
    const data = summary.data as Record<string, unknown>
    // 11→9, 12→10, 13→11, 14→12 (mapped through oldToNew).
    expect(data['shadowedRange']).toEqual({ start: 9, end: 12 })
    expect(data['shadowedSeqs']).toEqual([9, 10, 11, 12])
    expect(data['messageSeqs']).toEqual([9, 12])
    expect(data['sourceEventSeq']).toBe(12)
    events.forEach((e, i) => expect(e.seq).toBe(i))
  })

  it('handles stacked markers (B then A) with a single global compaction', () => {
    const input = [
      ...turn(0, 1),
      ...ghostMarker(6, 'm-1', 2, 5, [2, 5]), // removes seq 7,9
      ...bareMarker(11, 'm-2', 2, 5, [2, 5]), // no frame, retype
    ]
    const { events, stats } = repairRewindMarkers(input)
    expect(stats).toEqual({ a: 1, b: 1, c: 0, removedGhosts: 2 })
    const cMarkers = events.filter(isFormCMarker)
    expect(cMarkers).toHaveLength(2)
    expect((cMarkers[0]!.data as Record<string, unknown>)['id']).toBe('m-1')
    expect((cMarkers[1]!.data as Record<string, unknown>)['id']).toBe('m-2')
    events.forEach((e, i) => expect(e.seq).toBe(i))
  })

  it('is idempotent: a log with no legacy markers returns an unchanged result', () => {
    const input = turn(0, 1)
    const { events, stats } = repairRewindMarkers(input)
    expect(stats).toEqual({ a: 0, b: 0, c: 0, removedGhosts: 0 })
    expect(events).toHaveLength(input.length)
    expect(events[0]!.type).toBe('turn/start')
    expect(events[0]!.seq).toBe(0)
  })

  it('does not mutate deep-frozen input (decoded events are frozen)', () => {
    const input = [
      ...turn(0, 1),
      ...ghostMarker(6, 'm1', 2, 5, [2, 5]),
      ev({
        type: 'compaction/summary', seq: 11, time: 20,
        data: { shadowedRange: { start: 2, end: 5 }, shadowedSeqs: [2, 5] },
      }),
    ]
    // Freeze the whole structure recursively; the transform must copy, not mutate.
    const deepFreeze = (v: unknown): void => {
      if (v !== null && typeof v === 'object') {
        Object.freeze(v)
        for (const key of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[key])
      }
    }
    deepFreeze(input)

    expect(() => repairRewindMarkers(input)).not.toThrow()
    // Input events still frozen: mutating one throws.
    expect(() => { (input[0] as Record<string, unknown>)['seq'] = 999 }).toThrow()
  })

  it('fails closed (throws) when a reference points at a consumed seq', () => {
    const input = [
      ...turn(0, 1),
      ...ghostMarker(6, 'm1', 2, 5, [7, 9]), // references the ghost seqs that get removed
    ]
    expect(() => repairRewindMarkers(input)).toThrow(/consumed seq/)
  })

  it('buildRewindMarkerData matches the running plugin marker shape', () => {
    const data = buildRewindMarkerData('orig-id')
    expect(data).toEqual({
      role: 'user',
      content: [],
      source: { kind: 'plugin', plugin: 'dsh-rewind' },
      id: 'orig-id',
    })
  })
})
