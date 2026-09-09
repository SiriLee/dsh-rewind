import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  isLegacyRewindMarker,
  isFormCMarker,
  repairRewindMarkers,
  repairStaleArgs,
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
    expect((marker.data as unknown as Record<string, unknown>)['id']).toBe('m-ghost')
    expect((marker.data as unknown as Record<string, unknown>)['role']).toBe('user')
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
    expect((marker.data as unknown as Record<string, unknown>)['id']).toBe('m-bare')
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

  it('rewrites the /rewind command args target (@<seq>) through the seq map (B-form shift)', () => {
    // turn(0..5), then a ghost marker at 6..10 (command/run @6, ghost frames 7/9
    // removed), then turn(11..16) whose user message is at original seq 13.
    // The args target @13 and the marker's refs shift by -2 after the removal.
    const input = [
      ...turn(0, 1),
      ev({ type: 'command/run', seq: 6, time: 9, data: { name: 'rewind', args: ' @13 chat' } }),
      ev({ type: 'step/start', seq: 7, time: 9, data: { turn: 99, step: 0 } }),
      ev({
        type: 'assistant/message', seq: 8, time: 9,
        data: { turn: 99, step: 0, message: { role: 'assistant', content: [], source: { kind: 'model', provider: 'dsh-rewind', model: 'rewind-marker' }, id: 'm1' } },
        surfaceOp: { op: 'replace', start: 13, end: 16 },
        sourceEventSeqs: [13, 14, 16],
      }),
      ev({ type: 'step/end', seq: 9, time: 9, data: { turn: 99, step: 0 } }),
      ev({ type: 'command/done', seq: 10, time: 9, data: { commandId: 'c', kind: 'success', sourceEventSeq: 8 } }),
      ...turn(11, 2),
    ]
    const { events } = repairRewindMarkers(input)
    // The command/run survives at new seq 6; its args target is remapped 13→11.
    const cmd = events.find(e => e.type === 'command/run')!
    expect((cmd.data as Record<string, unknown>)['args']).toBe(' @11 chat')
    // The marker reference fields (agent-side hide) are remapped in lockstep.
    const marker = events.find(e => isFormCMarker(e))!
    expect((marker as { sourceEventSeqs?: number[] }).sourceEventSeqs).toEqual([11, 12, 14])
    events.forEach((e, i) => expect(e.seq).toBe(i))
  })

  it('leaves an A-form /rewind args target unchanged (identity map)', () => {
    const input = [
      ...turn(0, 1),
      ev({ type: 'command/run', seq: 6, time: 9, data: { name: 'rewind', args: ' preview @3 both' } }),
      ev({
        type: 'assistant/message', seq: 7, time: 9,
        data: { turn: 0, step: 0, message: { role: 'assistant', content: [], source: { kind: 'model', provider: 'dsh-rewind', model: 'rewind-marker' }, id: 'm1' } },
        surfaceOp: { op: 'replace', start: 3, end: 5 },
        sourceEventSeqs: [3, 5],
      }),
      ev({ type: 'command/done', seq: 8, time: 9, data: {} }),
    ]
    const { events } = repairRewindMarkers(input)
    const cmd = events.find(e => e.type === 'command/run')!
    // No ghost frame removed → the target seq is unchanged.
    expect((cmd.data as Record<string, unknown>)['args']).toBe(' preview @3 both')
  })

  it('fails closed when a /rewind args target points at a consumed (ghost) seq', () => {
    const input = [
      ...turn(0, 1),
      ev({ type: 'command/run', seq: 6, time: 9, data: { name: 'rewind', args: ' @7 chat' } }),
      ev({ type: 'step/start', seq: 7, time: 9, data: { turn: 99, step: 0 } }),
      ev({
        type: 'assistant/message', seq: 8, time: 9,
        data: { turn: 99, step: 0, message: { role: 'assistant', content: [], source: { kind: 'model', provider: 'dsh-rewind', model: 'rewind-marker' }, id: 'm1' } },
        surfaceOp: { op: 'replace', start: 2, end: 5 },
        sourceEventSeqs: [2, 5],
      }),
      ev({ type: 'step/end', seq: 9, time: 9, data: { turn: 99, step: 0 } }),
      ev({ type: 'command/done', seq: 10, time: 9, data: {} }),
    ]
    // @7 is the removed ghost step/start seq → the map throws, failing closed.
    expect(() => repairRewindMarkers(input)).toThrow(/consumed seq/)
  })

  it('does not rewrite args on a non-rewind command/run', () => {
    const input = [
      ...turn(0, 1),
      ev({ type: 'command/run', seq: 6, time: 9, data: { name: 'app-edit', args: ' @7 on' } }),
      ev({
        type: 'assistant/message', seq: 7, time: 9,
        data: { turn: 0, step: 0, message: { role: 'assistant', content: [], source: { kind: 'model', provider: 'dsh-rewind', model: 'rewind-marker' }, id: 'm1' } },
        surfaceOp: { op: 'replace', start: 2, end: 5 },
        sourceEventSeqs: [2, 5],
      }),
      ev({ type: 'command/done', seq: 8, time: 9, data: {} }),
    ]
    const { events } = repairRewindMarkers(input)
    const cmd = events.find(e => e.type === 'command/run')!
    // name !== 'rewind' → args is left untouched even though it looks like a seq.
    expect((cmd.data as Record<string, unknown>)['args']).toBe(' @7 on')
  })

  it('repairStaleArgs: rewires a stale args target to the marker surfaceOp.start (C→C)', () => {
    // An already-form-C session created by a migration that left args in the OLD
    // numbering: args target @5 ≠ marker.surfaceOp.start=2.
    const input = [
      ev({ type: 'command/run', seq: 0, time: 9, data: { commandId: 'c1', name: 'rewind', args: ' @5 chat' } }),
      ev({ type: 'user/message', seq: 1, time: 9, data: buildRewindMarkerData('m1'), surfaceOp: { op: 'replace', start: 2, end: 5 }, sourceEventSeqs: [2, 5] }),
      ev({ type: 'command/done', seq: 2, time: 9, data: { commandId: 'c1', kind: 'success', sourceEventSeq: 1 } }),
    ]
    const { events, fixed } = repairStaleArgs(input)
    expect(fixed).toBe(1)
    const cmd = events.find(e => e.type === 'command/run')!
    expect((cmd.data as Record<string, unknown>)['args']).toBe(' @2 chat')
    // The input is never mutated (the fix rebuilds a fresh event object).
    expect((input[0]!.data as Record<string, unknown>)['args']).toBe(' @5 chat')
  })

  it('repairStaleArgs: no-op when the args target already matches surfaceOp.start (coherent)', () => {
    const input = [
      ev({ type: 'command/run', seq: 0, time: 9, data: { commandId: 'c1', name: 'rewind', args: ' @2 chat' } }),
      ev({ type: 'user/message', seq: 1, time: 9, data: buildRewindMarkerData('m1'), surfaceOp: { op: 'replace', start: 2, end: 5 }, sourceEventSeqs: [2, 5] }),
      ev({ type: 'command/done', seq: 2, time: 9, data: { commandId: 'c1', kind: 'success', sourceEventSeq: 1 } }),
    ]
    const { events, fixed } = repairStaleArgs(input)
    expect(fixed).toBe(0)
    expect((events[0]!.data as Record<string, unknown>)['args']).toBe(' @2 chat')
  })

  it('repairStaleArgs: ignores a rewind preview (no marker cited) and a non-rewind command', () => {
    const input = [
      ev({ type: 'command/run', seq: 0, time: 9, data: { commandId: 'p1', name: 'rewind', args: ' preview @99 both' } }),
      ev({ type: 'command/done', seq: 1, time: 9, data: { commandId: 'p1', kind: 'success' } }),
      ev({ type: 'command/run', seq: 2, time: 9, data: { commandId: 'e1', name: 'app-edit', args: ' @5 on' } }),
      ev({ type: 'command/done', seq: 3, time: 9, data: { commandId: 'e1', kind: 'success', sourceEventSeq: 1 } }),
    ]
    const { events, fixed } = repairStaleArgs(input)
    expect(fixed).toBe(0)
    expect((events[0]!.data as Record<string, unknown>)['args']).toBe(' preview @99 both')
    expect((events[2]!.data as Record<string, unknown>)['args']).toBe(' @5 on')
  })

  it('repairStaleArgs: does not mutate deep-frozen input', () => {
    const input = [
      ev({ type: 'command/run', seq: 0, time: 9, data: { commandId: 'c1', name: 'rewind', args: ' @5 chat' } }),
      ev({ type: 'user/message', seq: 1, time: 9, data: buildRewindMarkerData('m1'), surfaceOp: { op: 'replace', start: 2, end: 5 }, sourceEventSeqs: [2, 5] }),
      ev({ type: 'command/done', seq: 2, time: 9, data: { commandId: 'c1', kind: 'success', sourceEventSeq: 1 } }),
    ]
    const deepFreeze = (v: unknown): void => {
      if (v !== null && typeof v === 'object') {
        Object.freeze(v)
        for (const key of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[key])
      }
    }
    deepFreeze(input)
    expect(() => repairStaleArgs(input)).not.toThrow()
    expect((input[0]!.data as Record<string, unknown>)['args']).toBe(' @5 chat')
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

  it('renumbers an input form-C marker whose refs shift under a later B removal', () => {
    // turn(0..5), B marker at 6..10 (removes seq 7,9), turn(11..16), then an
    // ALREADY-form-C marker at 17 whose surfaceOp/sourceEventSeqs cite seqs 11..16.
    const input = [
      ...turn(0, 1),
      ...ghostMarker(6, 'm-1', 2, 5, [2, 5]),
      ...turn(11, 2),
      ev({
        type: 'user/message', seq: 17, time: 9,
        data: buildRewindMarkerData('existing-c'),
        surfaceOp: { op: 'replace', start: 11, end: 16 },
        sourceEventSeqs: [11, 14, 16],
      }),
    ]
    const { events, stats } = repairRewindMarkers(input)
    expect(stats).toEqual({ a: 0, b: 1, c: 1, removedGhosts: 2 })
    // The pre-existing C marker survives and its references are remapped (11→9, 14→12, 16→14).
    const c = events.find(e => isFormCMarker(e) && (e.data as Record<string, unknown>)['id'] === 'existing-c')!
    expect(c.seq).toBe(15)
    expect((c as { surfaceOp?: unknown }).surfaceOp).toEqual({ op: 'replace', start: 9, end: 14 })
    expect((c as { sourceEventSeqs?: number[] }).sourceEventSeqs).toEqual([9, 12, 14])
    events.forEach((e, i) => expect(e.seq).toBe(i))
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
      content: [{ type: 'text', text: '(empty message)' }],
      source: { kind: 'plugin', plugin: 'dsh-rewind' },
      id: 'orig-id',
    })
  })

  it('upgrades an old empty form-C marker content to the canonical placeholder', () => {
    // A pre-0.10 form-C marker wrote EMPTY content; the repair must re-fill it
    // so a strict gateway does not reject the session (Issue #21).
    const input = [
      ...turn(0, 1),
      ev({
        type: 'user/message', seq: 6, time: 9,
        data: { role: 'user', content: [], source: { kind: 'plugin', plugin: 'dsh-rewind' }, id: 'old-empty-c' },
        surfaceOp: { op: 'replace', start: 2, end: 5 },
        sourceEventSeqs: [2, 5],
      }),
    ]
    const { events, stats, contentUpgrades } = repairRewindMarkers(input)
    expect(stats).toEqual({ a: 0, b: 0, c: 1, removedGhosts: 0 })
    expect(contentUpgrades).toBe(1)
    const marker = events.find(e => isFormCMarker(e))!
    expect((marker.data as unknown as Record<string, unknown>)['id']).toBe('old-empty-c')
    expect((marker.data as unknown as Record<string, unknown>)['content']).toEqual([{ type: 'text', text: '(empty message)' }])
    events.forEach((e, i) => expect(e.seq).toBe(i))
  })

  it('normalizes a re-typed assistant/message marker (Issue #21 workaround) to canonical form-C', () => {
    // A user who hand-typed the empty form-C marker as an `assistant/message`
    // (keeping the dsh-rewind plugin source) is a form-C variant; the repair
    // retypes it back and fills the canonical placeholder.
    const input = [
      ...turn(0, 1),
      ev({
        type: 'assistant/message', seq: 6, time: 9,
        data: { turn: 0, step: 0, message: { role: 'assistant', content: [], source: { kind: 'plugin', plugin: 'dsh-rewind' }, id: 'retitled-assistant' } },
        surfaceOp: { op: 'replace', start: 2, end: 5 },
        sourceEventSeqs: [2, 5],
      }),
    ]
    const { events, stats, contentUpgrades } = repairRewindMarkers(input)
    expect(stats).toEqual({ a: 0, b: 0, c: 1, removedGhosts: 0 })
    expect(contentUpgrades).toBe(1)
    const marker = events.find(e => isFormCMarker(e))!
    expect(marker.type).toBe('user/message')
    expect((marker.data as unknown as Record<string, unknown>)['id']).toBe('retitled-assistant')
    expect((marker.data as unknown as Record<string, unknown>)['content']).toEqual([{ type: 'text', text: '(empty message)' }])
    events.forEach((e, i) => expect(e.seq).toBe(i))
  })

  it('leaves an already-canonical form-C marker untouched (no content upgrade)', () => {
    const input = [
      ...turn(0, 1),
      ev({
        type: 'user/message', seq: 6, time: 9,
        data: buildRewindMarkerData('canonical'),
        surfaceOp: { op: 'replace', start: 2, end: 5 },
        sourceEventSeqs: [2, 5],
      }),
    ]
    const { contentUpgrades } = repairRewindMarkers(input)
    expect(contentUpgrades).toBe(0)
  })
})
