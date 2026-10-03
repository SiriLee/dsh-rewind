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
| 当前线稳定补丁 | `release/<line>.x` | `npm version patch` | `latest` |
| 下一线 pre-release | `main` | `npm version prerelease --preid=alpha` | `alpha` |
| 下一线正式版 | `main` | `npm version <next>` | `latest` |

每次发布为 `git push <分支>`，再 `git push <分支> --tags`。

- 发布提交为 **`chore: release vX.Y.Z`**，**轻量 `vX.Y.Z` tag** 落在该提交上。
  **不要**用 `gh release create <tag>` 事先建 tag/release（会打到远端 `main`
  HEAD，导致 tag/版本校验失败）。
- **升版前手动确认**：确认无插件未针对其验证过的更新 DSH 版本（pre-release
  可能只随 Desktop 捆绑、而不发到 npm；见 docs/compat/audit.md）。
- workflow 校验 tag 与 `package.json` 版本一致，跑 typecheck + 测试 + 完整
  构建 + 产物验证，以 `--provenance`（Sigstore）发布到版本推导出的 dist-tag，
  并创建 GitHub Release（pre-release 会建成 GitHub pre-release，而非 `latest`）。
  **幂等**——已发布的版本会跳过。
- CI（`.github/workflows/ci.yml`）在每次 push / PR 跑 `npm run check`——
  typecheck + 测试 + 构建 + 产物验证 + `npm pack --dry-run`，且覆盖
  engines 两个边界版本；tarball 布局由 `tests/package-layout.test.ts` 守护。
- GitHub Release 正文由 workflow 以 `--generate-notes` 自动生成，仅是**占位**
  （按版本取 `--latest` / `--prerelease`）。发布运行成功后，请用**手写双语**
  正文（中文在前、英文在后）覆盖——切勿把自动文本当作最终发布说明。

## DSH 版本适配

`peerDependencies` 声明插件已适配的 DSH 范围。DSH 在 `includePrerelease` 下校验每个
`@deepseek-ai/dsh-*` peer（见 `docs/compat/audit.md`），匹配范围因此比 npm 默认规则更宽。
范围不再适配时更新声明：插件自身更新放弃了对旧版本的兼容，或上游发生 minor/major 变更。
不刻意维持范围之外的兼容性；`engines.dsh` 声明同一范围的下限。

声明不等于验证记录：验证记录是 `docs/compat/audit.md` 的 Targeted version，每个 DSH 发布
通过把 `@deepseek-ai/dsh-*` devDependency 指向新版本并跑 `npm run check` 来更新。

## 发布版本线模型

**一个发布对准一条 DSH 版本线。** 插件自身版本号与宿主解耦；某发布所对准的
DSH 线由 peer 约束声明，而非插件版本号。

| 插件版本 | DSH 线 | 角色（示例） |
| --- | --- | --- |
| `0.7.x` | `0.1.1` + `0.1.2`（广兼容） | 冻结 / EOL |
| `0.8.x` | `0.1.2-rc.1`（单线） | 当前线 |
| `0.9.x` | `0.1.3`（单线） | 后续线 |

各行仅为示例——某个发布对准的 DSH 线由 peer 约束声明，其 npm dist-tag 按版本号
派生（见上文），因此本模型不跟随插件自身版本号变化。

**版本号。** DSH 版本线破坏性变更 ＝ MAJOR 升版（与更早 DSH 线向后不兼容）。
同一线内 MINOR/PATCH 保持向后兼容。

**分支（主干开发）。** `main` 是唯一集成与发布线，始终可发版。当前已发布
稳定版从发布提交点切出短命 `release/<版本>.x` 维护分支；该分支承接
backport 修复，同时 `main` 前进到下一线。更早的（广兼容）线冻结成 tag，无分支。

**dist-tag 路由。** 发布 workflow 按版本号取 npm dist-tag：稳定版发 `latest`；
pre-release 发到与其 pre-release 标识符同名的 dist-tag（`0.9.0-alpha.1` →
`alpha`、`0.9.0-rc.1` → `rc`）。pre-release 不占据 `latest`。

**支持窗口 / EOL。** 一条 DSH 线仅在声明的窗口内受支持。默认窗口到下一
DSH 线作为 `latest` 发布为止；此后该线 EOL、冻结、不再发补丁。

**Bug 修复流程（先向前修，再回迁）。** 跨多条支持线的修复，先在 `main` 上
修复，再回迁到各仍受支持的 release 分支。仅特定线的修复，只在对应线修复。
