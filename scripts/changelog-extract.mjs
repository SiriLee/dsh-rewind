#!/usr/bin/env node
/**
 * changelog-extract.mjs — print the `CHANGELOG.md` block a tag owns.
 *
 * WHY: the release body is the reviewed block, not GitHub's generated text, so the
 * file is the single source. It fails loudly on a missing, empty, or inconsistent
 * block (compatibility line ≠ `engines.dsh`, compare link not ending at this tag)
 * instead of letting CI attach something half-written.
 *
 * Usage:
 *   node scripts/changelog-extract.mjs <tag|version> [--out <file>]
 *
 * Reads `CHANGELOG.md` and `package.json` from the current directory. Exits 0 with
 * the block on stdout or in `--out`, 1 on a validation failure, 2 on a usage error.
 */
import { readFileSync, writeFileSync } from 'node:fs'

/** A release version, with an optional prerelease suffix (`0.16.0-beta.1`). */
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/
/** A version heading; `[Unreleased]` deliberately does not match. */
const HEADING = /^## \[(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\](?: - \d{4}-\d{2}-\d{2})?\s*$/
/** Any `## [` heading, the block boundary. */
const ANY_HEADING = /^## \[/

/**
 * Print a usage error and exit with code 2.
 * @param message - what the caller got wrong.
 * @returns never.
 */
function usage(message) {
  console.error(`changelog-extract: ${message}`)
  console.error('usage: node scripts/changelog-extract.mjs <tag|version> [--out <file>]')
  process.exit(2)
}

/**
 * Print a validation failure and exit with code 1.
 * @param message - the failed check.
 * @returns never.
 */
function fail(message) {
  console.error(`changelog-extract: ${message}`)
  process.exit(1)
}

/**
 * Escape a string for a regular expression.
 * @param value - the literal text.
 * @returns the escaped pattern.
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Read and parse a JSON file from the working directory.
 * @param name - the file name.
 * @returns the parsed value.
 */
function readJson(name) {
  try {
    return JSON.parse(readFileSync(name, 'utf8'))
  } catch (error) {
    fail(`cannot read ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const argv = process.argv.slice(2)
let target
let out
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]
  if (arg === '--out') {
    out = argv[++i]
    if (out === undefined) usage('--out needs a file path')
  } else if (arg.startsWith('-')) {
    usage(`unknown option ${arg}`)
  } else if (target === undefined) {
    target = arg
  } else {
    usage(`unexpected argument ${arg}`)
  }
}
if (target === undefined) usage('missing the release tag or version')

const version = target.replace(/^v/, '')
if (!VERSION.test(version)) usage(`"${target}" is not a version`)

const engines = readJson('package.json')?.engines?.dsh
if (typeof engines !== 'string' || engines === '') {
  fail('package.json declares no engines.dsh')
}

let changelog
try {
  changelog = readFileSync('CHANGELOG.md', 'utf8')
} catch (error) {
  fail(`cannot read CHANGELOG.md: ${error instanceof Error ? error.message : String(error)}`)
}

const lines = changelog.split(/\r?\n/)
const starts = []
for (let i = 0; i < lines.length; i++) {
  const match = HEADING.exec(lines[i])
  if (match !== null && match[1] === version) starts.push(i)
}
if (starts.length === 0) fail(`CHANGELOG.md has no "## [${version}]" block`)
if (starts.length > 1) fail(`CHANGELOG.md has ${starts.length} "## [${version}]" blocks`)

const start = starts[0]
let end = lines.length
for (let i = start + 1; i < lines.length; i++) {
  if (ANY_HEADING.test(lines[i])) {
    end = i
    break
  }
}
const block = lines.slice(start, end).join('\n').replace(/\s+$/, '')

if (!/^- /m.test(block)) fail(`the "## [${version}]" block has no entries`)

const compare = block.match(/^\*\*Full Changelog\*\*: (\S+)$/gm) ?? []
if (compare.length !== 1) {
  fail(`the "## [${version}]" block needs exactly one "**Full Changelog**" line, found ${compare.length}`)
}
const compareUrl = /: (\S+)$/.exec(compare[0])[1]
const expectedEnd = new RegExp(`/compare/\\S+\\.\\.\\.v${escapeRegExp(version)}$`)
if (!expectedEnd.test(compareUrl)) {
  fail(`the compare link must end at v${version}: ${compareUrl}`)
}

const ranges = []
for (const line of block.split('\n')) {
  if (!line.startsWith('>')) continue
  for (const match of line.matchAll(/`(>=.+?)`/g)) ranges.push(match[1])
}
if (ranges.length === 0) fail(`the "## [${version}]" block has no "> 适配 DSH" compatibility line`)
for (const range of ranges) {
  if (range !== engines) fail(`the compatibility line says "${range}" but package.json engines.dsh is "${engines}"`)
}

if (out === undefined) {
  process.stdout.write(`${block}\n`)
} else {
  writeFileSync(out, `${block}\n`)
  console.error(`changelog-extract: wrote ${out} (${block.split('\n').length} lines)`)
}
