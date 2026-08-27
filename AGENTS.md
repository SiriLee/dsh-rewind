# AGENTS.md

> dsh-rewind — a DeepSeek Harness (DSH) plugin that rewinds a conversation in place
> to any earlier user message, optionally restoring workspace files along with it.
> This is the shared spec for every developer and agent working on this repo; it is
> intentionally minimal. Machine-specific local details live in `AGENTS.override.md`
> (git-ignored — do not commit).

## Positioning & principles
- **Focused on purpose**: it does exactly one thing — rewind to any earlier user
  message in the same window, never forking a session or switching windows.
- **Security first**: session logs are append-only and conversations are never
  deleted; file restores are confined to the plugin's own backup directory.
- **Minimal**: avoid over-abstraction; keep the plugin light and maintainable.

## Common commands
| Command | Purpose |
| --- | --- |
| `npm run check` | one-shot full gate: typecheck + test + build + verify:host + `npm pack --dry-run` |
| `npm run build` | esbuild → `lib/` (`index.js` host ESM, `client.js` client closure, `types/` declarations) |
| `npm run typecheck` | tsc --noEmit (host / client / client-test configs) |
| `npm test` | vitest |
| `npm run verify:host` | end-to-end host verification (full check suite) |

`@deepseek-ai/*` dependencies stay external at build time — the DSH host resolves
them at runtime, so the published tarball does not carry them.

## Layout at a glance
- `src/index.ts` — host plugin: `/rewind` command + checkpoint pipeline
  (`tools/execute` | `post-execute`)
- `src/rewind.ts` — pure planning: target resolution, surface range, candidate listing
- `src/snapshot.ts` — checkpoint store (on-disk before-backups, restore/preview, bounded prune)
- `src/session-cwd.ts` — session working-directory resolution (fs-tools rule)
- `src/client/` — client plugin: per-message ↶ button, mode popover, hidden-span computation
- `scripts/` — `build.mjs` (artifacts), `verify-host.mjs` (host verification)
- `docs/` — organized: `contract/` (client contract), `compat/` (audit + troubleshooting), `release/`, plus `harness-reference.md`, `format.md`, `architecture.md`; repo root holds `SECURITY.md` and `CONTRIBUTING.md`
- `tests/` — vitest suites (rewind / snapshot / hidden / session-cwd / integration)

## Conventions
- Code comments are written in English; git history uses conventional commits with
  English subjects (`feat`/`fix`/`docs`/`test`/`chore`/...).
- Every change must pass `npm run check`.
- When DSH interfaces change, maintain the peer version ranges (see `docs/release/release.md`).

## Further reading
- Interfaces / compatibility: `docs/harness-reference.md`, `docs/compat/audit.md`
- Release & DSH version alignment: `docs/release/release.md`
