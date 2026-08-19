# dsh-rewind

[English](README.md)

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：**同一会话窗口的 in-place 对话回退**（Claude Code `/rewind` 语义）——把模型上下文剪回更早的一条用户消息，并可基于**落盘的写前备份**还原工作区文件。

> **状态**：已发布 npm（`dsh-rewind-plugin`，v0.2.3），经 GitHub Actions Trusted Publishing + Sigstore provenance 构建发布。目标为 web 配置档（`dsh --profile web`）。交互以 Claude Code 的 rewind 为参考，并贴合 dsh Web 实际 UI。

[![npm version](https://img.shields.io/npm/v/dsh-rewind-plugin.svg)](https://www.npmjs.com/package/dsh-rewind-plugin)
[![npm license](https://img.shields.io/npm/l/dsh-rewind-plugin.svg)](https://github.com/SiriLee/dsh-rewind/blob/main/LICENSE)

## 目录

- [✨ 功能特性](#-功能特性)
- [📸 截图](#-截图)
- [工作原理](#工作原理)
- [📦 安装](#-安装)
- [使用](#使用)
- [行为细节与限制](#行为细节与限制)
- [明确不包含](#明确不包含)
- [兼容性](#兼容性)
- [开发](#开发)
- [发布](#发布)
- [目录结构](#目录结构)
- [License](#license)

## ✨ 功能特性

| 特性 | 说明 |
| --- | --- |
| 同窗口原地回退 | 在**任意**用户消息旁点 ↶ 按钮：该消息及之后全部内容（agent 回复、工具调用）从模型上下文**与**渲染对话中撤回——不新建会话、不切换窗口 |
| 时间回溯语义 | 回退到某消息会**连同撤回该消息本身**；其文本自动填入输入框，可修改后重发 |
| Claude Code 式文件还原 | 写类编辑在执行**前**被备份并落盘；「回退对话和代码」把文件还原到编辑前内容、删除目标之后新建的文件 |
| 影响清单确认 | 「回退对话和代码」先展示要还原/删除的文件清单再确认（目标之后无跟踪变更时不显示该选项，对齐 Claude Code 的 code-restore 可见性） |
| 与审批类插件共存 | 捕获在 `tools/execute`（around-dispatch 阶段）：其他插件的 pre-execute 审批短路（如 dsh-edit-approval）无法跳过备份，被拒绝的调用也不会记录 |
| 路径按会话 cwd 解析 | 相对路径按 fs-tools 的 session-cwd 规则解析到**真实文件**，记录解析后的 display path |
| 还原直写真实文件 | 还原走纯 `node:fs` 直接落盘；符号链接与硬链接跳过并警告（不通过共享 inode 误伤） |
| 重启后仍可还原 | 备份落在磁盘 `~/.dsh/rewind-snapshots/<会话>/<锚点 seq>/`，每会话保留最近 100 组 |
| 本地化 | `zh` / `en` 文案，注册进 dsh 的 locale 体系 |

## 📸 截图

<table>
  <tr>
    <td align="center"><img src="assets/screenshots/rewind-button.png" width="440" alt="用户消息旁的 ↶ 回退按钮"><br><sub>用户消息旁的 ↶ 回退按钮</sub></td>
    <td align="center"><img src="assets/screenshots/mode-popover.png" width="440" alt="模式选择浮层"><br><sub>模式选择浮层</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="assets/screenshots/impact-list.png" width="440" alt="影响清单"><br><sub>「回退对话和代码」影响清单</sub></td>
    <td align="center"><img src="assets/screenshots/guard-hint.png" width="440" alt="手动 /rewind 拦截提示"><br><sub>手动 /rewind 拦截提示</sub></td>
  </tr>
</table>

## 工作原理

两部分协同：**对话回退**（同窗口 in-place）与 **checkpoint 文件还原**（Claude Code 式写前备份）。

### 1. 对话回退

插件向会话日志追加一条**空内容标记** `assistant/message`，其 `surfaceOp: { op: 'replace', start, end }` 把目标消息之后的全部 surface 节点替换为标记本身：

- 标记携带 `sourceEventSeqs` 覆盖所有被遮蔽节点，`Session.append` 的 surface 规则校验切割合法性（仅限当前 surface 上的连续区间）。
- 因为标记**内容为空**，harness 会将其派生为 `null`——永不进入模型上下文、也永不渲染成对话内容。agent 与用户看到的对话都回到目标消息当时的样子。
- append-only 日志**不被改写**——审计轨迹完整保留每条被撤回的事件，只有模型可见的 surface 被剪掉，下一条请求从目标消息起派生上下文。

若 agent 正在运行（LLM 思考/流式输出），会先强制停止（`cancel({ kind: 'user' })`）并等待 quiescence 再回退；停不下来则中止并报错。

### 2. Checkpoint 文件还原

插件跟踪写类工具：`write`、`edit`、`str_replace_editor`（变更子命令 `create` / `str_replace` / `insert`）：

1. **写前备份**（`tools/execute`，around-dispatch 阶段）：读取目标文件，把解析后的路径与内容放入 pending 表。此阶段只在任何 pre-execute 审批门放行之后运行——所以审批 `ask` 短路（dsh-edit-approval）**无法跳过**备份，被拒绝的调用也不会记录。
2. **落盘提交**（`tools/post-execute`）：备份按当前轮**锚点消息 seq** 写入 `~/.dsh/rewind-snapshots/<会话>/<锚点 seq>/<callId>.json`。
3. **还原**（`/rewind @<seq> both`）：锚点 ≥ 目标的每条备份生效——被修改的文件写回其**最早一次**捕获的 before 内容，目标之后新建的文件被删除，符号/硬链接跳过。写入走纯 `node:fs`，不经 fs 服务。
4. 工具体**抛异常**会跳过 `tools/post-execute`；`tools/result` 兜底清掉 pending，避免内存泄漏。

备份跨 host 重启持久化，每会话有界保留最近 100 组锚点。

## 📦 安装

已发布 npm——推荐走 registry 路径。**装完重启 dsh web（`--profile web`）。**

> ⚠️ 注意：npm 上的 `dsh-rewind` 属于其他作者，请用 `dsh-rewind-plugin` 安装。

### 方式 A：registry（推荐）

```sh
dsh plugin --profile web add dsh-rewind-plugin
```

### 方式 B：本地 checkout（作者 / 贡献者）

```sh
cd dsh-rewind
npm install      # devDeps 来自 npm registry，无需 harness checkout
npm run build    # 完整构建：lib/（host ESM + client bundle + .d.ts）
dsh plugin --profile web add /path/to/dsh-rewind   # link 安装
```

### 方式 C：GitHub（pin commit，可复现）

```sh
dsh plugin --profile web add github:SiriLee/dsh-rewind#<commit-sha>
```

首次安装会失败：pnpm 默认禁止 git 依赖执行构建脚本。按 CLI 提示在 profile 的
`pnpm-workspace.yaml`（如 `$DSH_HOME/profiles/web/pnpm-workspace.yaml`）中加
`allowBuilds` 后重试；pnpm 随后会执行插件的 `prepare`（完整构建）并装入 profile。

## 使用

### 通过消息旁的按钮回退

1. **hover** 任意你发送过的用户消息——操作行出现 **↶ 回退** 按钮。
2. **点击它。** 目标即这条消息（第一步完成）。弹出小浮层（第二步）：
   - **仅回退对话** —— 把模型上下文剪回这条消息之前；工作区文件不动。
   - **回退对话和代码** —— 同样的上下文裁剪，并把工作区文件还原到该消息之前的状态。先显示影响清单（待还原/删除的文件），确认后执行。
   - 目标之后**没有**跟踪的文件变更时，该选项**不显示**（对齐 Claude Code 行为）。
3. 回退以一条会话内命令执行；结果消息确认（如「已撤回 seq N 及之后内容；还原 M 个文件」），被撤回消息的文本自动填入输入框，可编辑后重发。

### 回退 = 撤回（时间回溯）

回退到某消息会**撤回该消息及它之后的所有内容**——渲染对话与 agent 上下文都回到这条消息之前。命令结果会说明，且该消息文本会填回输入框供重发。

### 手动 `/rewind` 不支持

`/rewind` 命令仅作为按钮的内部调用通道存在。在输入框手动输入 `/rewind`（含裸命令）会被**拦截**——提交时弹出临时提示，指向消息旁的 ↶ 按钮。

## 行为细节与限制

- 只跟踪**插件运行期间、经写类工具**的变更（`write` / `edit` / `str_replace_editor`）。`bash`、其他工具或外部程序的修改不在备份内、无法还原——与 Claude Code 相同，官方同样不覆盖，此类回退交由用户 git 处理。
- 写前备份读取失败时（如权限错误）该次变更不会入备份，`both` 回退无法还原它——插件会在日志中警告，但**不会阻塞写操作**。
- 文件还原/删除直写**真实本地文件系统**；sandbox / 远程 backend 下路径解析可能受限。
- 符号链接与硬链接不写入（它们与另一名字共享 inode，还原会互相污染）——跳过并在结果中提示。
- 回退本身可再回退（标记进入日志），但文件还原动作不再记录新备份。
- ↶ 按钮只出现在**当前会话视图**渲染的用户消息行上；回退其他会话前先切换到该会话。
- 目标之后没有跟踪的文件变更时，模式浮层只显示「仅回退对话」（Claude Code 同样隐藏 code-restore 选项）。

## 明确不包含

- 快捷键（esc+esc 打开回退菜单）——规划中的后续项。
- `/compact` —— harness 已内置。
- fork / 分支回退 —— harness 内置的「在新对话中分支」。
- 整树 / git-first 快照（覆盖 bash 与外部修改）——**明确不做**，与 Claude Code 原生 rewind 保持一致（官方同样不覆盖，把此类回退交给用户 git）。

## 兼容性

- Node.js `^22.19.0 || >=24.0.0`。
- DeepSeek Harness web 配置档（`dsh --profile web`）；peer `@deepseek-ai/*` 包由 harness 运行时解析。

> [!WARNING]
> 本项目与 DeepSeek Harness 均处于开发者预览阶段。可复现环境请 pin 精确版本，
> 并阅读上述行为说明。

## 开发

```sh
npm install            # devDeps 来自 npm registry
npm run typecheck      # tsc 双面编译（host + client）
npm test               # vitest：rewind / snapshot / hidden / session-cwd / 集成（46 例）
npm run build          # esbuild：lib/index.js（host ESM）+ lib/client.js（loader 闭包）+ .d.ts
node scripts/verify-host.mjs   # 端到端验证构建产物（18 项检查）
```

`prepare` 执行完整构建，所以 git 安装与 `npm pack` / `npm publish` 总会产出完整的
`lib/` 与 `LICENSE`。

维护者参考：[docs/harness-reference.md](docs/harness-reference.md) 收录 DeepSeek
Harness 接口文档（子系统文档 + 关键源码索引）。

## 发布

通过 GitHub Actions Trusted Publishing（OIDC，无存储 `NPM_TOKEN`）发布：

```sh
npm version patch && git push origin main --tags   # 触发 .github/workflows/publish.yml
```

- workflow 校验 tag 与 `package.json` 版本一致，跑 typecheck + 测试 + 完整构建 +
  产物验证，以 `--provenance`（Sigstore）发布，并创建 GitHub Release。**幂等**——
  已发布的版本会跳过。CI（`.github/workflows/ci.yml`）在每次 push / PR 跑相同检查，
  外加 `npm pack --dry-run` 校验 tarball 含 `lib/` 与 `LICENSE`。
- 一次性 npm 侧配置（仓库内无法代做）：打开
  [dsh-rewind-plugin](https://www.npmjs.com/package/dsh-rewind-plugin) →
  **settings → Trusted Publisher → Add**，Provider **GitHub Actions** ·
  Organization or user **`SiriLee`** · Repository **`dsh-rewind`**（GitHub 仓库名，
  与 npm 包名可不同）· Workflow filename **`publish.yml`** · Environment
  **留空** · Allowed actions **`npm publish`**。配置好后 push `v<version>` tag
  即自动发布。

## 目录结构

```
src/index.ts            host 插件：/rewind 命令 + checkpoint 流水线（tools/execute|post-execute）
src/rewind.ts           纯函数规划：目标解析、surface 范围、候选列表
src/snapshot.ts         checkpoint 存储（磁盘写前备份、还原/preview、有界清理）
src/session-cwd.ts      session-cwd 解析（fs-tools 规则）
src/client/index.ts     client 插件：消息行 ↶ 按钮 + 手动 /rewind 拦截
src/client/popover.ts   模式选择浮层（both 模式影响清单确认）
src/client/hidden.ts    被撤回区间计算（hiddenSeqsOf），纯函数
src/client/locales.ts   zh / en 文案（LocaleNamespaceMap）
src/client/styles.ts    注入样式（dsh 设计 token）
scripts/build.mjs       esbuild：lib/index.js（host ESM）+ lib/client.js（loader 闭包）+ .d.ts
scripts/verify-host.mjs 端到端验证构建产物（18 项检查）
tests/                  vitest 套件（rewind / snapshot / hidden / session-cwd / 集成，46 例）
docs/harness-reference.md   维护者文档：DeepSeek Harness 接口参考
assets/screenshots/     界面截图
cordis.patch.yml        bundle patch（挂载双面插件行）
package.json            dsh.bundle + dsh.client 声明、optional peerDependencies
```

## License

[MIT](LICENSE)
