# Contributing

Thanks for considering a contribution to dsh-rewind. This file is short on
purpose: the authoritative spec for how the repo works is `AGENTS.md` (read it
first), and the docs live under `docs/` with an index in `docs/README.md`.

## Project principles

- **Focused on purpose** — one thing: in-window rewind to any earlier user
  message, never forking a session.
- **Security first** — session logs are append-only; file restores stay inside
  the plugin's own backup directory. See `SECURITY.md`.
- **Minimal** — avoid over-abstraction; keep the plugin light and maintainable.

## Prerequisites

- Node `^22.19.0 || >=24.0.0` (see `engines` in `package.json`), npm.

## Setup and commands

```sh
npm install            # devDeps from the npm registry
npm run build          # esbuild → lib/ (host ESM + client closure + types)
npm run check          # one-shot full gate: typecheck + test + build + verify:host + pack --dry-run
npm run typecheck      # tsc --noEmit (host / client / client-test)
npm test               # vitest: unit + compatibility suites
npm run verify:host    # end-to-end host verification (full check suite)
```

`prepare` runs the build, so `npm pack` / `npm publish` always carry a fresh
`lib/` and `LICENSE`.

## Before you open a PR

- **Every change must pass** `npm run check`.
- Commit messages use conventional commits with **English** subjects
  (`feat` / `fix` / `docs` / `test` / `refactor` / `chore` / …). Code comments
  are written in English.
- Keep `rewind.ts` pure and `snapshot.ts` host-independent — if a change needs
  I/O or harness types in the planning layer, that is a design smell.

## Documentation rules

- New/changed behavior that is durable (formats, contracts, compatibility
  findings) must update the relevant doc in the same PR:
  - **`docs/format.md`** — any change to the on-disk format (bump version,
    migrate, or move the state root; no silent re-interpretation).
  - **`docs/contract/client-contract.md`** — any change to the meaning of
    `@<seq>` / `sourceEventSeq` / `data-dsh-rewind-hidden`; breaking a listed
    stability tier is a minor/major version bump.
  - **`docs/compat/audit.md`** — new compatibility findings (it is the single
    source of truth; other docs link to it instead of restating).
  - **`SECURITY.md`** — any change to the security model (trust boundary,
    mutation gates, containment, crash handling).
- Bilingual docs use the `.md` / `.zh.md` file split; keep the two mirrors in
  sync.

## Testing expectations

- Pure planning (`rewind.ts`, `hidden.ts`) → unit tests in `tests/`.
- Store behavior (`snapshot.ts`) → `tests/snapshot.test.ts`, plus crash-safety
  scenarios in `tests/crash-safety.test.ts` via the test-only `crash` seam
  (`RestoreRunOptions.crash`).
- Harness interaction → the compatibility suites
  (`compat-invariants` / `compat-interop` / `compat-gaps`) and
  `scripts/verify-host.mjs`.

## Releasing

Releases are CI-driven via GitHub Actions Trusted Publishing (OIDC, no stored
token): push a `v<version>` tag and CI publishes with Sigstore provenance. Full
details: `docs/release/release.md`.
