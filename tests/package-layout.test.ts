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
    ]) {
      expect(pkg.files, `files must include ${entry}`).toContain(entry)
    }
  })

  it('exposes only declared entry points', () => {
    expect(pkg.main).toBe('lib/index.js')
    expect(pkg.types).toBe('lib/types/index.d.ts')
    expect(Object.keys(pkg.exports ?? {}).sort()).toEqual(['.', './client', './package.json'])
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
})
