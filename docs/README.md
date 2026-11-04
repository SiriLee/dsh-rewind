# Docs

Documentation lives under `docs/`, organized by concern. Everything here is
maintainer-facing unless the purpose column says otherwise. This file is the
index/navigation entry point.

## Index

| Path | Purpose | Audience |
| --- | --- | --- |
| `architecture.md` | Source layout, module layering, rewind/checkpoint pipelines, open directions | maintainers |
| `boundaries.md` | Design boundaries: what the plugin owns, what it leaves to other tools, and why (`.zh` mirror) | users / maintainers |
| `format.md` | Durable on-disk format spec (checkpoint entries + restore journals) | maintainers |
| `harness-reference.md` | DeepSeek Harness interface reference (subsystems + key source) | maintainers |
| `snapshot-auto-cleanup.md` | Global snapshot auto-cleanup policy and command (`.zh` mirror) | users / maintainers |
| `compat/audit.md` | Compatibility audit: invariants, open upstream gaps, probe matrix | maintainers |
| `compat/tracking-boundary.md` | Which files a rewind restores: the tracking boundary (`.zh` mirror) | users / maintainers |
| `compat/diagnostics.md` | Browser diagnostics (anomaly alerts; verbose switch gates the startup identity line) (`.zh` mirror) | users / maintainers |
| `release/release.md` | Release workflow & DSH peer-version alignment | maintainers |
| `release/notes-template.md` | Release-notes (CHANGELOG) block, rules, and lifecycle | maintainers |

Repo-root docs outside `docs/`: `SECURITY.md`, `CONTRIBUTING.md`, and
`CHANGELOG.md` (per-release notes, kept out of the npm tarball).
