# Release

[简体中文](release.zh.md)

## First release (manual, one-time)

Trusted Publisher can only be configured once the package exists, so the first
version is published locally:

```sh
npm login
npm publish --access public
```

- If prompted for `EOTP`: complete the browser auth link the CLI prints, or
  retry with a 6-digit code — `npm publish --otp=<code>`.
- The first version carries no provenance (local path) — acceptable; every CI
  release after that publishes with Sigstore/SLSA provenance automatically.

## Configure Trusted Publisher (npmjs.com, one-time)

Open `https://www.npmjs.com/package/dsh-rewind-plugin` → package **settings** →
**Trusted Publisher**:

| Field | Value |
| --- | --- |
| Provider | GitHub Actions |
| Organization or user | `SiriLee` |
| Repository | `dsh-rewind` (the GitHub repo, not the npm name) |
| Workflow filename | `publish.yml` |
| Environment | empty |
| Allowed actions | `npm publish` |

## Subsequent releases (CI, automatic)

```sh
npm version patch
git push origin main --tags   # triggers .github/workflows/publish.yml
```

- **Before bumping, manually confirm there is no newer DSH version the plugin
  has not been verified against** (a pre-release can ship in DSH Desktop
  without being on npm, e.g. `0.1.2-alpha.1`; see docs/compat/audit.md).
- The workflow verifies the tag matches `package.json`, runs typecheck + tests +
  a full build + artifact verification, publishes with `--provenance`
  (Sigstore), and creates a GitHub Release. It is **idempotent** — an already
  published version is skipped.
- CI (`.github/workflows/ci.yml`) runs `npm run check` — typecheck + tests +
  build + artifact verification + a `npm pack --dry-run` — on every push / PR
  across both Node engines boundary versions; the tarball layout is guarded by
  `tests/package-layout.test.ts`.

## DSH version alignment (peer range maintenance)

DSH is still in rc; npm's prerelease matching rules require a peer range to
share the host version's `[major, minor, patch]` tuple. So `peerDependencies`
uses an OR-union covering every published rc tuple series
(e.g. `^0.1.0-rc.6 || ^0.1.1-rc.2`), extended as DSH releases new tuples.

- **When to update**: only when DSH releases a new tuple
  (`0.1.1 → 0.1.2 → 0.2.x`); rc rolling within a tuple (`0.1.1-rc.2 → rc.3`)
  needs nothing. All `@deepseek-ai/*` packages release together;
  `npm view @deepseek-ai/dsh version` is the authoritative signal.
- **Published-tuple check (optional)**: `node scripts/check-dsh-version.mjs`
  compares the latest npm version against the tuples the peers cover (exit 0 =
  nothing to do, exit 1 = update). It reads npm published versions only; a
  newer-but-unpublished pre-release is a manual pre-release check — see the
  "Before bumping" step above.
- **Update steps**: append `|| ^<new-tuple>-rc.<n>` to every
  `@deepseek-ai/dsh-*` peer → bump devDependencies to the latest → `npm
  install` → `npm run check` → release.
- **After DSH goes final**: final releases are not bound by the prerelease
  tuple rule, so the peers can converge to a single stable range (e.g.
  `^0.1.x`); this section can then be deleted.
