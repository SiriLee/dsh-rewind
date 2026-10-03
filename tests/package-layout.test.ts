/**
 * Publish-layout guard tests (mirrors the `dsh-turn-rewind` package-layout
 * discipline): the prebuilt tarball must stay portable and complete. The
 * properties under test:
 *
 *  - `files` covers every artifact the plugin needs at install time
 *    (lib, cordis patch, README pair, security/contributing docs, docs/, assets);
 *  - the host bundle `lib/index.js` is external-clean: it imports only
 *    `@deepseek-ai/*` peers and `node:` builtins — no relative paths, no
 *    bare third-party dependencies that would break outside a checkout;
 *  - every `exports` subpath target exists on disk (prebuilt portability);
 *  - `devDependencies` never carry machine-local paths;
 *  - metadata that installers and the DSH registry read (main/types/dsh
 *    bundle patch/peer range) stays intact.
 */
import { access, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// fileURLToPath: `URL.pathname` keeps a leading `/` on Windows (`/E:/...`),
// which `join` turns into a bogus `E:\E:\...` root.
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg: {
  name: string
  private?: boolean
  version: string
  main?: string
  types?: string
  type?: string
  icon?: string
  files?: string[]
  exports?: Record<string, unknown>
  scripts?: Record<string, string>
  dsh?: { bundle?: { patch?: string }; client?: { platform?: string; inject?: string[] } }
  peerDependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  engines?: Record<string, string>
} = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

/** All specifiers imported by the prebuilt host entry. */
async function hostImports(): Promise<string[]> {
  const body = await readFile(join(root, pkg.main!), 'utf8')
  const specifiers: string[] = []
  for (const match of body.matchAll(/from\s+"([^"]+)"/g)) specifiers.push(match[1]!)
  return specifiers
}

async function exists(path: string): Promise<void> {
  await access(path)
}

describe('package layout', () => {
  it('ships every artifact the plugin needs at install time', () => {
    expect(pkg.name).toBe('dsh-rewind-plugin')
    expect(pkg.private).not.toBe(true)
    for (const entry of [
      'lib',
      'cordis.patch.yml',
      'README.md',
      'README.en.md',
      'SECURITY.md',
      'CONTRIBUTING.md',
      'docs',
      'assets',
      'LICENSE',
      // The localized title/description dictionaries the harness reads as
      // package resources, so they must ride the tarball.
      'locale/*.json',
    ]) {
      expect(pkg.files, `files must include ${entry}`).toContain(entry)
    }
  })

  it('keeps the changelog out of the tarball', () => {
    // The per-release notes are the repository's history, not an install-time
    // resource: `files` is an allowlist, so a root `CHANGELOG.md` stays out of
    // the package. Listing it would silently ship it (docs/release/notes-template.md).
    expect(pkg.files, 'CHANGELOG.md must stay out of the tarball').not.toContain('CHANGELOG.md')
  })

  it('exposes only declared entry points', () => {
    expect(pkg.main).toBe('lib/index.js')
    expect(pkg.types).toBe('lib/types/index.d.ts')
    expect(Object.keys(pkg.exports ?? {}).sort())
      .toEqual(['.', './client', './locale/*.json', './package.json'])
  })

  it('declares the display metadata the Plugins page reads', async () => {
    // The harness reads `icon` (a manifest-relative file, at most 256 KiB, one
    // of SVG/PNG/JPEG/WebP) and, through the exports map, `locale/<lang>.json`
    // carrying `meta.title` / `meta.description`.
    const icon = pkg.icon
    expect(icon).toMatch(/^\.\/(?!.*\.\.).*\.(svg|png|jpe?g|webp)$/)
    const bytes = await readFile(join(root, icon!.slice(2)))
    expect(bytes.byteLength).toBeLessThanOrEqual(256 * 1024)
    for (const language of ['en', 'zh']) {
      const locale = JSON.parse(await readFile(join(root, 'locale', `${language}.json`), 'utf8')) as {
        meta?: { title?: string; description?: string }
      }
      expect(locale.meta?.title, `${language} title`).toBeTruthy()
      expect(locale.meta?.description, `${language} description`).toBeTruthy()
    }
  })

  it('declares the DSH bundle patch and client injection', () => {
    expect(pkg.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(pkg.dsh?.client?.platform).toBe('web')
    expect(pkg.dsh?.client?.inject?.length).toBeGreaterThan(0)
    expect(pkg.peerDependencies?.['@deepseek-ai/cordis']).toBeDefined()
  })

  it('keeps the host bundle external-clean (no relative or bare imports)', async () => {
    const specifiers = await hostImports()
    expect(specifiers.length).toBeGreaterThan(0)
    for (const specifier of specifiers) {
      const allowed = specifier.startsWith('@deepseek-ai/') || specifier.startsWith('node:')
      expect(allowed, `unexpected host import: ${specifier}`).toBe(true)
    }
  })

  it('ships prebuilt artifacts behind every export and dsh reference', async () => {
    await exists(join(root, 'lib/index.js'))
    await exists(join(root, 'lib/client.js'))
    await exists(join(root, 'lib/types/index.d.ts'))
    await exists(join(root, 'lib/types/client/index.d.ts'))
    await exists(join(root, pkg.dsh!.bundle!.patch!))
  })

  it('never pins machine-local devDependency paths', () => {
    for (const [name, specifier] of Object.entries(pkg.devDependencies ?? {})) {
      const local = isAbsolute(specifier)
        || /^(?:file|link):/u.test(specifier)
        || /^[A-Za-z]:[\\/]/u.test(specifier)
      expect(local, `devDependency ${name} must not use a machine-local path: ${specifier}`).toBe(false)
    }
  })

  it('keeps the engines range aligned with the CI matrix', () => {
    expect(pkg.engines?.node).toMatch(/\^22\.19\.0 \|\| >=24\.0\.0/)
  })

  it('declares the DSH floor in the documented form, on the peer tuple', () => {
    // release.md: only the `>=X.Y.Z[-pre]` form is used, and the floor moves in
    // step with the peer tuple. Both sides are read from the manifest, so the
    // assertion survives a DSH line change without an edit here.
    const floor = pkg.engines?.dsh
    expect(floor).toMatch(/^>=\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
    const tuples = Object.entries(pkg.peerDependencies ?? {})
      .filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))
      .map(([, range]) => /\d+\.\d+\.\d+/.exec(range)?.[0])
    expect(new Set(tuples).size, 'every dsh peer must name one tuple').toBe(1)
    expect(floor?.startsWith(`>=${tuples[0]}`)).toBe(true)
  })
})
