import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  scanZstdFrames,
  decodeZstd,
  splitSession,
  decodeEventBody,
  encodeSessionLog,
} from '../src/session-log-io.ts'

type EventInput = Record<string, unknown>
function ev(fields: EventInput): SessionEvent {
  return fields as unknown as SessionEvent
}

const HEADER = JSON.stringify({ type: 'session', version: 0, id: 'sess-1', createdAt: 1, delegationDepth: 0 })

/** A small, realistic log: two turns + a rewind marker + a compaction ref event. */
function sampleEvents(): SessionEvent[] {
  return [
    ev({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }),
    ev({ type: 'step/start', seq: 1, time: 1, data: { turn: 1, step: 1 } }),
    ev({ type: 'user/message', seq: 2, time: 2, data: { role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' }, id: 'u1' } }),
    ev({ type: 'assistant/message', seq: 3, time: 3, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], source: { kind: 'model', provider: 'p', model: 'm' }, id: 'a1' } } }),
    ev({ type: 'step/end', seq: 4, time: 3, data: { turn: 1, step: 1 } }),
    ev({ type: 'turn/end', seq: 5, time: 4, data: { turn: 1, reason: { kind: 'completed' } } }),
    ev({
      type: 'user/message', seq: 6, time: 9,
      data: { role: 'user', content: [], source: { kind: 'plugin', plugin: 'dsh-rewind' }, id: 'm1' },
      surfaceOp: { op: 'replace', start: 2, end: 5 },
      sourceEventSeqs: [2, 5],
    }),
    ev({
      type: 'compaction/summary', seq: 7, time: 20,
      data: { shadowedRange: { start: 2, end: 5 }, shadowedSeqs: [2, 3, 4, 5], messageSeqs: [2, 5], sourceEventSeq: 5 },
    }),
  ]
}

describe('session-log-io', () => {
  it('splitSession separates the header line from the event body', () => {
    const { headerLine, body } = splitSession(`${HEADER}\nturn/start line\n`)
    expect(headerLine).toBe(HEADER)
    expect(body).toBe('turn/start line\n')
  })

  it('throws on a header-less plaintext', () => {
    expect(() => splitSession('no-newline-text')).toThrow(/no header line/)
  })

  it('decodeEventBody expands packed rows and range-encoded provenance', async () => {
    // Build a body from sampleEvents, then decode it back to a fully dense list.
    const buffer = await encodeSessionLog(HEADER, sampleEvents())
    const text = await decodeZstd(buffer)
    const { body } = splitSession(text)
    const events = decodeEventBody(body)
    expect(events).toHaveLength(sampleEvents().length)
    events.forEach((e, i) => expect(e.seq).toBe(i))
    expect(events[6]!.type).toBe('user/message')
    expect((events[6]!.data as Record<string, unknown>)['source']).toEqual({ kind: 'plugin', plugin: 'dsh-rewind' })
  })

  it('round-trips {type,seq,data} losslessly through encode→decode', async () => {
    const input = sampleEvents()
    const buffer = await encodeSessionLog(HEADER, input)
    const text = await decodeZstd(buffer)
    const { body } = splitSession(text)
    const events = decodeEventBody(body)
    const normalize = (es: SessionEvent[]) => es.map(e => ({ t: e.type, s: e.seq, d: e.data }))
    expect(normalize(events)).toEqual(normalize(input))
  })

  it('produces exactly 2 frames with the header in its own frame', async () => {
    const buffer = await encodeSessionLog(HEADER, sampleEvents())
    const { frames } = scanZstdFrames(buffer)
    expect(frames).toHaveLength(2)
    // Frame 0 decodes to exactly one header line + newline.
    const frame0 = await decodeZstd(buffer.subarray(frames[0]!.start, frames[0]!.end))
    expect(frame0).toBe(`${HEADER}\n`)
  })

  it('rejects a corrupt zstd magic', async () => {
    const buffer = await encodeSessionLog(HEADER, sampleEvents())
    buffer.writeUInt32LE(0xdeadbeef, 0)
    expect(() => scanZstdFrames(buffer)).toThrow(/bad magic/)
  })

  it('preserves the header line verbatim (no re-serialization drift)', async () => {
    const buffer = await encodeSessionLog(HEADER, sampleEvents())
    const text = await decodeZstd(buffer)
    const { headerLine } = splitSession(text)
    expect(headerLine).toBe(HEADER)
  })
})
