// Update the shields.io "tests" badge (a GitHub Gist badge.json) from the
// vitest JSON reporter output. Called by .github/workflows/ci.yml after the
// test run; keeps the badge in sync on every CI run on the canonical repo's
// main branch.
//
// Env:
//   GIST_TOKEN - GitHub PAT with the `gist` scope
//   GIST_ID    - ID of the gist holding badge.json
//
// Input (argv[2]): a vitest `--reporter=json` output file.
//
// Exits 0 even when tests fail so the badge still updates (with a red color).
import { readFileSync } from 'node:fs'

const resultsFile = process.argv[2]
const token = process.env.GIST_TOKEN
const gistId = process.env.GIST_ID

if (!token || !gistId || !resultsFile) {
  console.error('update-badge: GIST_TOKEN, GIST_ID and a results file are required')
  process.exit(1)
}

let passed = 0
let failed = 0
let pending = 0

try {
  const json = JSON.parse(readFileSync(resultsFile, 'utf8'))
  passed = json.numPassedTests ?? 0
  failed = json.numFailedTests ?? 0
  pending = json.numPendingTests ?? 0
} catch (err) {
  console.warn(`update-badge: could not read results file, using zeros: ${err.message}`)
}

const total = passed + failed + pending
const message = `${passed}/${total} passed`
const color = failed > 0 ? 'red' : pending > 0 ? 'orange' : 'brightgreen'

const data = {
  schemaVersion: 1,
  label: 'tests',
  message,
  color,
}

const body = JSON.stringify({ files: { 'badge.json': { content: JSON.stringify(data) } } })
const resp = await fetch(`https://api.github.com/gists/${gistId}`, {
  method: 'PATCH',
  headers: {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
  },
  body,
})

if (!resp.ok) {
  const text = await resp.text()
  console.error(`update-badge: gist PATCH failed (${resp.status}): ${text}`)
  process.exit(1)
}

console.log(`update-badge: ${message} (${color})`)
