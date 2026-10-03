# 发布说明（CHANGELOG）规范

[English](notes-template.md)

发布说明存放在 [`CHANGELOG.md`](../../CHANGELOG.md)；发布 workflow 会把某个 tag 的块
挂成该版本的 GitHub Release 正文。版式遵循
[Keep a Changelog](https://keepachangelog.com/)——每版一块、最新在上、ISO 日期。

## 块

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

## 规则

1. 中文在前、英文在后（中间 `---`）；每条中英各有一份。
2. 兼容性行原样引用 `engines.dsh`，不声明上界。
3. 范围后接阶段词：`-alpha` → `内测版`/`Internal alpha.`；`-beta` → `公测版`/`Public
   beta.`；`-rc` → `候选版`/`Release candidate.`；正式版省略。
4. 正式版的块以 `本版汇总了自 \`vPrev\` 以来的主要变更。` / `This release summarizes the
   main changes since \`vPrev\`.` 开头；预发布不写。
5. 只写功能相关、净的变化：内部重构、文档、测试、仓库内工具都不写；未发布区间里引入又
   回退的也不写。
6. 分类：`新增功能`/`New Features`（新能力）、`问题修复`/`Bug Fixes`（用户可见缺陷）、
   `体验优化`/`Improvements`（文案、图标、样式、性能）、`其他变更`/`Chores`（其余——
   换 DSH 线时放第一条）。
7. 署名写在句末：`#123` 照写；外部贡献者写 `@handle`（写条目时顺手查一下账号）；无法确认
   的身份按原名写，不猜。
8. 空的小节省略。
9. `**Full Changelog**` 只写一次、位于最后一行、以本 tag 结尾（提取脚本会校验）。

## 生命周期

- **开发中**：每个用户可见改动都加到 `## [Unreleased]` 下，中英都写。
- **发布时**（随发布提交）：把块改名为 `## [X.Y.Z] - YYYY-MM-DD`，把 `vNEXT` 换成 tag，
  补阶段词或"汇总"句，再新开一个 `## [Unreleased]`。
- **CI**：`node scripts/changelog-extract.mjs <tag>` 取出该块；块缺失或不一致会在 npm
  发布之前让运行失败。

块被原样使用（不经过生成文本，发布后也不再编辑），块内内联的 compare 链接让提取出的正文
自包含。`CHANGELOG.md` 不进 npm 包，由 `tests/package-layout.test.ts` 钉住。
