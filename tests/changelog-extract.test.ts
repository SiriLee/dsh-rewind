import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// `new URL(...).pathname` keeps percent-escapes (`%20`), which breaks the
// child-process path when the checkout lives under a directory with spaces.
const SCRIPT = join(fileURLToPath(new URL('..', import.meta.url)), 'scripts/changelog-extract.mjs')

/** Run the extractor in `cwd`; status and streams, never a throw. */
function run(args: string[], cwd: string) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' })
    return { status: 0, stdout, stderr: '' }
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string }
    return { status: failure.status ?? -1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
  }
}

/** One release block. */
const block = (version: string, range = '>=0.2.0-rc.1', bullet = '- 一条用户可见的变化。'): string =>
  [
    `## [${version}] - 2026-10-05`,
    '',
    `> 适配 DSH \`${range}\``,
    '',
    '### 新增功能',
    '',
    bullet,
    '',
    '---',
    '',
    `> DSH \`${range}\` supported`,
    '',
    `**Full Changelog**: https://github.com/SiriLee/dsh-rewind/compare/v0.15.0...v${version}`,
  ].join('\n')

/** A directory with `package.json` (its `engines.dsh`) and a one-block CHANGELOG.md. */
async function fixture(options: { engines?: string | null; notes?: string } = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'changelog-extract-'))
  const engines = options.engines === undefined ? '>=0.2.0-rc.1' : options.engines
  await writeFile(join(dir, 'package.json'), JSON.stringify(engines === null ? {} : { engines: { dsh: engines } }))
  await writeFile(
    join(dir, 'CHANGELOG.md'),
    ['# Changelog', '', '## [Unreleased]', '', options.notes ?? block('0.16.0'), ''].join('\n'),
  )
  return dir
}

describe('changelog extraction', () => {
  it('prints the block the tag owns, stripped of the file scaffold', async () => {
    const dir = await fixture()
    try {
      const result = run(['v0.16.0'], dir)
      expect(result.status).toBe(0)
      expect(result.stdout).toBe(`${block('0.16.0')}\n`)
      // A version may be passed without the `v` prefix.
      expect(run(['0.16.0'], dir).stdout).toBe(result.stdout)
      const out = join(dir, 'body.md')
      expect(run(['v0.16.0', '--out', out], dir).status).toBe(0)
      expect(await readFile(out, 'utf8')).toBe(result.stdout)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it.each([
    { name: 'a missing block', args: ['v0.17.0'], message: 'no "## [0.17.0]" block' },
    { name: 'an empty block', notes: block('0.16.0', '>=0.2.0-rc.1', ''), message: 'has no entries' },
    { name: 'an engines.dsh mismatch', engines: '>=0.3.0', message: 'compatibility line says' },
    { name: 'a manifest without engines.dsh', engines: null, message: 'declares no engines.dsh' },
    { name: 'a compare link off this tag', notes: block('0.16.0').replace('v0.16.0', 'v0.15.0'), message: 'must end at v0.16.0' },
    { name: 'no compare link', notes: block('0.16.0').replace(/\n\*\*Full Changelog\*\*:.*/, ''), message: 'exactly one "**Full Changelog**" line' },
  ])('refuses $name', async ({ args, engines, notes, message }) => {
    const dir = await fixture({ engines, notes })
    try {
      const result = run(args ?? ['v0.16.0'], dir)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain(message)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('treats a missing or non-version tag as a usage error', async () => {
    const dir = await fixture()
    try {
      expect(run([], dir).status).toBe(2)
      expect(run(['vNext'], dir).stderr).toContain('is not a version')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
