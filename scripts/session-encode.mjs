#!/usr/bin/env node
/**
 * session-encode.mjs — compress a DSH session log to `.jsonl.zstd` (single file).
 *
 * The artifact is a CONCATENATED 2-frame Zstandard buffer that mirrors DSH's
 * physical-format encoder (`encodePhysicalJsonl` / `compressZstdFrame`):
 *   frame 0 = zstd( the ONE header line + '\n' )
 *   frame 1 = zstd( every event row + '\n' )
 * DSH asserts frame 0 is exactly one header line (see `assertIndependentHeaderFrame`
 * in the JSONL persistence backend), so the header is NEVER combined with the
 * body. Each frame is checksummed (`ZSTD_c_checksumFlag`); a one-shot
 * `zstdCompress` must NOT use `finishFlush`, which emits a FLUSH (non-final)
 * frame that frame scanners reject.
 *
 * The decode counterpart is `scripts/session-decode.mjs` (it handles the
 * multi-frame container that a naive `zstdDecompress` under-reads). This tool is
 * the write-back side, so together they form a safe single-file codec.
 *
 * Usage (each takes one input file):
 *   node scripts/session-encode.mjs <plaintext.jsonl> [-o <out.jsonl.zstd>]
 *       Compress a plaintext session (header line + event rows) to `.jsonl.zstd`.
 *   node scripts/session-encode.mjs --fix-empty-marker <in.jsonl.zstd> [-o <out.jsonl.zstd>]
 *       Decode a session, rewrite the rewind marker whose content is an empty
 *       `user/message` (the dsh-rewind plugin source) to the `(empty message)`
 *       placeholder, then re-encode. This is the single-file migration for
 *       sessions written before the placeholder change (strict OpenAI-compatible
 *       gateways reject a truly-empty user message with HTTP 400).
 *   node scripts/session-encode.mjs --verify <in.jsonl.zstd>
 *       Decode + re-encode in place (no edit) and confirm the round-trip is
 *       table-stable (header + events survive), then report frame structure.
 */
import { zstdCompress, constants } from 'node:zlib'
import { readFile, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { decodeFile, decodeBuffer } from './session-decode.mjs'

const zstdCompressAsync = promisify(zstdCompress)
const ZSTD_MAGIC = 0xfd2fb528

/** Compress one independently decodable, checksummed frame (mirrors DSH `compressZstdFrame`). */
export async function compressFrame(input) {
  return zstdCompressAsync(Buffer.from(input), { params: { [constants.ZSTD_c_checksumFlag]: 1 } })
}

/** Split session plaintext into its independent header line and the event body. */
export function splitSession(text) {
  const nl = text.indexOf('\n')
  if (nl === -1) throw new Error('session plaintext has no header line')
  return { headerLine: text.slice(0, nl), body: text.slice(nl + 1) }
}

/**
 * Encode a header line + event body into the DSH 2-frame `.jsonl.zstd` buffer.
 * The event body is the raw storage rows (already line-separated); it is kept
 * byte-for-byte, so this is a lossless re-encode of an existing artifact.
 */
export async function encodeSession(headerLine, body) {
  const headerFrame = await compressFrame(headerLine + '\n')
  // DSH writes a trailing newline; the decoded body already ends with one, but
  // ensure it when the body came from a hand-typed plaintext without one.
  const eventFrame = body.length > 0 ? await compressFrame(body.endsWith('\n') ? body : body + '\n') : Buffer.alloc(0)
  return Buffer.concat([headerFrame, eventFrame])
}

/**
 * Scan a buffer for complete Zstandard frames (mirrors DSH `scanZstdFrames`).
 * A trailing torn frame is reported as `tornStart` and omitted.
 */
export function scanFrames(buffer) {
  const frames = []
  let off = 0
  while (off < buffer.length) {
    const start = off
    if (buffer.length - off < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(off) !== ZSTD_MAGIC) throw new Error(`corrupt zstd: bad magic @${off}`)
    off += 4
    if (off === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(off)
    off += 1
    if ((descriptor & 0x18) !== 0) throw new Error(`corrupt zstd: reserved frame-header bit @${off - 1}`)
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
      if (blockType === 0x03) throw new Error(`corrupt zstd: reserved block type @${off - 3}`)
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

/** Rewrite an empty-content form-C rewind marker (dsh-rewind plugin source) to the canonical placeholder. */
export function fixMarkerLine(line) {
  let rec
  try {
    rec = JSON.parse(line)
  } catch {
    return { line, fixed: false }
  }
  const data = rec && rec.data
  if (rec?.type !== 'user/message' || typeof data !== 'object' || data === null) return { line, fixed: false }
  if (!Array.isArray(data.content) || data.content.length !== 0) return { line, fixed: false }
  if (data.source?.kind !== 'plugin' || data.source?.plugin !== 'dsh-rewind') return { line, fixed: false }
  // Old form-C wrote empty content; the placeholder is what a strict gateway accepts.
  return {
    line: JSON.stringify({ ...rec, data: { ...data, content: [{ type: 'text', text: '(empty message)' }] } }),
    fixed: true,
  }
}

async function main() {
  const args = process.argv.slice(2)
  const usage = (msg) => {
    if (msg) process.stderr.write(msg + '\n')
    console.log(`usage:
  node scripts/session-encode.mjs <plaintext.jsonl> [-o <out.jsonl.zstd>]          compress plaintext -> .jsonl.zstd
  node scripts/session-encode.mjs --fix-empty-marker <in.jsonl.zstd> [-o <out.jsonl.zstd>]  decode + rewrite empty form-C marker + re-encode
  node scripts/session-encode.mjs --verify <in.jsonl.zstd>                       round-trip check (no write)`)
    process.exit(1)
  }

  // `--verify <in.zstd>`: decode + re-encode in memory, compare plaintexts, report frames.
  if (args[0] === '--verify') {
    const file = args[1]
    if (!file) usage('--verify requires an input file')
    const { text } = await decodeFile(file)
    const { headerLine, body } = splitSession(text)
    const buf = await encodeSession(headerLine, body)
    const { frames, tornStart } = scanFrames(buf)
    // Re-decode the re-encoded artifact to confirm the round trip.
    const retext = (await decodeBuffer(buf)).toString('utf8')
    const stable = retext === text
    console.log(`${file}: ${frames.length} frame(s)` + (tornStart !== undefined ? ' [torn tail]' : '') + (stable ? ' | round-trip stable' : ' | round-trip CHANGED'))
    process.exit(stable ? 0 : 1)
  }

  let mode = 'plaintext'
  if (args[0] === '--fix-empty-marker') {
    mode = 'fix'
    args.shift()
  }

  let input = null
  let out = null
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '-o' || args[i] === '--out') {
      out = args[i + 1]
      i += 1
    } else if (input === null) {
      input = args[i]
    } else {
      usage(`unexpected argument: ${args[i]}`)
    }
  }
  if (input === null) usage(mode === 'fix' ? '--fix-empty-marker requires an input .jsonl.zstd file' : 'missing input plaintext file')
  const output = out ?? (mode === 'fix'
    ? input.replace(/\.jsonl\.zstd$/, '') + '.fixed.jsonl.zstd'
    : input + '.zstd')

  if (mode === 'plaintext') {
    const text = await readFile(input, 'utf8')
    const { headerLine, body } = splitSession(text)
    const buf = await encodeSession(headerLine, body)
    await writeFile(output, buf)
    console.log(`wrote ${output} (${buf.length} bytes)`)
    return
  }

  // fix mode
  const { text } = await decodeFile(input)
  const { headerLine, body } = splitSession(text)
  let fixed = 0
  const fixedLines = body.split('\n').filter((line) => line.length > 0).map((line) => {
    const r = fixMarkerLine(line)
    if (r.fixed) fixed += 1
    return r.line
  })
  const buf = await encodeSession(headerLine, fixedLines.join('\n'))
  await writeFile(output, buf)
  console.log(`rewrote ${input} -> ${output} (${buf.length} bytes, ${fixed} empty form-C marker(s) fixed)`)
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
