/**
 * Session-log IO: a small, self-contained codec for the physical `session.jsonl.zstd`
 * artifact, and a lossless re-encoder for the `/dsh-rewind-fix` write-back.
 *
 * READ: the harness's `sessionPersistence.readRaw(id)` is reused to get the raw
 * plaintext (header line + event body). This module only splits the plaintext
 * and decodes the event body back to logical events — it never re-scans zstd
 * frames itself (that is the persistence backend's job).
 *
 * WRITE: because the persistence layer is append-only (no whole-file rewrite),
 * repairing a log requires deleting frames and re-numbering, so we re-encode the
 * whole artifact ourselves as a CONCATENATED 2-frame zstd buffer that mirrors
 * DSH's `encodePhysicalJsonl`:
 *   - frame 0 = zstd( the ONE header line + '\n' )
 *   - frame 1 = zstd( every event row, `eventLines(events, packChunks)` + '\n' )
 * `assertIndependentHeaderFrame` requires frame 0 to be exactly one header line,
 * so the header is NEVER combined with the body.
 *
 * The on-screen storage codec (`packChunkRuns`/`decodeStorageRecord` and the
 * range-encoded `sourceEventSeqs`) comes from `@deepseek-ai/dsh-session`
 * (a peer), so this module is lossless against real v0 artifacts and needs no
 * vendored copy. Round-trip is validated at the EVENT level ({type,seq,data}
 * deep-equal), not byte-for-byte (re-encoding may change row layout).
 */
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import {
  decodeSeqRanges,
  decodeStorageRecord,
  encodeSeqRanges,
  packChunkRuns,
  type SessionEvent,
  type SessionSeq,
  type StorageRecord,
} from '@deepseek-ai/dsh-session'

/** The Zstandard frame magic. */
const ZSTD_MAGIC = 0xfd2fb528

/** A complete frame's byte range within a buffer. */
export interface ZstdFrameRange {
  start: number
  end: number
}

/** Result of scanning a buffer for complete zstd frames. */
export interface ZstdFrameScan {
  frames: ZstdFrameRange[]
  /** Offset of an incomplete trailing frame, or undefined when the buffer is whole. */
  tornStart?: number
}

/**
 * Scan a buffer for structurally complete Zstandard frames (mirrors DSH
 * `scanZstdFrames`). A trailing incomplete frame is reported as `tornStart`
 * and omitted from `frames`.
 */
export function scanZstdFrames(buffer: Buffer): ZstdFrameScan {
  const frames: ZstdFrameRange[] = []
  let off = 0
  while (off < buffer.length) {
    const start = off
    if (buffer.length - off < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(off) !== ZSTD_MAGIC) throw new Error('corrupt zstd: bad magic')
    off += 4
    if (off === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(off)
    off += 1
    if ((descriptor & 0x18) !== 0) throw new Error('corrupt zstd: reserved frame-header bit')
    const csf = descriptor >>> 6
    const single = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dict = descriptor & 0x03
    const dictBytes = dict === 3 ? 4 : dict
    const csBytes = csf === 0 ? (single ? 1 : 0) : 1 << csf
    if (buffer.length - off < (single ? 0 : 1) + dictBytes + csBytes) return { frames, tornStart: start }
    off += (single ? 0 : 1) + dictBytes + csBytes
    for (;;) {
      if (buffer.length - off < 3) return { frames, tornStart: start }
      const bh = buffer.readUIntLE(off, 3)
      off += 3
      const last = (bh & 1) !== 0
      const blockType = (bh >>> 1) & 0x03
      const blockSize = bh >>> 3
      if (blockType === 0x03) throw new Error('corrupt zstd: reserved block type')
      const payload = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - off < payload) return { frames, tornStart: start }
      off += payload
      if (last) break
    }
    if (checksum) {
      if (buffer.length - off < 4) return { frames, tornStart: start }
      off += 4
    }
    frames.push({ start, end: off })
  }
  return { frames }
}

/** Compress one independently decodable, checksummed Zstandard frame (mirrors DSH `compressZstdFrame`). */
export function compressZstdFrame(input: Buffer | string): Buffer {
  return zstdCompressSync(Buffer.from(input), { params: { [constants.ZSTD_c_checksumFlag]: 1 } })
}

/** Decompress one complete Zstandard frame (validates its checksum). */
export function decompressZstdFrame(input: Buffer): Buffer {
  return zstdDecompressSync(input)
}

/** Decode a concatenated multi-frame zstd buffer to plaintext. */
export function decodeZstd(buffer: Buffer): string {
  const { frames } = scanZstdFrames(buffer)
  if (frames.length === 0) throw new Error('empty or header-less Zstandard session log')
  const plaintexts = frames.map(frame => decompressZstdFrame(buffer.subarray(frame.start, frame.end)))
  return Buffer.concat(plaintexts).toString('utf8')
}

/** One complete session plaintext split into its header line and event body. */
export interface SplitSession {
  /** The first line (a `type:'session'` record) WITHOUT its trailing newline. */
  headerLine: string
  /** Every event row, newline-separated, after the header line. */
  body: string
}

/** Split a session plaintext into an independent header line and the event body. */
export function splitSession(plaintext: string): SplitSession {
  const nl = plaintext.indexOf('\n')
  if (nl === -1) throw new Error('session plaintext has no header line')
  return { headerLine: plaintext.slice(0, nl), body: plaintext.slice(nl + 1) }
}

/** Expand a parsed storage record's range-encoded provenance back to `SessionSeq[]`. */
function expandProvenanceFromStorage(parsed: unknown): unknown {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TypeError('stored session records must be objects')
  }
  const record = parsed as { seq?: unknown; sourceEventSeqs?: unknown }
  if (record.sourceEventSeqs === undefined) return parsed
  if (!Number.isSafeInteger(record.seq) || (record.seq as number) < 0) {
    throw new TypeError('stored session event seq must be a non-negative safe integer')
  }
  return { ...record, sourceEventSeqs: decodeSeqRanges(record.sourceEventSeqs, record.seq as number) }
}

/**
 * Decode a JSONL event body into logical {@link SessionEvent}s. Layout-blind:
 * packed chunk rows and per-line rows both decode; range-encoded provenance is
 * expanded. This is the read-side counterpart that consumes the body that
 * `sessionPersistence.readRaw(id)` produced.
 */
export function decodeEventBody(body: string): SessionEvent[] {
  const events: SessionEvent[] = []
  for (const line of body.split('\n')) {
    if (line.length === 0) continue
    const record = JSON.parse(line)
    const expanded = expandProvenanceFromStorage(record)
    events.push(...decodeStorageRecord(expanded))
  }
  return events
}

/** Encode events to the physical JSONL body text (no trailing newline). */
function eventLines(events: readonly SessionEvent[], packChunks: boolean): string {
  const records: readonly StorageRecord[] = packChunks ? packChunkRuns(events) : events
  return records.map((record) => {
    const provenance = (record as { sourceEventSeqs?: SessionSeq[] }).sourceEventSeqs
    if (provenance !== undefined) {
      return JSON.stringify({ ...record, sourceEventSeqs: encodeSeqRanges(provenance) })
    }
    return JSON.stringify(record)
  }).join('\n')
}

export interface EncodeOptions {
  /** Pack delta-chunk runs into storage rows (lossless, ~60% smaller). Default true. */
  readonly packChunks?: boolean
}

/**
 * Encode a header line + events into a 2-frame Zstandard buffer (mirrors DSH
 * `encodePhysicalJsonl`): the header is its OWN frame, the body its own.
 * @param headerLine - the header JSON text, no trailing newline.
 * @param events - the repaired event list in log order.
 */
export function encodeSessionLog(headerLine: string, events: readonly SessionEvent[], options: EncodeOptions = {}): Buffer {
  const packChunks = options.packChunks ?? true
  const headerOut = headerLine + '\n'
  const bodyOut = eventLines(events, packChunks) + '\n'
  return Buffer.concat([compressZstdFrame(headerOut), compressZstdFrame(bodyOut)])
}
