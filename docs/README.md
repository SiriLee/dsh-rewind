# Docs

Documentation lives under `docs/`, organized by concern. Everything here is
maintainer-facing unless the purpose column says otherwise. This file is the
index/navigation entry point.

## Index

| Path | Purpose | Audience |
| --- | --- | --- |
| `harness-reference.md` | DeepSeek Harness interface reference + plugin source layout | maintainers |
| `contract/client-contract.md` | Rewind visibility contract for third-party DOM plugins (`.zh` mirror) | integrators |
| `compat/audit.md` | Compatibility audit: verified surfaces, recorded findings, probe matrix | maintainers |
| `compat/troubleshooting.md` | Known issues & repair steps (`.zh` mirror) | users / maintainers |
| `release/release.md` | Release workflow & DSH peer-version alignment | maintainers |

## Conventions

- Bilingual docs use the `.md` / `.zh.md` file split (e.g. `contract/client-contract.md`
  + `contract/client-contract.zh.md`); `release/release.md` is intentionally bilingual
  in a single file.
- `compat/audit.md` is the single source of truth for compatibility conclusions;
  other docs link to it instead of restating them.
- Cross-links are relative so the whole `docs/` directory stays relocatable — and it
  ships intact in the npm tarball via the `docs` entry in `files` (`package.json`).
