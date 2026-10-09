# Changelog

All notable, user-visible changes, newest first. The entry format, the categories,
and the release steps are documented in
[docs/release/notes-template.md](docs/release/notes-template.md).

<!-- Release notes for v0.15.0 and earlier live in the GitHub Releases. -->

## [Unreleased]

> 适配 DSH `>=0.2.1-alpha.2`

---

> DSH `>=0.2.1-alpha.2` supported

**Full Changelog**: https://github.com/SiriLee/dsh-rewind/compare/v0.16.0-alpha.1...vNEXT

## [0.16.0-alpha.1] - 2026-10-09

> 适配 DSH `>=0.2.1-alpha.2`（内测版）

### 问题修复

- **快照基准改从会话的当前目录读取。** DSH `0.2.1-alpha.2` 起，相对路径由会话的**当前**目录解析（新的 `working-directory` 服务，会话中途可经 `working_directory` 工具变更）；本版据此读取快照基准——中途切换目录后的写入也能被正确记录与还原，此前固定用不可变的 `header.cwd`。@SiriLee

### 其他变更

- **适配 DSH `0.2.1-alpha.2`（线切换）。** 本版只支持这一条线：声明下限抬到提供 `working-directory` 服务的内测版。DSH `0.2.0-rc.x`（当前 `latest`）会被启动校验整包跳过，请继续留在 `0.15.3`。@SiriLee

---

> DSH `>=0.2.1-alpha.2` supported. Internal alpha.

### Bug Fixes

- **The snapshot base is read from the Session's current directory.** From DSH `0.2.1-alpha.2`, a relative path resolves against the Session's *current* directory (the new `working-directory` service, changeable mid-session through the `working_directory` tool); this release reads the capture base from it, so writes after a mid-session directory change are captured and restored correctly — the immutable `header.cwd` was used before. @SiriLee

### Chores

- **Adapted to DSH `0.2.1-alpha.2` (a line change).** This release supports that line only: the declared floor rises to the alpha that provides the `working-directory` service. DSH `0.2.0-rc.x` (the current `latest`) is skipped whole by the startup check — stay on `0.15.3`. @SiriLee

**Full Changelog**: https://github.com/SiriLee/dsh-rewind/compare/v0.15.3...v0.16.0-alpha.1

## [0.15.3] - 2026-10-09

> 适配 DSH `>=0.2.0-rc.1`

### 其他变更

- **插件不再包含 `fetch(` 调用。** 回退图片改由会话面的 `readAttachment` 直接取字节，行为不变；静态能力扫描不再把它读成 `network`（`dsh-trust-check` 的误报，liuwenji007/dsh-trust-check#9）。@SiriLee

---

> DSH `>=0.2.0-rc.1` supported.

### Chores

- **The plugin no longer contains a `fetch(` call.** Restored images are read through the session face's `readAttachment`, with the same behavior; a static capability scan no longer reads it as `network` (a false positive confirmed in liuwenji007/dsh-trust-check#9). @SiriLee

**Full Changelog**: https://github.com/SiriLee/dsh-rewind/compare/v0.15.2...v0.15.3

## [0.15.2] - 2026-10-08

> 适配 DSH `>=0.2.0-rc.1`

### 问题修复

- 与其他插件命令重名时，本插件不再整体激活失败：只有重名的那条命令不可用，回退按钮、候选面板与文件快照均照常。客户端改为驱动内部引擎通道 `rewind-plugin`，不再依赖 `/rewind` 这个名字。#49 首次报告了该问题。 @SiriLee
- 回退后，被整体撤回且未产生任何输出（无助手回复、无工具调用）的回合，其摘要行（如「已停止」）会随该回合一起隐藏。#48 首次报告了该问题。 @SiriLee

---

> DSH `>=0.2.0-rc.1` supported

### Bug Fixes

- A command name owned by another plugin no longer fails the whole plugin: only that name is unavailable, while the rewind button, picker and file snapshots keep working. The client now drives the internal `rewind-plugin` engine channel instead of depending on the `/rewind` name. The problem was first reported in #49. @SiriLee
- After a rewind, a fully withdrawn Turn that produced no output (no assistant reply or tool call) now hides its summary row (e.g. "Stopped") with it. The problem was first reported in #48. @SiriLee

**Full Changelog**: https://github.com/SiriLee/dsh-rewind/compare/v0.15.1...v0.15.2

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
