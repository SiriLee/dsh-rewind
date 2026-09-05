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

The release workflow is **version-driven**: it derives the npm dist-tag from the
version in `package.json`, independent of branch. A stable version publishes to
`latest`; a pre-release publishes to the dist-tag named by its pre-release
identifier (e.g. `0.9.0-alpha.1` → `alpha`, `0.9.0-rc.1` → `rc`). The dist-tag is
never passed by hand.

The line being released determines the branch and the bump:

| Release | Branch | Bump | dist-tag |
| --- | --- | --- | --- |
| Stable patch (current line) | `release/0.8.x` | `npm version patch` | `latest` |
| Pre-release (next line) | `main` | `npm version prerelease --preid=alpha` | `alpha` |
| Stable (next line) | `main` | `npm version 0.9.0` | `latest` |

Each release is `git push <branch>` followed by `git push <branch> --tags`.

- The release commit is **`chore: release vX.Y.Z`**; the **lightweight `vX.Y.Z`
  tag** sits on it. Do **not** create tag/release first with `gh release create
  <tag>` (it tags the remote `main` head and breaks the tag/version match).
- **Before bumping, manually confirm there is no newer DSH version the plugin
  has not been verified against** (a pre-release can ship in DSH Desktop
  without being on npm; see docs/compat/audit.md).
- The workflow verifies the tag matches `package.json`, runs typecheck + tests +
  a full build + artifact verification, publishes with `--provenance` (Sigstore)
  to the version-derived dist-tag, and creates a GitHub Release (a pre-release
  is created as a GitHub pre-release, not `latest`). It is **idempotent** — an
  already published version is skipped.
- CI (`.github/workflows/ci.yml`) runs `npm run check` — typecheck + tests +
  build + artifact verification + a `npm pack --dry-run` — on every push / PR
  across both Node engines boundary versions; the tarball layout is guarded by
  `tests/package-layout.test.ts`.
- The GitHub Release body is auto-created with `--generate-notes` as a
  **placeholder** (`--latest` / `--prerelease` per version). After the publish
  run succeeds, overwrite the body by hand in the repo's bilingual style
  (Chinese first, then English) — never keep the auto text as the final note.

## DSH version alignment (single peer tuple)

DSH is still in rc; npm's prerelease matching rules require a peer range to
share the host version's `[major, minor, patch]` tuple. So `peerDependencies`
uses one peer tuple per DSH line (e.g. `^0.1.2-rc.1`), replaced (never
appended) when DSH releases a new tuple.

- **When to update**: only when DSH releases a new tuple (`0.1.2 → 0.1.3 →
  0.2.x`); rc rolling within a tuple (`0.1.2-rc.1 → rc.2`) needs nothing. All
  `@deepseek-ai/*` packages release together; `npm view @deepseek-ai/dsh version`
  is the authoritative signal.
- **Published-tuple check (optional)**: `node scripts/check-dsh-version.mjs`
  compares the `latest` dist-tag version against the tuple the peers cover
  (exit 0 = nothing to do, exit 1 = update). It reads the `latest` tag only; a
  pre-release published under another tag or bundled without
  going to npm is a manual pre-release check — see the "Before bumping" step above.
- **Update steps**: replace every `@deepseek-ai/dsh-*` peer's tuple with
  `^<latest>` → bump devDependencies to the latest → `npm install` →
  `npm run check` → release.
- **After DSH goes final**: final releases are not bound by the prerelease
  tuple rule, so the peers can converge to a single stable range (e.g.
  `^0.1.x`); this section can then be deleted.

## Versioned-line release model

**One release targets one DSH version line.** The plugin's own version is
independent of the host; a release declares its DSH line through the peer
constraint (a single companion tuple), never through the plugin version.

| Plugin version | DSH line | Notes |
| --- | --- | --- |
| `0.7.x` | `0.1.1` + `0.1.2` (broad) | frozen / EOL |
| `0.8.x` | `0.1.2-rc.1` (single) | current stable |
| `0.9.x` | `0.1.3` (single) | next line |

**Versioning.** A DSH version-line break is a MAJOR bump (incompatible with the
prior DSH line). Within a line, MINOR/PATCH remain compatible.

**Branching (trunk-based).** `main` is the single integration and release line
and is always releasable. The currently-shipped stable is cut into a short-lived
`release/<version>.x` maintenance branch from its release commit; that branch
receives backported fixes while `main` advances to the next line. The prior
(broad-compat) line is frozen as a tag, with no branch.

**dist-tag routing.** The release workflow derives the npm dist-tag from the
version: a stable version publishes to `latest`; a pre-release publishes to the
dist-tag named by its pre-release identifier (`0.9.0-alpha.1` → `alpha`,
`0.9.0-rc.1` → `rc`). A pre-release never occupies `latest`.

**Support window / EOL.** A DSH line is supported within a declared window. By
default the window runs until the next DSH line ships as `latest`; after that
the line is EOL, frozen, and receives no further patches. Here `0.8.x`
(`0.1.2-rc.1`) is supported until `0.9.x` (`0.1.3`) ships as `latest`.

**Bug-fix flow (forward-fix then backport).** A fix affecting multiple supported
lines is applied on `main` first, then backported to each still-supported
release branch. A fix specific to one line is applied only on that line.

The single-line model uses one peer tuple per release (see DSH version
alignment above); the OR-union multi-line practice it replaced is not used.
