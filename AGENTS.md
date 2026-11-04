# AGENTS.md

> dsh-rewind — a DeepSeek Harness (DSH) plugin that rewinds a conversation in place
> to any earlier user message, optionally restoring workspace files along with it.
> This is the shared spec for developers and agents: principles and rules first,
> with the details in the linked docs.

## Positioning & principles
- **Focused on purpose**: it does exactly one thing — rewind to any earlier user
  message in the same window, never forking a session or switching windows.
- **Security first**: session logs are append-only and conversations are never
  deleted; file restores draw only from the plugin's own backup directory.
- **Minimal**: avoid over-abstraction; keep the plugin light and maintainable.

## Layout at a glance
- `src/index.ts` — host plugin: `/rewind`, `/undo`, `/snapshot-auto-cleanup`,
  and the checkpoint pipeline.
- `src/rewind.ts` — pure planning: target resolution, surface range, candidate
  listing.
- `src/snapshot.ts` — checkpoint store: before-backups, restore/preview,
  bounded prune.
- `src/snapshot-cleanup.ts` — cleanup policy, config persistence, auto-sweep
  throttle.
- `src/locales.ts` — host i18n.
- `src/client/` — client plugin: ↶ button, mode popover, hidden-span
  computation.
- `scripts/` — build, badge, host verification, session codec.
- `tests/` — vitest suites (rewind / snapshot / hidden / integration).
- `docs/` — `compat/`, `release/`, plus the design, format and interface docs.
- Full source layout: `docs/architecture.md`; DSH interfaces:
  `docs/harness-reference.md`.

## Working in this repo
- `npm run check` is the merge gate; setup and the full command list are in
  `CONTRIBUTING.md`.
- Code comments are English; commits use conventional commits with English
  subjects (`feat`/`fix`/`docs`/`test`/`chore`/...).
- One logical change per commit: finish it, run `npm run check`, then commit and
  push before starting the next change.
- DSH compatibility is iteration-driven: `main` adapts only to the latest DSH
  line; cross-version compatibility is not kept (see `docs/release/release.md`).

## Further reading
- Design boundaries: `docs/boundaries.md`
- Security model: `SECURITY.md`
- Interfaces / compatibility: `docs/harness-reference.md`, `docs/compat/audit.md`
- Release & DSH version alignment: `docs/release/release.md`
