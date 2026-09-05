/**
 * Compaction compatibility: the rewind marker — a single empty `user/message`
 * surface replace on the v0.1.3/v2 line — must keep the session log replayable
 * by the harness compression pipeline.
 *
 * These drive the REAL packages (dsh-session, dsh-token-meter,
 * dsh-compaction) the way the harness does: `/compact` measures the session
 * through the token-meter's replay and then replaces a surface range with a
 * checkpoint. Because the marker is a `user/message` (not an
 * `assistant/message`), it needs no ghost `step/start`…`step/end` frame: the
 * token-meter's step machine ignores `user/message`, and the session invariant
 * imposes no open-turn requirement on it.
 */
import { describe, expect, it } from 'vitest'
import { applyRewind, appendTurn, buildTurnedSession, newMeter, simulateCompaction } from './helpers.ts'

/** The marker is the last appended event: the empty `user/message` replace. */
function markerSeqOf(session: ReturnType<typeof buildTurnedSession>): number {
  return session.snapshotEvents().at(-1)!.seq
}

describe('compact compatibility (rewind + compaction replay)', () => {
  it('token-meter replay passes with the user/message marker', () => {
    const session = buildTurnedSession()
    applyRewind(session, 8) // rewind to turn 2's question (seq 8)
    const meter = newMeter()
    expect(() => meter.measure(session)).not.toThrow()
    const measurement = meter.measure(session)
    // Surface [user1, assistant1, marker]: the marker is an empty user/message
    // and is priced at the surface — no language tokens, just small framing.
    const markerSeq = markerSeqOf(session)
    expect(measurement.nodes.map(n => n.seq)).toEqual([2, 3, markerSeq])
    expect(measurement.nodes.find(n => n.seq === markerSeq)!.tokens).toBeLessThanOrEqual(4)
  })

  it('the compaction transaction works and the meter replays the post-compaction log', () => {
    const session = buildTurnedSession()
    applyRewind(session, 8)
    const nodes = [...session.surface.nodes] // [user1, assistant1, marker]
    simulateCompaction(session, nodes[0]!, nodes[nodes.length - 1]!)
    const measurement = newMeter().measure(session)
    // One checkpoint node remains on the surface.
    expect(measurement.nodes).toHaveLength(1)
  })

  it('multi-rewind + interleaved real turns + compaction stays replayable', () => {
    const session = buildTurnedSession()
    applyRewind(session, 8) // back to turn 2's question
    appendTurn(session, 3) // a real turn 3 continues
    applyRewind(session, 2) // back to turn 1's question
    appendTurn(session, 4) // a real turn 4

    const meter = newMeter()
    expect(() => meter.measure(session)).not.toThrow()
    const before = meter.measure(session)

    const nodes = [...session.surface.nodes]
    simulateCompaction(session, nodes[0]!, nodes[nodes.length - 1]!)
    expect(() => meter.measure(session)).not.toThrow()
    expect(meter.measure(session).nodes).toHaveLength(1)
    expect(before.nodes.length).toBeGreaterThan(1)
  })

  it('every step/start the marker leaves untouched is unique (client "more than one start Match" immunity)', () => {
    const session = buildTurnedSession()
    applyRewind(session, 8)
    appendTurn(session, 3)
    applyRewind(session, 2)
    const seen = new Set<string>()
    for (const event of session.snapshotEvents()) {
      if (event.type !== 'step/start') continue
      const key = `${event.data.turn}:${event.data.step}`
      expect(seen.has(key)).toBe(false)
      seen.add(key)
    }
  })
})
