#!/usr/bin/env node
/**
 * Offline repair for sessions corrupted by the ≤ 0.2.4 marker turn-number bug.
 *
 * Symptom: reopening a session shows
 *   Failed to load history: conversation Context …:turn-tail… received an
 *   update before its start Match (internal)
 * and the history disappears. Root cause: the rewind marker was numbered
 * `lastTurn + 1`, which is exactly how the harness numbers its NEXT real turn —
 * so the log holds an `assistant/message` (the marker) BEFORE the `turn/start`
 * of the same turn, and the client conversation-context builder rejects that
 * ordering.
 *
 * This script rewrites ONLY the `data.turn` of `dsh-rewind` empty-marker events
 * to the last turn/start that precedes them (a turn the harness has already
 * consumed and can never reuse). It preserves:
 *   - every other event byte-for-byte (seqs, times, surface metadata, …),
 *   - the JSONL record order and line structure,
 *   - the zstd multi-frame structure the persistence backend expects
 *     (each frame is decoded, fixed, and re-compressed independently, with the
 *     "last started turn" state threaded across frames).
 *
 * The original file is backed up to `session.jsonl.zstd.bak-<timestamp>` before
 * the first write. Run with the host fully stopped (a resident session would
 * overwrite the repaired file at its next checkpoint), then restart dsh web.
 *
 * Usage:
 *   node scripts/repair-markers.mjs            # scan ~/.dsh/sessions
 *   node scripts/repair-markers.mjs --dry-run  # report only, no writes
 *   node scripts/repair-markers.mjs --dir <sessions root>
 */

import { readdirSync, readFileSync, writeFileSync, copyFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = 0xfd2fb528
const MARKER_SOURCE = { provider: 'dsh-rewind', model: 'rewind-marker' }
const DEFAULT_ROOT = join(homedir(), '.dsh', 'sessions')

/** @param {Buffer} buffer @returns {{start:number,end:number}[]} */
function scanFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4 || buffer.readUInt32LE(offset) !== ZSTD_MAGIC) break
    offset += 4
    const next = buffer.indexOf(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), offset)
    frames.push(next === -1 ? { start, end: buffer.length } : { start, end: next })
    offset = next === -1 ? buffer.length : next
  }
  return frames
}

/**
 * Rewrite marker turn numbers in ONE frame's JSONL text. Line-preserving: the
 * fix never adds or removes lines, only rewrites a marker line's turn. State
 * (`lastStarted`) is threaded across frames, because a marker in a later frame
 * must know the turn/start events of earlier frames.
 * @param {string} text - this frame's JSONL text.
 * @param {{lastStarted:number}} state - running "last started turn" state.
 * @returns {{text:string, changed:number}} the fixed text (identical when
 *   nothing changed) and the number of rewritten markers in this frame.
 */
function fixMarkerTurns(text, state) {
  const lines = text.split('\n')
  let changed = 0
  const out = []
  for (const line of lines) {
    if (line.trim() === '') {
      out.push(line)
      continue
    }
    let record
    try {
      record = JSON.parse(line)
    } catch {
      out.push(line) // keep unknown/torn lines verbatim
      continue
    }
    if (record && record.type === 'turn/start' && Number.isSafeInteger(record.data?.turn)) {
      if (record.data.turn > state.lastStarted) state.lastStarted = record.data.turn
      out.push(line)
      continue
    }
    const isMarker =
      record?.type === 'assistant/message' &&
      record.data?.message?.source?.provider === MARKER_SOURCE.provider &&
      record.data?.message?.source?.model === MARKER_SOURCE.model
    if (!isMarker) {
      out.push(line)
      continue
    }
    const badTurn = record.data.turn
    if (badTurn === state.lastStarted) {
      out.push(line) // already safe (post-0.2.5 marker) — idempotent
      continue
    }
    changed += 1
    out.push(JSON.stringify({ ...record, data: { ...record.data, turn: state.lastStarted } }))
  }
  return { text: out.join('\n'), changed }
}

/** Repair one session artifact file. @returns {string} a human summary line. */
function repairFile(file, dryRun) {
  const original = readFileSync(file)
  const frames = scanFrames(original)
  const state = { lastStarted: 0 }
  const fixedTexts = []
  let changed = 0
  for (const frame of frames) {
    const frameText = zstdDecompressSync(original.subarray(frame.start, frame.end)).toString('utf8')
    const result = fixMarkerTurns(frameText, state)
    changed += result.changed
    fixedTexts.push(result.text)
  }
  if (changed === 0) return `  ok (no marker fix needed): ${file}`
  if (dryRun) return `  would fix ${changed} marker(s): ${file}`
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  copyFileSync(file, `${file}.bak-${stamp}`)
  // Preserve the zstd frame structure: one re-compressed frame per original
  // frame, in order.
  writeFileSync(file, Buffer.concat(fixedTexts.map(text => zstdCompressSync(Buffer.from(text)))))
  return `  fixed ${changed} marker(s): ${file} (backup: ${file}.bak-${stamp})`
}

function collectSessions(root) {
  const files = []
  for (const project of readdirSync(root)) {
    const projectDir = join(root, project)
    let stat
    try {
      stat = statSync(projectDir)
    } catch {
      continue
    }
    if (!stat.isDirectory()) continue
    for (const entry of readdirSync(projectDir)) {
      const file = join(projectDir, entry, 'session.jsonl.zstd')
      if (existsSync(file)) files.push(file)
    }
  }
  return files
}

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const dirIndex = args.indexOf('--dir')
const root = dirIndex !== -1 && args[dirIndex + 1] !== undefined ? args[dirIndex + 1] : DEFAULT_ROOT

if (!existsSync(root)) {
  console.error(`sessions root not found: ${root}`)
  process.exit(1)
}

console.log(`${dryRun ? '[dry-run] ' : ''}scanning ${root}`)
const files = collectSessions(root)
console.log(`${files.length} session artifact(s) found`)
let fixedCount = 0
for (const file of files) {
  try {
    const line = repairFile(file, dryRun)
    if (!line.includes('no marker fix needed')) {
      console.log(line)
      fixedCount += 1
    }
  } catch (error) {
    console.error(`  ERROR ${file}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
console.log(fixedCount === 0
  ? 'no corrupted sessions found — nothing to do'
  : `${dryRun ? 'would repair' : 'repaired'} ${fixedCount} session(s). ${dryRun ? '' : 'Restart dsh web to reload the repaired histories.'}`)
