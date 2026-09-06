#!/usr/bin/env node
/**
 * zstd-rewrite.mjs — lossless re-encode a DSH `.jsonl.zstd` session log, and
 * round-trip-validate the encoder.
 *
 * WHY: DSH's `.jsonl.zstd` is a CONCATENATED multi-frame zstd container with a
 * strict layout (see `session-persistence-jsonl/src/generation.ts`
 * `encodePhysicalJsonl`):
 *   - frame 0  = zstd( the ONE header line + '\n' )
 *   - frame 1  = zstd( the body: every event row, eventLines(...) + '\n' )
 * `assertIndependentHeaderFrame` REQUIRES frame 0 to be exactly one header line.
 * Re-encoding therefore must mirror that 2-frame shape, never header+body in a
 * single frame. The body uses a self-contained copy of the v0 storage codec
 * (see `../vendor/session-codec-v0.mjs`, vendored verbatim from
 * `@deepseek-ai/dsh-session` 0.1.2-rc.1): `packChunkRuns(events)` then
 * each record `JSON.stringify({ ...r, sourceEventSeqs: encodeSeqRanges(...) })`.
 * No `@deepseek-ai/*` package is imported — the tool reads/writes v0 session
 * files regardless of which DSH version is installed.
 *
 * This tool:
 *   - `--roundtrip <file>`      decode -> re-encode (2-frame) -> re-decode, then
 *                               assert every event (seq/type/time/sourceEventSeqs)
 *                               is identical; NO writes. Validates the encoder.
 *   - `--encode <in> <out>`     lossless re-encode a session to a new file.
 *   - `--stats <file>`          per-file: bytes / frames / lines, no body output.
 *
 * It never touches `~/.dsh` unless you point `--encode` at a real path; the
 * default `--roundtrip`/`--stats` are read-only. Node ≥ 22 native zstd.
 */
import { zstdCompressSync, zstdDecompress, constants } from 'node:zlib'
import { readFile, writeFile } from 'node:fs/promises'
import { isDeepStrictEqual, promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { decodeSeqRanges, decodeStorageRecord, encodeSeqRanges, packChunkRuns } from '../vendor/session-codec-v0.mjs'

const zd = promisify(zstdDecompress)
const ZSTD_MAGIC = 0xfd2fb528

/** Scan a buffer for complete zstd frames (mirrors DSH `scanZstdFrames`). */
function scanFrames(buf) {
  const frames = []
  let off = 0
  while (off < buf.length) {
    const start = off
    if (buf.length - off < 4) return { frames, tornStart: start }
    if (buf.readUInt32LE(off) !== ZSTD_MAGIC) throw new Error(`corrupt zstd: bad magic @${off}`)
    off += 4
    if (off === buf.length) return { frames, tornStart: start }
    const descriptor = buf.readUInt8(off); off += 1
    if ((descriptor & 0x18) !== 0) throw new Error(`corrupt zstd: reserved frame-header bit @${off - 1}`)
    const csf = descriptor >>> 6
    const single = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dict = descriptor & 0x03
    const dictBytes = dict === 3 ? 4 : dict
    const csBytes = csf === 0 ? (single ? 1 : 0) : 1 << csf
    if (buf.length - off < (single ? 0 : 1) + dictBytes + csBytes) return { frames, tornStart: start }
    off += (single ? 0 : 1) + dictBytes + csBytes
    for (;;) {
      if (buf.length - off < 3) return { frames, tornStart: start }
      const bh = buf.readUIntLE(off, 3); off += 3
      const last = (bh & 1) !== 0
      const blockType = (bh >>> 1) & 0x03
      const blockSize = bh >>> 3
      if (blockType === 0x03) throw new Error(`corrupt zstd: reserved block type @${off - 3}`)
      const payload = blockType === 0x01 ? 1 : blockSize
      if (buf.length - off < payload) return { frames, tornStart: start }
      off += payload
      if (last) break
    }
    if (checksum) { if (buf.length - off < 4) return { frames, tornStart: start }; off += 4 }
    frames.push({ start, end: off })
  }
  return { frames }
}

/** Decode a concat-frame zstd buffer to plaintext (all frames). */
async function decodeZstd(buf) {
  const { frames } = scanFrames(buf)
  const out = new Array(frames.length)
  let n = 0
  async function run() {
    while (n < frames.length) { const i = n++; out[i] = await zd(buf.subarray(frames[i].start, frames[i].end)) }
  }
  await Promise.all(Array.from({ length: Math.min(8, frames.length) }, run))
  return { plaintext: Buffer.concat(out).toString('utf8'), frames: frames.length }
}

/** One COMPLETE session: header line + event rows. */
function splitSession(plaintext) {
  const nl = plaintext.indexOf('\n')
  if (nl === -1) throw new Error('session plaintext has no header line')
  return { headerLine: plaintext.slice(0, nl), body: plaintext.slice(nl + 1) }
}

/** Encode events to the physical JSONL body, mirroring 0.1.2 `eventLines`. */
function eventLines(events, packChunks = true) {
  const records = packChunks ? packChunkRuns(events) : events
  return records.map(r => JSON.stringify('sourceEventSeqs' in r ? { ...r, sourceEventSeqs: encodeSeqRanges(r.sourceEventSeqs) } : r)).join('\n')
}

/** Compress one frame with DSH's checksummed options (mirror `compressZstdFrame`). */
function compressFrame(plain) {
  return zstdCompressSync(Buffer.from(plain, 'utf8'), { params: { [constants.ZSTD_c_checksumFlag]: 1 } })
}

/** Encode headerLine + events -> 2-frame zstd buffer (mirror `encodePhysicalJsonl`). */
export function encodeSession(headerLine, events, packChunks = true) {
  const headerOut = headerLine + '\n'
  const bodyOut = eventLines(events, packChunks) + '\n'
  return Buffer.concat([compressFrame(headerOut), compressFrame(bodyOut)])
}

/** Decode the body (event rows) to session events. `expand=true` also decodes range-encoded `sourceEventSeqs`. */
function decodeBody(body, { expand = true } = {}) {
  const events = []
  for (const line of body.split('\n').filter(Boolean)) {
    const record = JSON.parse(line)
    const expanded = expand && record.sourceEventSeqs !== undefined
      ? { ...record, sourceEventSeqs: decodeSeqRanges(record.sourceEventSeqs, record.seq) }
      : record
    for (const e of decodeStorageRecord(expanded)) events.push(e)
  }
  return events
}

/** Decode a session file to { headerLine, events, frames, rows } (decompressed events). */
export async function decodeSessionFile(file, { expand = true } = {}) {
  const buf = await readFile(file)
  const { plaintext, frames } = await decodeZstd(buf)
  const { headerLine, body } = splitSession(plaintext)
  return { headerLine, events: decodeBody(body, { expand }), frames, rows: body.split('\n').filter(Boolean).length }
}

/** Round-trip validate: decode -> re-encode (2-frame) -> re-decode, compare events deeply. */
export async function roundtrip(file, { packChunks = true } = {}) {
  const a = await decodeSessionFile(file)
  const out = encodeSession(a.headerLine, a.events, packChunks)
  const re = await decodeZstd(out)
  const { headerLine: _h, body } = splitSession(re.plaintext)
  const bEvents = decodeBody(body)
  const equal = a.events.length === bEvents.length && a.events.every((e, i) => isDeepStrictEqual(e, bEvents[i]))
  return { frames: a.frames, eventsBefore: a.events.length, eventsAfter: bEvents.length, equal }
}

// ---- CLI (only when invoked as a script, never on import) ----
const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const [,, cmd, ...rest] = process.argv
  async function main() {
    if (cmd === '--roundtrip') {
      const file = rest[0]
      const r = await roundtrip(file)
      console.log(`roundtrip ${file}: frames=${r.frames} events=${r.eventsBefore}->${r.eventsAfter} ${r.equal ? 'IDENTICAL' : 'DIFFERS'}`)
      process.exitCode = r.equal ? 0 : 1
      return
    }
    if (cmd === '--encode') {
      const [inFile, outFile] = rest
      const s = await decodeSessionFile(inFile)
      await writeFile(outFile, encodeSession(s.headerLine, s.events))
      console.log(`encoded ${inFile} -> ${outFile} (events=${s.events.length} frames=2)`)
      return
    }
    if (cmd === '--stats') {
      const file = rest[0]
      const s = await decodeSessionFile(file)
      console.log(`stats ${file}: frames=${s.frames} rows=${s.rows} events=${s.events.length}`)
      return
    }
    console.log('usage: node scripts/zstd-rewrite.mjs --roundtrip <file> | --encode <in> <out> | --stats <file>')
  }
  main().catch(e => { console.error(String(e).slice(0, 300)); process.exit(1) })
}
