# Release notes (CHANGELOG) guide

Release notes live in [`CHANGELOG.md`](../../CHANGELOG.md); the publish workflow
attaches a tag's block as that release's GitHub Release body. The layout follows
[Keep a Changelog](https://keepachangelog.com/) — one block per release, newest
first, ISO dates.

## Block

```md
## [X.Y.Z] - YYYY-MM-DD

> 适配 DSH `>=x.y.z-pre`（公测版）

### 新增功能

- 一句说明。（编号写 `#123`；明确贡献者时句末 `@xxx`）

### 问题修复
### 体验优化
### 其他变更

---

> DSH `>=x.y.z-pre` supported. Public beta.

### New Features

- One-sentence statement. (`#123`; `@handle` at the end when the contributor is known)

### Bug Fixes
### Improvements
### Chores

**Full Changelog**: https://github.com/SiriLee/dsh-rewind/compare/vPrev...vX.Y.Z
```

## Rules

1. Chinese first, then English (`---` between the halves); every entry exists in both.
2. The compatibility line quotes `engines.dsh` verbatim and declares no upper bound.
3. Stage word after the range: `内测版`/`Internal alpha.` for `-alpha`, `公测版`/`Public
   beta.` for `-beta`, `候选版`/`Release candidate.` for `-rc`; a stable version omits it.
4. A stable block that spans several intermediates opens with `本版汇总了自 \`vPrev\`
   以来的主要变更。` / `This release summarizes the main changes since \`vPrev\`.`
5. Only functionality-related net changes: no internal refactors, docs, tests, or
   tooling; nothing an unreleased span introduced and then reverted.
6. Categories: `新增功能`/`New Features` (capability), `问题修复`/`Bug Fixes`
   (user-visible defect), `体验优化`/`Improvements` (copy, icon, style, performance),
   `其他变更`/`Chores` (the rest — a DSH line change goes first).
7. Credits at the end of an entry: `#123` as it is; an external contributor as
   `@handle` (look the account up while writing the entry). An identity you cannot
   confirm is written by name — never guessed.
8. Omit empty sections.
9. `**Full Changelog**` once, as the last line, ending at this tag (the extractor
   enforces it).

## Lifecycle

- **Develop**: add each user-visible change under `## [Unreleased]`, in both halves.
- **Release** (inside the release commit): rename the block to
  `## [X.Y.Z] - YYYY-MM-DD`, point `vNEXT` at the tag, add the stage word or the
  summary sentence, and open a fresh `## [Unreleased]`.
- **CI**: `node scripts/changelog-extract.mjs <tag>` extracts the block; anything
  missing or inconsistent fails the run before the npm publish.

The block is used verbatim (no generated text, no post-publication edit), and its
inline compare link keeps the extracted body self-contained. `CHANGELOG.md` stays out
of the npm tarball, pinned by `tests/package-layout.test.ts`.
