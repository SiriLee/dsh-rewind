# Changelog

All notable, user-visible changes, newest first. The entry format, the categories,
and the release steps are documented in
[docs/release/notes-template.md](docs/release/notes-template.md).

<!-- Release notes for v0.15.0 and earlier live in the GitHub Releases. -->

## [Unreleased]

> 适配 DSH `>=0.2.2-rc.1 <0.3.0-0`

**Full Changelog**: https://github.com/SiriLee/dsh-rewind/compare/v0.21.2...vNEXT

## [0.21.2] - 2026-11-07

> 适配 DSH `>=0.2.2-rc.1 <0.3.0-0`

### 问题修复

- **回退按钮的消息行接管不再替换其他插件包装渲染器的身份。** 接管只装饰默认优先级的官方行；包装器仍可委派到官方行，回退按钮照常出现。该问题在同时启用 dsh-baton-host 时被发现：此前替换其包装器身份会让委派递归，导致页面卡死并耗尽渲染进程内存，现在不再发生。缺少消息来源子插槽的转发行会降级为空，而不是抛错。（#83）@FUFUTPR

---

> DSH `>=0.2.2-rc.1 <0.3.0-0` supported

### Bug Fixes

- **The rewind action's row takeover no longer replaces the identity of a wrapper renderer owned by another plugin.** It decorates only the default-priority shipped row; a wrapper can still delegate to the shipped row and carry the rewind action. The issue surfaced with dsh-baton-host: replacing its wrapper identity made the delegation recurse, freezing the page and exhausting the renderer process; that no longer happens. A forwarded row without the message-source child seat degrades to empty instead of throwing. (#83) @FUFUTPR

**Full Changelog**: https://github.com/SiriLee/dsh-rewind/compare/v0.21.1...v0.21.2

## [0.21.1] - 2026-11-07

> 适配 DSH `>=0.2.2-rc.1 <0.3.0-0`

### 问题修复

- **还原被约束在记录的位置内。** 位置在捕获时确定：目录已不存在时，记下它本该解析到的位置（最近仍存在的祖先加缺失段），模型之后把目录换成符号链接也无法冒充该位置；规划与执行两层都要求末段仍是单个普通文件，符号链接、硬链接、FIFO 与设备一律跳过并报告。无法映射到本机路径的文件系统后端（如远程后端）不再捕获，避免回退删除本机同名文件。该问题由安全公告 GHSA-67px-g83w-4rv3 跟踪。（#79）@SiriLee @ADCDS

---

> DSH `>=0.2.2-rc.1 <0.3.0-0` supported

### Bug Fixes

- **A restore now stays inside the location it recorded.** The location is fixed when the file is captured — a directory that is already gone pins where it would have resolved (nearest surviving ancestor plus the missing segments), so a directory later swapped for a symlink cannot pass as that location — and both planning and the apply pass require the final component to still be one regular file (a symlink, hard link, FIFO or device is skipped and reported). A filesystem backend that cannot name a path on the host, such as a remote one, is no longer captured, so a rewind cannot delete a same-named host file. Tracked as GHSA-67px-g83w-4rv3. (#79) @SiriLee @ADCDS

**Full Changelog**: https://github.com/SiriLee/dsh-rewind/compare/v0.21.0...v0.21.1

## [0.21.0] - 2026-11-05

> 适配 DSH `>=0.2.2-rc.1 <0.3.0-0`

### 体验优化

- **已发送消息的回退按钮与复制按钮从结构上并列。** ↶ 现在是官方消息操作行里的普通 React 子节点（与 Copy 同级），随行出现、隐藏与卸载；插件不再靠 DOM 扫描、观察或逐次重查来挂载和维持它，界面其他部分不受影响，位置、尺寸与悬停行为保持不变。这回应了 #75 指出的挂载点问题。（#77）@SiriLee @MWGE22629

---

> DSH `>=0.2.2-rc.1 <0.3.0-0` supported

### Improvements

- **The rewind action on a sent message now sits beside Copy by construction.** The ↶ is an ordinary React child of the official actions row — a sibling of Copy, mounted, hidden and unmounted with it — so the plugin no longer needs a DOM scan, observer or per-change re-query to mount or maintain it; the rest of the UI pays nothing, and position, size and hover behavior are unchanged. This addresses the mount-point problem raised in #75. (#77) @SiriLee @MWGE22629

**Full Changelog**: https://github.com/SiriLee/dsh-rewind/compare/v0.20.0...v0.21.0

## [0.20.0] - 2026-11-04

> 适配 DSH `>=0.2.2-rc.1 <0.3.0-0`

本版汇总了自 `v0.19.1` 以来的主要变更。

### 问题修复

- **图片回填适配 DSH 0.2.2。** 撤回带图消息时按宿主校验的完整图片引用读取，图片在进入输入框时上传，不再因引用校验而丢失。 @SiriLee
- **撤回未读插话时，插话自己的图片也会回到输入框。** 此前只回填文字，重发会丢掉图片；沿用已读消息的图片回填通道。 (#68) @slev-agent @SiriLee
- **Windows 上回退中断后不再丢失恢复记录。** 快照引用统一为正斜杠分隔，恢复日志、去重链接和清理时的引用校验不再因反斜杠失败。 (#70) @slev-agent @SiriLee
- **回退的读取改走精确 `/api` 路由。** 0.2.2 线的通用 Connection RPC 通道无法从插件作用域挂载路由，影响预览与候选查询会落回 SPA 回退（HTTP 405）；本版改用 `/api/dsh-rewind/preview` 与 `/api/dsh-rewind/candidates`，读取不再依赖该通道。 (#74) @slev-agent @SiriLee

### 体验优化

- **插件页新增功能配图。** 详情区用中英各一张 SVG 配图展示核心操作，配置卡紧随其后。 @SiriLee
- **新增西班牙语、法语、德语、俄语、巴西葡萄牙语界面。** 跟随 DSH 上游支持的语言；原有的日语译文自然生效，无需额外安装语言包。宿主命令文案、客户端弹层与设置卡、插件卡片元数据都跟随宿主语言；详情配图仍为中英双语，其他语言回退英文图。译文由 AI 生成，欢迎母语者更正。 (#63) @SiriLee

### 其他变更

- **适配 DSH `0.2.2` 线（当前 `0.2.2-rc.1`）。** 最低 Node.js 提升到 24.9；声明只覆盖 `>=0.2.2-rc.1 <0.3.0-0`，`0.2.1-rc.x`（此前的最新线）与 `0.2.2-alpha.*` 都会被启动校验整包跳过；还在旧线上的用户请继续用 `0.19.2`。 @SiriLee

---

> DSH `>=0.2.2-rc.1 <0.3.0-0` supported.

This release summarizes the main changes since `v0.19.1`.

### Bug Fixes

- **Image restore on DSH 0.2.2.** Rewinding an image-bearing message reads the complete image reference the host verifies and uploads the image as it enters the composer, so the reference check no longer drops it. @SiriLee
- **Withdrawing an unread steering message now restores its own images to the composer.** Only the text came back before, so re-sending silently dropped the pictures; the existing image-restore path is reused. (#68) @slev-agent @SiriLee
- **An interrupted rewind no longer loses its recovery record on Windows.** Snapshot refs are written POSIX-separated, so journal, dedup-link and prune ref checks no longer fail on backslashes. (#70) @slev-agent @SiriLee
- **Rewind reads now use exact `/api` routes.** On the 0.2.2 line the generic Connection RPC channel cannot mount its route from a plugin scope, so the impact preview and candidate queries fell back to the SPA fallback (HTTP 405); this release uses `/api/dsh-rewind/preview` and `/api/dsh-rewind/candidates` and no longer depends on that channel. (#74) @slev-agent @SiriLee

### Improvements

- **The plugin page now shows a feature preview.** The detail area uses English and Chinese SVG images for the core action, keeping the configuration card close. @SiriLee
- **Spanish, French, German, Russian, and Brazilian Portuguese are now available, following the DSH upstream languages.** The existing Japanese copy takes effect naturally with no extra language pack. Host command copy, the client popover and settings card, and the plugin card metadata all follow the host language; bundle detail images stay Chinese/English and the new locales fall back to the English image. The translations are AI-generated; corrections from native speakers are welcome. (#63) @SiriLee

### Chores

- **Adapted to the DSH `0.2.2` line (currently `0.2.2-rc.1`).** Minimum Node.js is 24.9; the declaration covers `>=0.2.2-rc.1 <0.3.0-0` only, so `0.2.1-rc.x` (the previous latest line) and `0.2.2-alpha.*` are skipped whole by the startup check — stay on `0.19.2` if you are on an older line. @SiriLee

**Full Changelog**: https://github.com/SiriLee/dsh-rewind/compare/v0.19.1...v0.20.0

## [0.20.0-alpha.4] - 2026-11-03

> 适配 DSH `>=0.2.2-alpha.2 <0.3.0-0`（内测版）

### 问题修复

- **在 DSH `0.2.2-alpha.3` 上，回退的影响预览与候选列表恢复正常。** 该版本的通用 Connection RPC 通道无法从插件作用域挂载路由，两个只读查询会落到 SPA 回退并返回 405；本版改用 `/api/dsh-rewind/preview` 与 `/api/dsh-rewind/candidates` 两个精确路由，读取不再依赖该通道。(#74) @slev-agent @SiriLee

### 其他变更

- **验证目标移到 DSH `0.2.2-alpha.3`。** 它落在已声明的范围内，因此兼容声明不变。 @SiriLee

---

> DSH `>=0.2.2-alpha.2 <0.3.0-0` supported. Internal alpha.

### Bug Fixes

- **On DSH `0.2.2-alpha.3`, the rewind impact preview and candidate list work again.** That release's generic Connection RPC channel cannot mount its route from a plugin scope, so the two read-only queries fell through to the SPA fallback with HTTP 405; this release uses two exact routes, `/api/dsh-rewind/preview` and `/api/dsh-rewind/candidates`, and the reads no longer depend on that channel. (#74) @slev-agent @SiriLee

### Chores

- **The verification target moves to DSH `0.2.2-alpha.3`.** It sits inside the declared range, so the compatibility declaration is unchanged. @SiriLee

**Full Changelog**: https://github.com/SiriLee/dsh-rewind/compare/v0.20.0-alpha.3...v0.20.0-alpha.4

## [0.20.0-alpha.3] - 2026-11-03

> 适配 DSH `>=0.2.2-alpha.2 <0.3.0-0`（内测版）

### 问题修复

- **Windows 上回退中断后不再丢失恢复记录。** 快照引用统一为正斜杠分隔，恢复日志、去重链接和清理时的引用校验不再因反斜杠失败。 (#70) @slev-agent @SiriLee

---

> DSH `>=0.2.2-alpha.2 <0.3.0-0` supported. Internal alpha.

### Bug Fixes

- **An interrupted rewind no longer loses its recovery record on Windows.** Snapshot refs are written POSIX-separated, so journal, dedup-link and prune ref checks no longer fail on backslashes. (#70) @slev-agent @SiriLee

**Full Changelog**: https://github.com/SiriLee/dsh-rewind/compare/v0.20.0-alpha.2...v0.20.0-alpha.3

## [0.20.0-alpha.2] - 2026-11-02

> 适配 DSH `>=0.2.2-alpha.2 <0.3.0-0`（内测版）

### 问题修复

- **撤回未读插话时，插话自己的图片也会回到输入框。** 此前只回填文字，重发会丢掉图片；沿用已读消息的图片回填通道。 (#68) @slev-agent @SiriLee

---

> DSH `>=0.2.2-alpha.2 <0.3.0-0` supported. Internal alpha.

### Bug Fixes

- **Withdrawing an unread steering message now restores its own images to the composer.** Only the text came back before, so re-sending silently dropped the pictures; the existing image-restore path is reused. (#68) @slev-agent @SiriLee

**Full Changelog**: https://github.com/SiriLee/dsh-rewind/compare/v0.20.0-alpha.1...v0.20.0-alpha.2

## [0.20.0-alpha.1] - 2026-10-28

> 适配 DSH `>=0.2.2-alpha.2 <0.3.0-0`（内测版）

### 问题修复

- **图片回填适配 DSH 0.2.2。** 撤回带图消息时按宿主校验的完整图片引用读取，图片在进入输入框时上传，不再因引用校验而丢失。 @SiriLee

### 体验优化

- **插件页新增功能配图。** 详情区用中英各一张 SVG 配图展示核心操作，配置卡紧随其后。 @SiriLee
- **新增西班牙语、法语、德语、俄语、巴西葡萄牙语界面。** 跟随 DSH 上游支持的语言；原有的日语译文自然生效，无需额外安装语言包。宿主命令文案、客户端弹层与设置卡、插件卡片元数据都跟随宿主语言；详情配图仍为中英双语，其他语言回退英文图。译文由 AI 生成，欢迎母语者更正。 (#63) @SiriLee

### 其他变更

- **适配 DSH `0.2.2-alpha.2`。** 最低 Node.js 提升到 24.9；0.19.1 继续支持 0.2.1 线。 @SiriLee

---

> DSH `>=0.2.2-alpha.2 <0.3.0-0` supported. Internal alpha.

### Bug Fixes

- **Image restore on DSH 0.2.2.** Rewinding an image-bearing message reads the complete image reference the host verifies and uploads the image as it enters the composer, so the reference check no longer drops it. @SiriLee

### Improvements

- **The plugin page now shows a feature preview.** The detail area uses English and Chinese SVG images for the core action, keeping the configuration card close. @SiriLee
- **Spanish, French, German, Russian, and Brazilian Portuguese are now available, following the DSH upstream languages.** The existing Japanese copy takes effect naturally with no extra language pack. Host command copy, the client popover and settings card, and the plugin card metadata all follow the host language; bundle detail images stay Chinese/English and the new locales fall back to the English image. The translations are AI-generated; corrections from native speakers are welcome. (#63) @SiriLee

### Chores

- **Adapt to DSH `0.2.2-alpha.2`.** Minimum Node.js is now 24.9; 0.19.1 keeps supporting the 0.2.1 line. @SiriLee

**Full Changelog**: https://github.com/SiriLee/dsh-rewind/compare/v0.19.1...v0.20.0-alpha.1

## [0.19.1] - 2026-10-26

> 适配 DSH `>=0.2.1-rc.1 <0.3.0-0`

### 新增功能

- **新增日语（日本語）。** 宿主命令文案、客户端弹窗与设置卡、插件卡片元数据都跟随宿主语言；此前只有中文与英文。DSH 本身不提供日语，需另装日语语言包（如 `@fang2hou/dsh-locale-ja`）才可选用。(#61) @2001Y @SiriLee

---

> DSH `>=0.2.1-rc.1 <0.3.0-0` supported.

### New Features

- **Japanese (日本語) is now available.** Host command copy, the client popover and settings card, and the plugin card metadata all follow the host language; only Chinese and English were available before. DSH does not ship Japanese itself — install a Japanese language pack (e.g. `@fang2hou/dsh-locale-ja`) to select it. (#61) @2001Y @SiriLee

**Full Changelog**: https://github.com/SiriLee/dsh-rewind/compare/v0.19.0...v0.19.1

## [0.19.0] - 2026-10-24

> 适配 DSH `>=0.2.1-rc.1 <0.3.0-0`

### 体验优化

- **回退的隐藏层不再依赖 DOM。** 撤回节点在 Chat 快照算出 `order` 之前就被标成 `visibility: 'hidden'`，因此不进入 `order`、不会被挂载，也没有了逐行改 `style.display` 的 DOM 隐藏路径；正文、分组与已加载回合的导航因此保持一致。刷新走增量：撤回区间只在命令节点变化时重算，区间不变时只重新推导发生变化的节点与受影响的回合摘要，区间变化时才整体重建——长会话不再每一步都重扫整段节点。节点仍留在快照里，输入框回填不受影响。右侧导轨仍由宿主的 `turnOutline` 驱动，被整体撤回的回合会显示为未加载刻点。(#58) @SiriLee

### 其他变更

- **移除公开的客户端隐藏契约（破坏性）。** `dsh-rewind-plugin/client` 不再导出 `hiddenSeqsOf` / `targetSeqOfArgs` / `HiddenChat`，撤回节点也不再带 `data-dsh-rewind-hidden`；若第三方插件或脚本依赖过这些入口，本版起没有替代。新的隐藏机制是私有接缝，不对外承诺。(#59) @SiriLee

---

> DSH `>=0.2.1-rc.1 <0.3.0-0` supported

### Improvements

- **Rewind hiding no longer depends on the DOM.** Withdrawn nodes are marked `visibility: 'hidden'` before the Chat snapshot computes `order`, so they never enter `order`, are never mounted, and the per-row `style.display` hiding path is gone; the transcript, grouping and the loaded turn navigation therefore stay consistent. Refreshes are incremental: the withdrawn spans are recomputed only when a command node changes; while they hold, only the changed nodes and the affected Turn-process summaries are re-derived, and a full rebuild happens only when the spans change — a long session is no longer re-scanned on every step. The nodes stay in the snapshot, so the composer refill is unaffected. The right-hand rail is still fed by the host's `turnOutline`, so a fully withdrawn Turn shows as an unloaded mark. (#58) @SiriLee

### Chores

- **The public client hiding contract is removed (a breaking change).** `dsh-rewind-plugin/client` no longer exports `hiddenSeqsOf` / `targetSeqOfArgs` / `HiddenChat`, and withdrawn nodes no longer carry `data-dsh-rewind-hidden`; if a third-party plugin or script relied on those entry points, there is no replacement from this version on. The new hiding mechanism is a private seam and promises nothing to third parties. (#59) @SiriLee

**Full Changelog**: https://github.com/SiriLee/dsh-rewind/compare/v0.18.1...v0.19.0

## [0.18.1] - 2026-10-24

> 适配 DSH `>=0.2.1-rc.1 <0.3.0-0`

### 体验优化

- **回退弹窗与宿主的回合用量面板对齐。** 尺寸与字阶取自该面板；随页面滚动与窗口缩放保持锚定，下方放不下时翻到上方；模式步去掉单独的取消页脚，只保留目标预览；文件模式改称「回退对话和文件」，两条提示各收成一行。@SiriLee
- **回退按钮的提示与相邻复制按钮一致。** 两个 ↶ 按钮都改用宿主的 Tooltip 组件（side bottom），去掉原生 `title`；hover 填充只在支持 hover 的设备上生效。@SiriLee

---

> DSH `>=0.2.1-rc.1 <0.3.0-0` supported.

### Improvements

- **The rewind popover now matches the host's turn-usage panel.** It takes that panel's box and type scale, stays anchored through page scroll and window resize (flipping above when the bottom does not fit), drops the lone cancel footer on the mode step so only the target preview remains, renames the file mode to "Rewind conversation and files", and keeps each hint to one line. @SiriLee
- **The rewind buttons' hint now matches the adjacent copy action.** Both ↶ buttons render through the host Tooltip (side bottom) instead of a native `title`, and the hover fill only applies on hover-capable devices. @SiriLee

**Full Changelog**: https://github.com/SiriLee/dsh-rewind/compare/v0.18.0...v0.18.1

## [0.18.0] - 2026-10-21

> 适配 DSH `>=0.2.1-rc.1 <0.3.0-0`

### 新增功能

- **回退的读取改走 Connection RPC。** 模式弹窗的影响预览与 `/rewind` 候选列表不再占用命令通道，也不再往会话日志追加 `command/run` / `command/done`、不等聊天节点；执行命令与其结果不变。#55 报告了该问题。(#56) @SiriLee

### 体验优化

- **模式弹窗的材质与宿主 overlay 对齐。** 改用官方 `--dsw-specific-menu` 与 `--dsw-menu-backdrop-filter`，隔离弹窗表面，并用 elevation 描边与阴影替代中性边框。#55 报告了材质与官方规范不符。@SiriLee

---

> DSH `>=0.2.1-rc.1 <0.3.0-0` supported

### New Features

- **Rewind reads now go over Connection RPC.** The mode popover's impact preview and the `/rewind` candidate list no longer use the command channel, no longer append `command/run` / `command/done` to the session log, and no longer wait on chat nodes; the execution command and its results are unchanged. The problem was reported in #55. (#56) @SiriLee

### Improvements

- **The mode popover's material now matches the host overlay.** It uses the documented `--dsw-specific-menu` and `--dsw-menu-backdrop-filter`, isolates its surface, and takes the elevation stroke and shadow instead of a neutral border. #55 reported the material's mismatch with the official spec. @SiriLee

**Full Changelog**: https://github.com/SiriLee/dsh-rewind/compare/v0.17.1...v0.18.0

## [0.17.1] - 2026-10-19

> 适配 DSH `>=0.2.1-rc.1 <0.3.0-0`

### 体验优化

- **输入与侧栏动画不再触发整段重扫。** 回退桥此前盯着整个 `document.body`，每次在输入框敲键、每个侧栏动画都会重扫整段会话（两遍 `chat.order` 加全文 `querySelectorAll`）；现在按快照记忆化、没有隐藏行时跳过座位扫描，并且只在 composer 与插件面板之外的结构变化时唤醒。撤回隐藏与还原的结果不变。(#54) @Shiro-umi @SiriLee

---

> DSH `>=0.2.1-rc.1 <0.3.0-0` supported.

### Improvements

- **Typing and sidebar animations no longer trigger a whole-transcript rescan.** The rewind bridge used to watch all of `document.body`, so every composer keystroke and every sidebar animation rescanned the transcript (two passes over `chat.order` plus a document-wide `querySelectorAll`); it now memoises per snapshot, skips the seat pass when nothing is hidden, and only wakes for structure outside the composer and plugin panels. The hiding and restore results are unchanged. (#54) @Shiro-umi @SiriLee

**Full Changelog**: https://github.com/SiriLee/dsh-rewind/compare/v0.17.0...v0.17.1

## [0.17.0] - 2026-10-18

> 适配 DSH `>=0.2.1-rc.1 <0.3.0-0`

### 新增功能

- **可关闭文件快照备份。** 新增 `fileCheckpointingEnabled`（默认开启）。关闭后不再创建写前/边界快照，文件还原只覆盖已有记录；对话回退与自动清理不受影响。不需要文件回退的用户可借此减少存储占用与读写开销。(#53) @SiriLee

### 其他变更

- **验证目标移到 DSH `0.2.1-rc.2`。** 它落在已声明的范围内，因此兼容声明不变。@SiriLee

---

> DSH `>=0.2.1-rc.1 <0.3.0-0` supported.

### New Features

- **File snapshot backups can be turned off.** New `fileCheckpointingEnabled` (default on). When off, no new before-write/boundary snapshots are recorded; file restore covers existing records only. Conversation rewind and auto-cleanup are unaffected. Users who do not need file rewind can avoid the extra copies and read/write overhead. (#53) @SiriLee

### Chores

- **The verification target moves to DSH `0.2.1-rc.2`.** It sits inside the declared range, so the compatibility declaration is unchanged. @SiriLee

**Full Changelog**: https://github.com/SiriLee/dsh-rewind/compare/v0.16.0...v0.17.0

## [0.16.0] - 2026-10-17

> 适配 DSH `>=0.2.1-rc.1 <0.3.0-0`

本版汇总了自 `v0.15.3` 以来的主要变更。

### 新增功能

- **快照上限与自动清理节奏进了插件配置。** 新增 `maxFileBytes`（单文件备份上限，`0` 为不限）、`maxAnchorGroups`（每会话保留的锚点组数，校验 `>= 1`）、`autoSweepIntervalMs`（自动清理间隔，默认一天）三个字段，默认值不变；此前上限只能靠环境变量、锚点组数无法调整、清理节奏写死 24 小时。三项不出现在配置卡上，改配置文件后随插件重载生效。@SiriLee

### 问题修复

- **快照基准改从会话的当前目录读取。** DSH `0.2.1` 起，相对路径由会话的**当前**目录解析（`working-directory` 服务，会话中途可经 `working_directory` 工具变更）；本版据此读取快照基准——中途切换目录后的写入也能被正确记录与还原，此前固定用不可变的 `header.cwd`。@SiriLee
- **文件其实已还原时，回退不再因单个文件而报错。** 观察同步里只护住了 `resolve`，`fs.stat` 抛错会冒出 `executeRewind`，使一次「其实已还原」的回退报错并丢掉摘要；现在按文件尽力而为。@SiriLee
- **热停用插件不再留下被隐藏的行。** 撤回行的隐藏是本插件对宿主行的改动，桥卸载后无人还原，会话要等页面刷新才恢复；现在卸载时统一还原，并改用可遍历的强引用集、每次刷新清理已脱离的行。@SiriLee
- **回退期间不再做文件历史边界复检。** 标记写入是同步分发，复检会在 `both` 模式正写文件时读到半成品，记下撕裂或回退前的状态；现在有回退在飞就跳过该趟，真正的边界到来自会重新推导。@SiriLee
- **检查点提交被拒时不再泄漏暂存副本。** 提交失败（存储由更新版本写入、或 IO 出错）会把暂存的字节副本留在磁盘且无人认领，此后该会话每次写入类调用都漏一份；现在失败即丢弃，报错照旧。@SiriLee
- **provider 重载后不再握着已释放的 fs 实例。** 注入作用域销毁时清掉捕获的引用，避免之后的回退把已释放实例交给观察同步。@SiriLee

### 其他变更

- **适配 DSH `0.2.1` 线。** 快照基准依赖 `0.2.1` 才提供的工作目录服务，因此声明只覆盖 `>=0.2.1-rc.1 <0.3.0-0`：DSH `0.2.0-rc.x`（当前 npm `latest`）与 `0.2.1` 的 alpha 迭代版都会被启动校验整包跳过，还在 `0.2.0-rc.x` 上的用户请继续用 `0.15.3`。@SiriLee
- **两个环境变量退役（需要迁移）。** `DSH_REWIND_MAX_FILE_BYTES` 与 `DSH_REWIND_SNAPSHOT_DIR` 不再生效，请把值移到配置的 `maxFileBytes` / `snapshotDir`；存储根与上限从此只由配置决定，`$DSH_HOME` 仍经 `dshHome` 提供默认值。@SiriLee

---

> DSH `>=0.2.1-rc.1 <0.3.0-0` supported.

This release summarizes the main changes since `v0.15.3`.

### New Features

- **The snapshot bounds and the sweep cadence now come from plugin config.** Three fields land: `maxFileBytes` (per-file backup cap, `0` disables it), `maxAnchorGroups` (anchor groups kept per session, validated `>= 1`) and `autoSweepIntervalMs` (automatic-cleanup cadence, one day by default), all at their previous defaults; the cap used to need an env var, the group bound was not reachable at all, and the cadence was hardcoded to 24 h. None of the three appears on the configuration card, and a config edit takes effect when the plugin reloads. @SiriLee

### Bug Fixes

- **The snapshot base is read from the Session's current directory.** From DSH `0.2.1`, a relative path resolves against the Session's *current* directory (the `working-directory` service, changeable mid-session through the `working_directory` tool); this release reads the capture base from it, so writes after a mid-session directory change are captured and restored correctly — the immutable `header.cwd` was used before. @SiriLee
- **A rewind no longer fails over a single file when the files are in fact restored.** Only `resolve` was guarded in the observation sync, so a throwing `fs.stat` escaped `executeRewind` — a rewind whose files were already restored reported an error and dropped its summary. It is now best-effort per file. @SiriLee
- **Unloading the plugin no longer leaves hidden rows behind.** Hiding withdrawn rows is this plugin's own mutation of host rows, and nothing reverted it once the bridge unmounted, so a live disable left the transcript truncated until a page reload; the unmount cleanup now restores them, tracking the elements in an iterable strong set and pruning detached rows on every refresh. @SiriLee
- **No file-history boundary pass while a rewind is in flight.** The marker is appended through a synchronous dispatch, so the pass could read the files `both` mode was still writing and record a torn or pre-restore state; it now stands down for a session with a rewind in flight, and the next real boundary re-derives it. @SiriLee
- **A refused checkpoint commit no longer leaks the staged copy.** A failed commit (a store written by a newer build, or an IO failure) left the staged bytes on disk with no owner, so every later write-class call in that session leaked one more copy; the capture is now discarded on failure, with the error still loud. @SiriLee
- **A released fs instance is no longer held across a provider reload.** The captured reference is cleared when its injection scope disposes, so a later rewind cannot hand a released instance to the observation sync. @SiriLee

### Chores

- **Adapted to the DSH `0.2.1` line.** The snapshot base depends on the working-directory service that only `0.2.1` provides, so the declaration covers `>=0.2.1-rc.1 <0.3.0-0` only: DSH `0.2.0-rc.x` (the current npm `latest`) and the `0.2.1` alphas are skipped whole by the startup check — if you are still on `0.2.0-rc.x`, stay on `0.15.3`. @SiriLee
- **Two environment variables are retired (a migration is needed).** `DSH_REWIND_MAX_FILE_BYTES` and `DSH_REWIND_SNAPSHOT_DIR` no longer apply — move their values into the `maxFileBytes` / `snapshotDir` config fields; the store root and the cap are now decided by config alone, with `$DSH_HOME` still feeding the default through `dshHome`. @SiriLee

**Full Changelog**: https://github.com/SiriLee/dsh-rewind/compare/v0.15.3...v0.16.0

## [0.16.0-beta.1] - 2026-10-17

> 适配 DSH `>=0.2.1-rc.1 <0.3.0-0`（公测版）

### 其他变更

- **兼容下限抬到 DSH `0.2.1-rc.1`。** 声明不再覆盖 alpha 迭代版；alpha.4／alpha.5 会被启动校验拒绝。@SiriLee

---

> DSH `>=0.2.1-rc.1 <0.3.0-0` supported. Public beta.

### Chores

- **The compatibility floor rises to DSH `0.2.1-rc.1`.** The declaration no longer covers alphas; the startup check refuses alpha.4 / alpha.5. @SiriLee

**Full Changelog**: https://github.com/SiriLee/dsh-rewind/compare/v0.16.0-alpha.2...v0.16.0-beta.1

## [0.16.0-alpha.2] - 2026-10-16

> 适配 DSH `>=0.2.1-alpha.2 <0.3.0-0`（内测版）

### 新增功能

- **快照上限与自动清理节奏进了插件配置。** 新增 `maxFileBytes`（单文件备份上限，`0` 为不限）、`maxAnchorGroups`（每会话保留的锚点组数，校验 `>= 1`）、`autoSweepIntervalMs`（自动清理间隔，默认一天）三个字段，默认值不变；此前上限只能靠环境变量、锚点组数无法调整、清理节奏写死 24 小时。三项不出现在配置卡上，改配置文件后随插件重载生效。@SiriLee

### 问题修复

- **文件其实已还原时，回退不再因单个文件而报错。** 观察同步里只护住了 `resolve`，`fs.stat` 抛错会冒出 `executeRewind`，使一次「其实已还原」的回退报错并丢掉摘要；现在按文件尽力而为。@SiriLee
- **热停用插件不再留下被隐藏的行。** 撤回行的隐藏是本插件对宿主行的改动，桥卸载后无人还原，会话要等页面刷新才恢复；现在卸载时统一还原，并改用可遍历的强引用集、每次刷新清理已脱离的行。@SiriLee
- **回退期间不再做文件历史边界复检。** 标记写入是同步分发，复检会在 `both` 模式正写文件时读到半成品，记下撕裂或回退前的状态；现在有回退在飞就跳过该趟，真正的边界到来自会重新推导。@SiriLee
- **检查点提交被拒时不再泄漏暂存副本。** 提交失败（存储由更新版本写入、或 IO 出错）会把暂存的字节副本留在磁盘且无人认领，此后该会话每次写入类调用都漏一份；现在失败即丢弃，报错照旧。@SiriLee
- **provider 重载后不再握着已释放的 fs 实例。** 注入作用域销毁时清掉捕获的引用，避免之后的回退把已释放实例交给观察同步。@SiriLee

### 其他变更

- **两个环境变量退役（需要迁移）。** `DSH_REWIND_MAX_FILE_BYTES` 与 `DSH_REWIND_SNAPSHOT_DIR` 不再生效，请把值移到配置的 `maxFileBytes` / `snapshotDir`；存储根与上限从此只由配置决定，`$DSH_HOME` 仍经 `dshHome` 提供默认值。@SiriLee
- **`engines.dsh` 与 peers 同界。** 声明补上上界，成为 `>=0.2.1-alpha.2 <0.3.0-0`；marketplace 与启动校验从此读同一个界。@SiriLee
- **验证目标移到 DSH `0.2.1-alpha.4`。** 它落在已声明的范围内，因此兼容声明不变。@SiriLee

---

> DSH `>=0.2.1-alpha.2 <0.3.0-0` supported. Internal alpha.

### New Features

- **The snapshot bounds and the sweep cadence now come from plugin config.** Three fields land: `maxFileBytes` (per-file backup cap, `0` disables it), `maxAnchorGroups` (anchor groups kept per session, validated `>= 1`) and `autoSweepIntervalMs` (automatic-cleanup cadence, one day by default), all at their previous defaults; the cap used to need an env var, the group bound was not reachable at all, and the cadence was hardcoded to 24 h. None of the three appears on the configuration card, and a config edit takes effect when the plugin reloads. @SiriLee

### Bug Fixes

- **A rewind no longer fails over a single file when the files are in fact restored.** Only `resolve` was guarded in the observation sync, so a throwing `fs.stat` escaped `executeRewind` — a rewind whose files were already restored reported an error and dropped its summary. It is now best-effort per file. @SiriLee
- **Unloading the plugin no longer leaves hidden rows behind.** Hiding withdrawn rows is this plugin's own mutation of host rows, and nothing reverted it once the bridge unmounted, so a live disable left the transcript truncated until a page reload; the unmount cleanup now restores them, tracking the elements in an iterable strong set and pruning detached rows on every refresh. @SiriLee
- **No file-history boundary pass while a rewind is in flight.** The marker is appended through a synchronous dispatch, so the pass could read the files `both` mode was still writing and record a torn or pre-restore state; it now stands down for a session with a rewind in flight, and the next real boundary re-derives it. @SiriLee
- **A refused checkpoint commit no longer leaks the staged copy.** A failed commit (a store written by a newer build, or an IO failure) left the staged bytes on disk with no owner, so every later write-class call in that session leaked one more copy; the capture is now discarded on failure, with the error still loud. @SiriLee
- **A released fs instance is no longer held across a provider reload.** The captured reference is cleared when its injection scope disposes, so a later rewind cannot hand a released instance to the observation sync. @SiriLee

### Chores

- **Two environment variables are retired (a migration is needed).** `DSH_REWIND_MAX_FILE_BYTES` and `DSH_REWIND_SNAPSHOT_DIR` no longer apply — move their values into the `maxFileBytes` / `snapshotDir` config fields; the store root and the cap are now decided by config alone, with `$DSH_HOME` still feeding the default through `dshHome`. @SiriLee
- **`engines.dsh` now shares the peers' bound.** The declaration gains an upper bound and reads `>=0.2.1-alpha.2 <0.3.0-0`, so the marketplace and the startup check read the same range. @SiriLee
- **The verification target moves to DSH `0.2.1-alpha.4`.** It sits inside the declared range, so the compatibility declaration is unchanged. @SiriLee

**Full Changelog**: https://github.com/SiriLee/dsh-rewind/compare/v0.16.0-alpha.1...v0.16.0-alpha.2

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
