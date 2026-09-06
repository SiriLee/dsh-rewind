#!/usr/bin/env node
/**
 * session-codec-v0.mjs — self-contained v0 session-storage codec.
 *
 * This module is a VERBATIM vendored copy of the DSH v0 session codec so that
 * session-log read/write tooling (scripts/zstd-rewrite.mjs and the offline
 * rewind-markers fixer) can decode and re-encode `session.jsonl.zstd` logs with
 * NO dependency on `@deepseek-ai/dsh-session` / `@deepseek-ai/dsh-brand`.
 *
 * Source of each copied piece (@deepseek-ai/dsh-session 0.1.2-rc.1):
 *   - seq-ranges  : `encodeSeqRanges` / `decodeSeqRanges` (+ isStrictlyIncreasing / assertSeq)
 *   - chunk-rows  : `packChunkRuns` / `decodeStorageRecord` (+ classify / buildRow / validate…)
 *   - types       : `SessionSeq`
 *   - dsh-brand   : `brandString` / `brandNumber`
 *
 * WHY v0 only, and why it is safe to vendor: the DSH v0 physical format is
 * FROZEN — the harness is migrating away from it (v0 → v2) and will not change
 * how existing v0 logs are written. So these copies stay correct for every
 * already-written v0 file, and the tool runs regardless of which
 * `@deepseek-ai/dsh-session` version is installed. Keep this file in lockstep
 * with DSH on format changes; do NOT rewrite the logic. The two brand helpers
 * are runtime-identity (compile-time only), so they are trivially portable.
 *
 * Exports: decodeSeqRanges, encodeSeqRanges, decodeStorageRecord, packChunkRuns.
 */

// ---- brand helpers (runtime identity; compile-time only) ----
function brandString(value) {
  return value
}
function brandNumber(value) {
  return value
}

/** Admit a numeric value as an existing Session event position. */
function SessionSeq(value) {
  if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
    throw new TypeError(`SessionSeq must be a non-negative safe integer, got ${String(value)}`)
  }
  return brandNumber(value)
}

// ---- seq-ranges ---- //

function isStrictlyIncreasing(values) {
  return values.every((value, index) => index === 0 || value > values[index - 1])
}

/**
 * Replace profitable consecutive runs with inclusive pairs.
 * @param {number[]} values - validated in-memory source sequences.
 * @returns a lossless JSON storage form.
 */
export function encodeSeqRanges(values) {
  if (!isStrictlyIncreasing(values)) return [...values]
  const encoded = []
  for (let start = 0; start < values.length;) {
    let end = start
    while (end + 1 < values.length && values[end + 1] === values[end] + 1) end += 1
    if (end - start >= 2) encoded.push([values[start], values[end]])
    else for (let index = start; index <= end; index += 1) encoded.push(values[index])
    start = end + 1
  }
  return encoded
}

/**
 * Expand a JSON storage-form source sequence array.
 * @param {unknown} value - parsed storage value.
 * @param {number} [maxEntries] - largest list permitted by the owning event.
 * @returns {number[]} the in-memory source sequences.
 */
export function decodeSeqRanges(value, maxEntries = Number.MAX_SAFE_INTEGER) {
  if (!Array.isArray(value)) throw new TypeError('sourceEventSeqs must be an array')
  const decoded = []
  let hasRange = false
  for (const entry of value) {
    if (typeof entry === 'number') {
      assertSeq(entry)
      if (decoded.length >= maxEntries) throw new TypeError('sourceEventSeqs exceeds its event sequence')
      decoded.push(SessionSeq(entry))
      continue
    }
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new TypeError('sourceEventSeqs range entries must be [start, end] pairs')
    }
    const start = entry[0]
    const end = entry[1]
    assertSeq(start)
    assertSeq(end)
    if (end < start) throw new TypeError('sourceEventSeqs ranges require start <= end')
    const length = end - start + 1
    if (length > maxEntries - decoded.length) {
      throw new TypeError('sourceEventSeqs range exceeds its event sequence')
    }
    for (let seq = start; seq <= end; seq += 1) decoded.push(SessionSeq(seq))
    hasRange = true
  }
  if (hasRange && !isStrictlyIncreasing(decoded)) {
    throw new TypeError('sourceEventSeqs ranges must be strictly increasing')
  }
  return decoded
}

function assertSeq(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('sourceEventSeqs must contain non-negative safe integers')
  }
}

// ---- chunk-rows ---- //

/** Minimum members before a run packs. A format constant, not a tunable. */
const MIN_RUN = 3

function isRecord(value) {
  return typeof value === 'object' && value !== null
}

/** Exact-key check: `value` has every key in `keys` and nothing else. */
function hasExactKeys(value, keys) {
  return Object.keys(value).length === keys.length && keys.every((k) => Object.hasOwn(value, k))
}

/** Classify an event for packing; whitelisted shape => delta kind, else undefined (store verbatim). */
function classify(event) {
  if (event.type !== 'assistant/chunk') return undefined
  if (!hasExactKeys(event, ['type', 'seq', 'time', 'data'])) return undefined
  if (
    !Number.isSafeInteger(event.seq) || event.seq < 0 || Object.is(event.seq, -0)
    || !Number.isSafeInteger(event.time)
  ) return undefined
  const data = event.data
  if (!isRecord(data) || !hasExactKeys(data, ['turn', 'step', 'chunk'])) return undefined
  if (typeof data.turn !== 'number' || typeof data.step !== 'number') return undefined
  const chunk = data.chunk
  if (!isRecord(chunk) || typeof chunk.index !== 'number') return undefined
  switch (chunk.type) {
    case 'text-delta':
    case 'reasoning-delta':
      return hasExactKeys(chunk, ['type', 'index', 'text']) && typeof chunk.text === 'string'
        ? chunk.type
        : undefined
    case 'tool-call-delta': {
      const shapeOk = hasExactKeys(chunk, ['type', 'index', 'id', 'argumentsDelta'])
        || (hasExactKeys(chunk, ['type', 'index', 'id', 'name', 'argumentsDelta']) && typeof chunk.name === 'string')
      return shapeOk && typeof chunk.id === 'string' && typeof chunk.argumentsDelta === 'string'
        ? chunk.type
        : undefined
    }
    default:
      return undefined
  }
}

/** The tool-call fields of a whitelisted delta chunk. */
function toolCallOf(event) {
  return event.data.chunk
}

/** The block index of a whitelisted delta chunk. */
function indexOf(event) {
  return event.data.chunk.index
}

/** Whether `next` extends a run ending in `prev` (same kind already checked by the caller). */
function continues(prev, next, kind) {
  if (next.seq !== prev.seq + 1) return false
  if (!Number.isSafeInteger(next.time - prev.time)) return false
  if (next.data.turn !== prev.data.turn || next.data.step !== prev.data.step) return false
  if (indexOf(next) !== indexOf(prev)) return false
  if (kind !== 'tool-call-delta') return true
  const a = toolCallOf(prev)
  const b = toolCallOf(next)
  return a.id === b.id && Object.hasOwn(a, 'name') === Object.hasOwn(b, 'name') && a.name === b.name
}

/** Build the row for a completed run (`run.length >= MIN_RUN`, uniform per {@link continues}). */
function buildRow(kind, run) {
  const first = run[0]
  const base = {
    turn: first.data.turn,
    step: first.data.step,
    index: indexOf(first),
    dt: run.slice(1).map((event, i) => event.time - run[i].time),
  }
  const envelope = { seq0: first.seq, time0: first.time }
  if (kind === 'tool-call-delta') {
    const call = toolCallOf(first)
    return {
      type: 'tool-call-chunks',
      ...envelope,
      data: {
        ...base,
        id: brandString(call.id),
        ...(Object.hasOwn(call, 'name') ? { name: call.name } : {}),
        args: run.map((event) => event.data.chunk.argumentsDelta),
      },
    }
  }
  const data = { ...base, texts: run.map((event) => event.data.chunk.text) }
  return kind === 'text-delta'
    ? { type: 'text-chunks', ...envelope, data }
    : { type: 'reasoning-chunks', ...envelope, data }
}

/**
 * Pack an event batch for storage: each run of at least MIN_RUN consecutive
 * whitelisted same-kind, same-block delta chunk events becomes one row; every
 * other event passes through verbatim, in order. Pure and stateless.
 * @param {readonly object[]} events - the batch to encode, in log order.
 * @returns {object[]} the storage records to write, one JSONL line each.
 */
export function packChunkRuns(events) {
  const out = []
  let kind
  let run = []
  const flush = () => {
    if (kind !== undefined && run.length >= MIN_RUN) out.push(buildRow(kind, run))
    else out.push(...run)
    kind = undefined
    run = []
  }
  for (const event of events) {
    const k = classify(event)
    if (k === undefined) {
      flush()
      out.push(event)
      continue
    }
    const delta = event
    const last = run[run.length - 1]
    if (k === kind && last !== undefined && continues(last, delta, k)) {
      run.push(delta)
      continue
    }
    flush()
    kind = k
    run = [delta]
  }
  flush()
  return out
}

/** Throw the uniform malformed-row diagnostic. */
function malformed(tag, why) {
  throw new Error(`malformed ${tag} storage row: ${why}`)
}

/** Validate the shared run-data fields and the payload/dt arity; returns the member payload. */
function validateRunData(tag, data, payloadKey) {
  if (typeof data.turn !== 'number' || typeof data.step !== 'number' || typeof data.index !== 'number') {
    malformed(tag, 'turn/step/index must be numbers')
  }
  const payload = data[payloadKey]
  if (!Array.isArray(payload) || payload.length === 0 || payload.some((entry) => typeof entry !== 'string')) {
    malformed(tag, `${payloadKey} must be a non-empty string array`)
  }
  const dt = data.dt
  if (!Array.isArray(dt) || dt.some((gap) => !Number.isSafeInteger(gap))) {
    malformed(tag, 'dt must be an array of safe integers')
  }
  if (dt.length !== payload.length - 1) {
    malformed(tag, `dt length ${dt.length} does not match ${payload.length} members`)
  }
  return payload
}

/** Validate a row-tagged parsed value's envelope and data, throwing on any malformation. */
function validateRow(value, tag) {
  if (!hasExactKeys(value, ['type', 'seq0', 'time0', 'data'])) {
    malformed(tag, 'envelope must be exactly {type, seq0, time0, data}')
  }
  if (!Number.isSafeInteger(value.seq0) || value.seq0 < 0 || Object.is(value.seq0, -0)) {
    malformed(tag, 'seq0 must be a non-negative safe integer')
  }
  if (!Number.isSafeInteger(value.time0)) {
    malformed(tag, 'time0 must be a safe integer')
  }
  const data = value.data
  if (!isRecord(data)) malformed(tag, 'data must be an object')
  let payload
  if (tag === 'tool-call-chunks') {
    const withName = hasExactKeys(data, ['turn', 'step', 'index', 'id', 'name', 'dt', 'args'])
    if (!withName && !hasExactKeys(data, ['turn', 'step', 'index', 'id', 'dt', 'args'])) {
      malformed(tag, 'data must be exactly {turn, step, index, id, name?, dt, args}')
    }
    if (typeof data.id !== 'string' || (withName && typeof data.name !== 'string')) {
      malformed(tag, 'id (and name when present) must be strings')
    }
    payload = validateRunData(tag, data, 'args')
  } else {
    if (!hasExactKeys(data, ['turn', 'step', 'index', 'dt', 'texts'])) {
      malformed(tag, 'data must be exactly {turn, step, index, dt, texts}')
    }
    payload = validateRunData(tag, data, 'texts')
  }
  if (payload.length - 1 > Number.MAX_SAFE_INTEGER - value.seq0) {
    malformed(tag, 'member seqs must stay safe integers')
  }
  let time = value.time0
  for (const gap of data.dt) {
    time += gap
    if (!Number.isSafeInteger(time)) malformed(tag, 'member times must stay safe integers')
  }
  SessionSeq(value.seq0)
  return value
}

/** Expand a validated row back into its exact original events, in order. */
function expandRow(row) {
  const members = row.type === 'tool-call-chunks' ? row.data.args : row.data.texts
  const events = []
  let time = row.time0
  for (let k = 0; k < members.length; k++) {
    if (k > 0) time += row.data.dt[k - 1]
    let chunk
    switch (row.type) {
      case 'text-chunks':
        chunk = { type: 'text-delta', index: row.data.index, text: members[k] }
        break
      case 'reasoning-chunks':
        chunk = { type: 'reasoning-delta', index: row.data.index, text: members[k] }
        break
      case 'tool-call-chunks':
        chunk = {
          type: 'tool-call-delta',
          index: row.data.index,
          id: row.data.id,
          ...(Object.hasOwn(row.data, 'name') ? { name: row.data.name } : {}),
          argumentsDelta: members[k],
        }
        break
      default: {
        const unreachable = row
        throw new Error(`chunk-rows received unsupported row ${String(unreachable)}`)
      }
    }
    events.push({
      type: 'assistant/chunk',
      seq: SessionSeq(row.seq0 + k),
      time,
      data: { turn: row.data.turn, step: row.data.step, chunk },
    })
  }
  return events
}

/**
 * Decode one parsed JSONL line value into the session event(s) it stores.
 * Chunk-row-tagged values validate and expand; every other value passes through
 * as a single event after admitting a numeric `seq` through the sequence brand.
 * @param {unknown} value - one line's `JSON.parse` result.
 * @returns {unknown[]} the stored events, in log order.
 */
export function decodeStorageRecord(value) {
  if (!isRecord(value)) return [value]
  const tag = value.type
  if (tag !== 'text-chunks' && tag !== 'reasoning-chunks' && tag !== 'tool-call-chunks') {
    if (typeof value.seq === 'number') SessionSeq(value.seq)
    return [value]
  }
  return expandRow(validateRow(value, tag))
}
