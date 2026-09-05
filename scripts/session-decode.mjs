#!/usr/bin/env node
/**
 * session-decode.mjs — decode a DSH `.jsonl.zstd` session log to plaintext.
 *
 * WHY: DSH's `.jsonl.zstd` is a CONCATENATED multi-frame zstd container (one
 * frame per append). `zstdDecompress` on the whole buffer decodes only the
 * FIRST frame, so a naive read returns just the header + a few lines and
 * silently under-reports the log. This tool scans every frame and decodes each,
 * so the output is the COMPLETE session plaintext — the same framing semantics
 * as the DSH JSONL backend (`zstd.ts`). It is a pure, path-independent decode
 * utility; it never touches `~/.dsh` and never writes anything.
 *
 * Usage:
 *   node scripts/session-decode.mjs <file...>   # print full plaintext of each file to stdout
 *   node scripts/session-decode.mjs --stats <file...>   # per-file: bytes / frames / lines, no body
 *
 * Decoding uses Node ≥ 22 native `node:zlib` zstd primitives.
 */
import { zstdDecompress } from 'node:zlib'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'

const zd = promisify(zstdDecompress)
const ZSTD_MAGIC = 0xfd2fb528

/**
 * Scan one buffer for structurally complete zstd frames (mirrors DSH
 * `scanZstdFrames`). Complete frame ranges are returned in file order; a torn
 * final frame is reported as `tornStart` (we only decode complete frames).
 */
function scanFrames(buf) {
  const frames = []
  let off = 0
  while (off < buf.length) {
    const start = off
    if (buf.length - off < 4) return { frames, tornStart: start }
    if (buf.readUInt32LE(off) !== ZSTD_MAGIC) throw new Error(`corrupt zstd: bad magic @${off}`)
    off += 4
    if (off === buf.length) return { frames, tornStart: start }
    const descriptor = buf.readUInt8(off)
    off += 1
    if ((descriptor & 0x18) !== 0) throw new Error(`corrupt zstd: reserved header bit @${off - 1}`)
    const csf = descriptor >>> 6
    const single = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dict = descriptor & 0x03
    const dictBytes = dict === 3 ? 4 : dict
    const csBytes = csf === 0 ? (single ? 1 : 0) : 1 << csf
    const rem = (single ? 0 : 1) + dictBytes + csBytes
    if (buf.length - off < rem) return { frames, tornStart: start }
    off += rem
    for (;;) {
      if (buf.length - off < 3) return { frames, tornStart: start }
      const bh = buf.readUIntLE(off, 3)
      off += 3
      const last = (bh & 1) !== 0
      const bt = (bh >>> 1) & 0x03
      const bs = bh >>> 3
      if (bt === 0x03) throw new Error(`corrupt zstd: reserved block type @${off - 3}`)
      const payload = bt === 0x01 ? 1 : bs
      if (buf.length - off < payload) return { frames, tornStart: start }
      off += payload
      if (last) break
    }
    if (checksum) {
      if (buf.length - off < 4) return { frames, tornStart: start }
      off += 4
    }
    frames.push({ start, end: off })
  }
  return { frames }
}

/** Decompress every complete frame in one file's bytes; returns full plaintext. */
export async function decodeBuffer(data) {
  const { frames } = scanFrames(data)
  const parts = []
  for (const f of frames) parts.push(await zd(data.subarray(f.start, f.end)))
  return Buffer.concat(parts).toString('utf8')
}

/** Decompress a file path; returns { text, bytes, frames }. */
export async function decodeFile(file) {
  const data = await readFile(file)
  const { frames, tornStart } = scanFrames(data)
  const parts = []
  for (const f of frames) parts.push(await zd(data.subarray(f.start, f.end)))
  return { text: Buffer.concat(parts).toString('utf8'), bytes: data.length, frames: frames.length, tornStart }
}

async function main() {
  const args = process.argv.slice(2)
  const stats = args[0] === '--stats'
  const files = stats ? args.slice(1) : args
  if (files.length === 0) {
    console.log('usage: node scripts/session-decode.mjs [--stats] <file...>')
    process.exit(1)
  }
  for (const file of files) {
    try {
      const { text, bytes, frames, tornStart } = await decodeFile(file)
      if (stats) {
        console.log(`${file}: ${bytes}B compressed, ${frames} frame(s), ${text.length} chars, ${text.split('\n').length} line(s)` + (tornStart !== undefined ? ' [torn tail]' : ''))
      } else {
        process.stdout.write(text)
        if (!text.endsWith('\n')) process.stdout.write('\n')
      }
    } catch (e) {
      process.stderr.write(`${file}: [decode fail] ${e.message}\n`)
      process.exitCode = 1
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
