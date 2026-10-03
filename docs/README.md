# Docs

Documentation lives under `docs/`, organized by concern. Everything here is
maintainer-facing unless the purpose column says otherwise. This file is the
index/navigation entry point.

## Index

| Path | Purpose | Audience |
| --- | --- | --- |
| `architecture.md` | Module layering, rewind/checkpoint pipelines, compatibility strategy, roadmap | maintainers |
| `format.md` | Durable on-disk format spec (checkpoint entries + restore journals) | maintainers |
| `harness-reference.md` | DeepSeek Harness interface reference + plugin source layout | maintainers |
| `snapshot-auto-cleanup.md` | Global snapshot auto-cleanup policy and command (`.zh` mirror) | users / maintainers |
| `rewind-fix.md` | Historical guide for the removed `/dsh-rewind-fix` (`.zh` mirror) | users / maintainers |
| `contract/client-contract.md` | Rewind visibility contract for third-party DOM plugins (`.zh` mirror) | integrators |
| `compat/audit.md` | Compatibility audit: verified surfaces, recorded findings, probe matrix | maintainers |
| `compat/tracking-boundary.md` | Which files a rewind restores: the tracking boundary (`.zh` mirror) | users / maintainers |
| `compat/diagnostics.md` | Browser diagnostics (anomaly alerts; verbose switch gates the startup identity line) (`.zh` mirror) | users / maintainers |
| `release/release.md` | Release workflow & DSH peer-version alignment | maintainers |
| `release/notes-template.md` | Release-notes (CHANGELOG) block, rules, and lifecycle | maintainers |

Repo-root docs outside `docs/`: `SECURITY.md`, `CONTRIBUTING.md`, and
`CHANGELOG.md` (per-release notes, kept out of the npm tarball).

## Conventions

- Bilingual docs use the `.md` / `.zh.md` file split (e.g. `contract/client-contract.md`
  + `contract/client-contract.zh.md`); the root pair is the exception — `README.md` is
  Chinese, `README.en.md` English.
- `compat/audit.md` is the single source of truth for compatibility conclusions;
  other docs link to it instead of restating them.
- Cross-links are relative.
