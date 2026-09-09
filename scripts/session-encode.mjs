#!/usr/bin/env node
/**
 * session-encode.mjs — compress a DSH `.jsonl.zstd` session log (single file).
 *
 * DSH stores a session log as a 2-frame zstd container:
 *   frame 0 = the ONE header line
 *   frame 1 = every event row
 * (frame 0 must be exactly one header line, and each frame is checksummed).
 *
 * This script only COMPRESSES. It does not inspect or edit any record — edit the
 * decoded plaintext with your own tool, then re-compress it here.
 *
 * Usage:
 *   node scripts/session-encode.mjs <plaintext.jsonl> -o <out.jsonl.zstd>
 */
import { zstdCompress, constants } from 'node:zlib'
import { readFile, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'

const zstdCompressAsync = promisify(zstdCompress)
const frame = (text) =>
  zstdCompressAsync(Buffer.from(text), { params: { [constants.ZSTD_c_checksumFlag]: 1 } })

const index = process.argv.indexOf('-o')
const input = process.argv[2]
const output = index !== -1 ? process.argv[index + 1] : undefined
if (!input || !output) {
  console.error('usage: node scripts/session-encode.mjs <plaintext.jsonl> -o <out.jsonl.zstd>')
  process.exit(1)
}

const text = await readFile(input, 'utf8')
const nl = text.indexOf('\n')
if (nl === -1) throw new Error('session plaintext has no header line')
const header = text.slice(0, nl)
const body = text.slice(nl + 1)

const headerFrame = await frame(header + '\n')
const bodyFrame = await frame(body.endsWith('\n') ? body : body + '\n')
await writeFile(output, Buffer.concat([headerFrame, bodyFrame]))
