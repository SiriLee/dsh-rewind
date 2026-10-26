/**
 * Publish-layout guard tests: the prebuilt tarball must stay portable and complete:
 *
 *  - `files` carries every install-time artifact and no repository-only doc;
 *  - the host bundle `lib/index.js` is external-clean: it imports only
 *    `@deepseek-ai/*` peers and `node:` builtins — no relative paths, no
 *    bare third-party dependencies that would break outside a checkout;
 *  - every `exports` subpath target exists on disk (prebuilt portability);
 *  - `devDependencies` never carry machine-local paths;
 *  - metadata that installers and the DSH registry read (main/types/dsh
 *    bundle patch/peer range) stays intact.
 */
import { access, readdir, readFile } from 'node:fs/promises'
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
      'LICENSE',
      // Read by the harness as package resources, not only by the repository.
      'locale/*.json',
      'assets/icon.svg',
    ]) {
      expect(pkg.files, `files must include ${entry}`).toContain(entry)
    }
  })

  it('keeps repository-only documentation out of the tarball', () => {
    // `files` is an allowlist; the npm page renders the README itself and its
    // relative links resolve against the repository, so these need no bytes here.
    for (const entry of ['docs', 'assets/screenshots', 'CONTRIBUTING.md', 'CHANGELOG.md']) {
      expect(pkg.files, `${entry} must stay out of the tarball`).not.toContain(entry)
    }
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

    // Every shipped locale file is discovered from disk, so adding a language
    // needs no edit here. The two baseline locales must always be present.
    const localeDir = join(root, 'locale')
    const files = (await readdir(localeDir)).filter(file => file.endsWith('.json')).sort()
    expect(files).toEqual(expect.arrayContaining(['en.json', 'zh.json']))
    for (const file of files) {
      const raw = await readFile(join(localeDir, file), 'utf8')
      const locale = JSON.parse(raw) as { meta?: { title?: string; description?: string } }
      expect(locale.meta?.title, `${file} title`).toBeTruthy()
      expect(locale.meta?.description, `${file} description`).toBeTruthy()
      // Keep the shipped metadata uniform: two-space JSON plus a final newline.
      expect(raw, `${file} formatting`).toBe(`${JSON.stringify(locale, null, 2)}\n`)
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

  it('declares the adapted DSH range on the peer tuple', () => {
    // release.md: since DSH 0.2.1-alpha.4 `engines.dsh` is the sole admission
    // criterion, so it declares the whole range — the floor on the peer tuple
    // plus that tuple's next caret line as an exclusive bound. Both sides are
    // read from the manifest, so the assertion survives a DSH line change
    // without an edit here.
    const tuples = Object.entries(pkg.peerDependencies ?? {})
      .filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))
      .map(([, peerRange]) => /\d+\.\d+\.\d+/.exec(peerRange)?.[0])
    expect(new Set(tuples).size, 'every dsh peer must name one tuple').toBe(1)
    const tuple = tuples[0]
    const [major, minor] = (tuple ?? '').split('.')
    const ceiling = major === '0' ? `0.${Number(minor) + 1}.0-0` : `${Number(major) + 1}.0.0-0`
    const declared = pkg.engines?.dsh
    const parsed = /^>=(\d+\.\d+\.\d+)(?:-[0-9A-Za-z.-]+)? <(\d+\.\d+\.\d+-0)$/.exec(declared ?? '')
    expect(parsed, `engines.dsh must bound the peer tuple, found ${String(declared)}`).not.toBeNull()
    expect(parsed?.[1]).toBe(tuple)
    expect(parsed?.[2]).toBe(ceiling)
  })

  it('verifies the cordis family at the version its peer floor names', () => {
    // The host bundles these itself, so they bind like a dsh package does: one
    // version on both sides, and the suite runs against exactly that version
    // instead of a nearby older copy.
    const peers: Record<string, string> = pkg.peerDependencies ?? {}
    const devs: Record<string, string> = pkg.devDependencies ?? {}
    for (const name of ['@deepseek-ai/cordis', '@deepseek-ai/schemastery']) {
      const peer = peers[name]
      expect(peer, `${name} must declare a peer floor`).toMatch(/^\^\d+\.\d+\.\d+$/u)
      expect(devs[name], `${name} must be installed at that floor`).toBe(peer?.slice(1))
    }
  })
})
