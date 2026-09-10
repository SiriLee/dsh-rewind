#!/usr/bin/env node
/**
 * check-dsh-version.mjs — watch the DSH release cadence without watching the repo.
 *
 * DSH publishes every @deepseek-ai/dsh-* package at the same version, so the
 * npm "latest" of @deepseek-ai/dsh is the single authoritative release signal.
 *
 * npm's prerelease matching rule only accepts a prerelease candidate when the
 * range contains a comparator on the SAME [major, minor, patch] tuple, so a
 * peer range like "^0.1.2-rc.1" silently stops matching the day DSH bumps to a
 * new tuple (0.2.x, …) — while a release already inside the declared range
 * changes nothing. The single-line model replaces the tuple rather than
 * appending an OR term.
 *
 * Only the `latest` dist-tag is probed, by design: `latest` is what a plain
 * `npm install @deepseek-ai/dsh` resolves to, and it is the anchor this
 * single-line model is built on. A pre-release that DSH publishes under
 * another tag (`alpha`, `rc`, `next`) is deliberately NOT tracked here —
 * `npm view @deepseek-ai/dsh dist-tags` is the manual pre-release check.
 * Consequence: while the plugin sits on a pre-release line that `latest` has
 * not reached yet (the peers declare a newer tuple than `latest`), this script
 * exits 1 even though nothing needs to change. A
 * non-zero exit therefore means "the declared tuple and `latest` disagree",
 * NOT "downgrade the tuple to `latest`".
 *
 * This script compares the current DSH tuple against the tuples covered by the
 * first @deepseek-ai/dsh-* peer range in package.json and exits:
 *   0 — `latest`'s tuple is covered, no action needed.
 *   1 — the declared tuple and `latest` disagree (the ordinary forward move,
 *       or a pre-release line that `latest` has not reached); see above.
 *   2 — registry unreachable or unparseable (never blocks a release silently
 *       as "OK"; the caller decides whether to treat it as a warning).
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'))

function dshPeers(manifest) {
  return Object.keys(manifest.peerDependencies ?? {})
    .filter((name) => name.startsWith('@deepseek-ai/dsh-'))
}

function coveredTuples(range) {
  const tuples = new Set()
  for (const match of range.matchAll(/(\d+)\.(\d+)\.(\d+)/g)) {
    tuples.add(`${match[1]}.${match[2]}.${match[3]}`)
  }
  return tuples
}

const peers = dshPeers(MANIFEST)
if (peers.length === 0) {
  console.log('check-dsh-version: no @deepseek-ai/dsh-* peer declared — nothing to track')
  process.exit(0)
}

const probe = MANIFEST.peerDependencies[peers[0]]
const covered = coveredTuples(probe)

let latest
try {
  const response = await fetch('https://registry.npmjs.org/@deepseek-ai/dsh/latest')
  if (!response.ok) throw new Error(`registry responded ${response.status}`)
  latest = (await response.json()).version
} catch (error) {
  console.error(`check-dsh-version: cannot reach npm registry (${error.message})`)
  process.exit(2)
}

const tuple = /^(\d+\.\d+\.\d+)/.exec(latest)?.[1] ?? null
if (tuple === null) {
  console.error(`check-dsh-version: unparseable latest DSH version "${latest}"`)
  process.exit(2)
}

const coveredList = [...covered].sort().join(', ')
console.log(`DSH latest:      ${latest}`)
console.log(`probe peer:      ${peers[0]} = "${probe}"`)
console.log(`covered tuples:  ${coveredList}`)

if (covered.has(tuple)) {
  console.log('OK: current DSH tuple is covered — no peer change needed (same-tuple rc rolls are unaffected).')
  process.exit(0)
}

// Reached only when `latest`'s tuple is not among the covered tuples. This is
// the ordinary forward case (DSH moved past the declared tuple), but it is
// also what an alpha/rc line that `latest` has not reached produces — those
// tags are invisible here by design (see the header). No direction check is
// performed: when the peers deliberately lead `latest`, this branch is
// expected and the steps below must NOT be followed.
console.log('ACTION NEEDED: DSH moved to a new version tuple.')
if (probe.includes('||')) {
  // Multi-line (OR-union) peer: a new tuple is appended.
  console.log('  1. Append "|| ^<tuple>-rc.<n>" to every @deepseek-ai/dsh-* peer range in package.json')
  console.log('     (or a verified stable range once DSH ships a final release).')
} else {
  // Single-line peer (one release = one DSH line): the tuple is replaced.
  console.log(`  1. Update every @deepseek-ai/dsh-* peer range to "^${latest}" (single-line model: replace the tuple, do not append).`)
}
console.log('  2. Bump the @deepseek-ai/dsh-* devDependencies to ^' + latest + '.')
console.log('  3. npm install, rerun typecheck / tests / scripts/verify-host.mjs, then release.')
process.exit(1)
