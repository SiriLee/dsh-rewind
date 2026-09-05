# 发布流程

[English](release.md)

## 首次发布（手动，一次性）

Trusted Publisher 要求**包已存在**才能配置，因此首个版本走本地发布：

```sh
npm login
npm publish --access public
```

- 若提示 `EOTP`（一次性密码）：按 CLI 输出的浏览器认证链接完成认证，或用
  authenticator 的 6 位码 `npm publish --otp=<code>` 重试。
- 首个版本无 provenance（本地路径），合规；之后每次 CI 发布自动带
  Sigstore/SLSA provenance。

## 配置 Trusted Publisher（npmjs.com，一次性）

打开 `https://www.npmjs.com/package/dsh-rewind-plugin` → 包右上角 **settings**
→ **Trusted Publisher**：

| 字段 | 值 |
| --- | --- |
| Provider | GitHub Actions |
| Organization or user | `SiriLee` |
| Repository | `dsh-rewind`（GitHub 仓库名，与 npm 包名可不同） |
| Workflow filename | `publish.yml` |
| Environment | 留空 |
| Allowed actions | `npm publish` |

## 后续发布（CI 自动）

发布 workflow 为**版本驱动**：npm dist-tag 由 `package.json` 中的版本号决定、与分支无关。
稳定版发 `latest`；pre-release 发到与其 pre-release 标识符同名的 dist-tag
（如 `0.9.0-alpha.1` → `alpha`、`0.9.0-rc.1` → `rc`）。dist-tag 无需手传。

按要发布的版本线选择分支与版本步进：

| 发布类型 | 分支 | 版本步进 | dist-tag |
| --- | --- | --- | --- |
| 当前线稳定补丁 | `release/0.8.x` | `npm version patch` | `latest` |
| 下一线 pre-release | `main` | `npm version prerelease --preid=alpha` | `alpha` |
| 下一线正式版 | `main` | `npm version 0.9.0` | `latest` |

每次发布为 `git push <分支>`，再 `git push <分支> --tags`。

- **升版前手动确认**：确认无插件未针对其验证过的更新 DSH 版本（pre-release
  可能只随 Desktop 捆绑、而不发到 npm；见 docs/compat/audit.md）。
- workflow 校验 tag 与 `package.json` 版本一致，跑 typecheck + 测试 + 完整
  构建 + 产物验证，以 `--provenance`（Sigstore）发布到版本推导出的 dist-tag，
  并创建 GitHub Release（pre-release 会建成 GitHub pre-release，而非 `latest`）。
  **幂等**——已发布的版本会跳过。
- CI（`.github/workflows/ci.yml`）在每次 push / PR 跑 `npm run check`——
  typecheck + 测试 + 构建 + 产物验证 + `npm pack --dry-run`，且覆盖
  engines 两个边界版本；tarball 布局由 `tests/package-layout.test.ts` 守护。

## DSH 版本适配（peer 范围维护）

DSH 仍在 rc 阶段，npm 的 prerelease 匹配规则要求 peer 范围与宿主版本
**同 `[major, minor, patch]` 元组**才能匹配。因此 peerDependencies 采用
OR 并集覆盖 DSH 已发布的每个元组系列（如 `^0.1.0-rc.6 || ^0.1.1-rc.2 || ^0.1.2-rc.1`），
并随 DSH 发版追加。

- **何时需要更新**：仅当 DSH 发布新元组（`0.1.1 → 0.1.2 → 0.2.x`）时；
  同元组内 rc 滚动（`0.1.1-rc.2 → rc.3`）无需动作。DSH 所有包同版本发布，
  `npm view @deepseek-ai/dsh version` 即权威信号。
- **例外 —— `@deepseek-ai/dsh-client-runtime`**：它从未发布 `0.1.2`
  （npm `next` 为 `0.1.1-rc.2`）且仅被 `import type` 引用，保持
  `^0.1.0-rc.6 || ^0.1.1-rc.2` 即可（无 `0.1.2` 元组项）。
- **已发布元组检查（可选）**：`node scripts/check-dsh-version.mjs` 用 npm `latest`
  dist-tag 版本对比 peer 覆盖的元组（exit 0 无需动作，exit 1 需要）。它**只读
  `latest` tag**；发布在其它 tag 的 pre-release 走**手动发布前检查**
  ——见上文"升版前手动确认"。
- **更新步骤**：给每个 `@deepseek-ai/dsh-*` peer 追加 `|| ^<新元组>-rc.<n>`
  → devDependencies 同步升到最新 → `npm install` → `npm run check` → 发版。
- **正式版后收敛**：DSH 发布 final 版本后，正式版不受 prerelease 元组规则
  限制，peer 可收敛为稳定的 `^0.1.x` 单范围，此节即可删除。

## 发布版本线模型

**一个发布对准一条 DSH 版本线。** 插件自身版本号与宿主解耦；某发布所对准的
DSH 线由 peer 约束（单一 companion 元组）声明，而非插件版本号。

| 插件版本 | DSH 线 | 说明 |
| --- | --- | --- |
| `0.7.x` | `0.1.1` + `0.1.2`（广兼容） | 冻结 / EOL |
| `0.8.x` | `0.1.2-rc.1`（单线） | 当前稳定 |
| `0.9.x` | `0.1.3`（单线） | 下一线 |

**版本号。** DSH 版本线破坏性变更 ＝ MAJOR 升版（与更早 DSH 线向后不兼容）。
同一线内 MINOR/PATCH 保持向后兼容。

**分支（主干开发）。** `main` 是唯一集成与发布线，始终可发版。当前已发布
稳定版从发布提交点切出短命 `release/<版本>.x` 维护分支；该分支承接
backport 修复，同时 `main` 前进到下一线。更早的（广兼容）线冻结成 tag，无分支。

**dist-tag 路由。** 发布 workflow 按版本号取 npm dist-tag：稳定版发 `latest`；
pre-release 发到与其 pre-release 标识符同名的 dist-tag（`0.9.0-alpha.1` →
`alpha`、`0.9.0-rc.1` → `rc`）。pre-release 不占据 `latest`。

**支持窗口 / EOL。** 一条 DSH 线仅在声明的窗口内受支持。默认窗口到下一
DSH 线作为 `latest` 发布为止；此后该线 EOL、冻结、不再发补丁。此处 `0.8.x`
（`0.1.2-rc.1`）支持到 `0.9.x`（`0.1.3`）作为 `latest` 发布为止。

**Bug 修复流程（先向前修，再回迁）。** 跨多条支持线的修复，先在 `main` 上
修复，再回迁到各仍受支持的 release 分支。仅特定线的修复，只在对应线修复。

上一节 OR 并集 peer 为旧的多线做法；上述单线模型使用单一 peer 元组。
