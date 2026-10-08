# Changelog

All notable, user-visible changes, newest first. The entry format, the categories,
and the release steps are documented in
[docs/release/notes-template.md](docs/release/notes-template.md).

<!-- Release notes for v0.15.0 and earlier live in the GitHub Releases. -->

## [Unreleased]

> 适配 DSH `>=0.2.0-rc.1`

### 问题修复

- 回退后，被整体撤回且未产生任何输出（无助手回复、无工具调用）的回合，其摘要行（如「已停止」）会随该回合一起隐藏。#48 首次报告了该问题。 @SiriLee

---

> DSH `>=0.2.0-rc.1` supported

### Bug Fixes

- After a rewind, a fully withdrawn Turn that produced no output (no assistant reply or tool call) now hides its summary row (e.g. "Stopped") with it. The problem was first reported in #48. @SiriLee

**Full Changelog**: https://github.com/SiriLee/dsh-rewind/compare/v0.15.1...vNEXT

## [0.15.1] - 2026-10-03

> 适配 DSH `>=0.2.0-rc.1`

### 其他变更

- **验证目标移到 DSH `0.2.1-alpha.1`。** 它落在已声明的范围内，因此兼容声明不变。 @SiriLee
- **npm 包更精简。** 仓库专用的 `docs/`、`CONTRIBUTING.md` 与截图不再随包发布，安装后体积从约 750 kB 降到约 381 kB；运行时行为不变。 @SiriLee

---

> DSH `>=0.2.0-rc.1` supported.

### Chores

- **The verification target moves to DSH `0.2.1-alpha.1`.** It sits inside the declared range, so the compatibility declaration is unchanged. @SiriLee
- **A leaner npm package.** Repository-only `docs/`, `CONTRIBUTING.md`, and screenshots no longer ship; the installed size drops from about 750 kB to 381 kB. Runtime behavior is unchanged. @SiriLee

**Full Changelog**: https://github.com/SiriLee/dsh-rewind/compare/v0.15.0...v0.15.1
