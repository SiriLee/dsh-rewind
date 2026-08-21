# dsh-rewind

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：**同一会话窗口的 in-place 对话回退**（Claude Code `/rewind` 语义）——把模型上下文剪回更早的一条用户消息，并可基于**落盘的写前备份**还原工作区文件。

[![npm version](https://img.shields.io/npm/v/dsh-rewind-plugin.svg)](https://www.npmjs.com/package/dsh-rewind-plugin)
[![npm license](https://img.shields.io/npm/l/dsh-rewind-plugin.svg)](https://github.com/SiriLee/dsh-rewind/blob/main/LICENSE)

> [English](README.md) | 中文

刻意保持聚焦，只做一件事：**就地回退到任意更早的用户消息**。

| 模式 | 对话 | 工作区文件 |
| --- | --- | --- |
| **仅回退对话** | 剪回目标消息之前 | 不动 |
| **回退对话和代码** | 剪回目标消息之前 | 还原到目标之前的 state（改过的文件写回、之后新建的文件删除） |

回退即**时间回溯**：目标消息及其之后全部内容（agent 回复、工具调用）从模型上下文**与**渲染对话中撤回——不新建会话、不切换窗口——目标消息的文本会回填输入框，可修改后重发。

插件从不改写 append-only 会话日志，从不触碰你的 git 仓库。

## 效果预览

每条用户消息的操作行上多出一个 **↶ 回退** 按钮。点击后弹出模式选择浮层；「回退对话和代码」会先展示待还原/删除的文件清单再确认（目标之后无跟踪变更时不显示该选项，对齐 Claude Code 的 code-restore 可见性）。

<table>
  <tr>
    <td align="center"><img src="assets/screenshots/rewind-button.png" width="440" alt="用户消息旁的 ↶ 回退按钮"><br><sub>用户消息旁的 ↶ 回退按钮</sub></td>
    <td align="center"><img src="assets/screenshots/mode-popover.png" width="440" alt="模式选择浮层"><br><sub>模式选择浮层</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="assets/screenshots/impact-list.png" width="440" alt="影响清单"><br><sub>「回退对话和代码」影响清单</sub></td>
    <td align="center"><img src="assets/screenshots/rewind-candidates.png" width="440" alt="/rewind 候选面板"><br><sub>/rewind 候选面板</sub></td>
  </tr>
</table>

## 安装

```sh
dsh plugin --profile web add dsh-rewind-plugin
```

装完重启 `dsh web`（`--profile web`）。

> ⚠️ npm 上的 `dsh-rewind` 属于其他作者，请用 `dsh-rewind-plugin` 安装。

给贡献者：可从本地 checkout 或 pin 的 commit 安装——`dsh plugin --profile web add /path/to/dsh-rewind` 或 `dsh plugin --profile web add github:SiriLee/dsh-rewind#<sha>`。git 安装首次会失败：pnpm 默认禁止 git 依赖执行构建脚本，需先在 profile 的 `pnpm-workspace.yaml` 加 `allowBuilds`；之后 pnpm 会执行插件的 `prepare`（完整构建）并装入 profile。

## 使用

1. **hover** 任意你发送过的用户消息——操作行出现 **↶ 回退** 按钮。
2. **点击它。** 目标即这条消息；小浮层提供两种模式（目标之后没有跟踪的变更时，「回退对话和代码」不显示）。
3. 回退以一条会话内命令执行；结果消息确认，被撤回消息的文本自动填入输入框，可编辑后重发。

**命令行入口**：输入裸 `/rewind` 回车打开候选面板，选择目标后流程与按钮一致。

回退可重复进行（每次追加一条标记到日志）。回退无法通过插件撤销，但可以手动编辑会话日志恢复。文件还原动作不再记录新备份。

## 原理

### 1. 对话回退（同窗口就地）

插件向会话日志追加一条**空内容标记** `assistant/message`，其 `surfaceOp: { op: 'replace', start, end }` 把目标消息之后的全部 surface 节点替换为标记本身：

- 标记携带 `sourceEventSeqs` 覆盖所有被遮蔽节点，`Session.append` 的 surface 规则校验切割合法性（仅限当前 surface 上的连续区间）。
- 因为标记**内容为空**，harness 会将其派生为 `null`——永不进入模型上下文、也永不渲染成对话内容。agent 与用户看到的对话都回到目标消息当时的样子。
- 标记的 **turn 号复用最后一个已开始的回合**（`markerTurnOf`），而不是「最后回合 + 1」：harness 恰好用 `最后 turn/start + 1` 编号下一条真实回合。若标记也取这个数，日志里就会出现同一 turn 的 `assistant/message` 先于 `turn/start` 的乱序，客户端 conversation 构建器会以 `conversation Context …:turn-tail… received an update before its start Match` 拒绝重放——历史加载失败、整个对话从界面消失。复用已消费的 turn 号则标记只是上一个已完成回合尾部的一次无害追加，永不与新回合冲突。
- append-only 日志**不被改写**——审计轨迹完整保留每条被撤回的事件，只有模型可见的 surface 被剪掉，下一条请求从目标消息起派生上下文。

若 agent 正在运行（LLM 思考/流式输出），会先强制停止（`cancel({ kind: 'user' })`）并等待 quiescence 再回退；停不下来则中止并报错。

### 2. Checkpoint 文件还原

插件跟踪写类工具：`write`、`edit`、`str_replace_editor`（变更子命令 `create` / `str_replace` / `insert`）：

1. **写前备份**（`tools/execute`，around-dispatch 阶段）：读取目标文件，把解析后的路径与内容放入 pending 表。此阶段只在任何 pre-execute 审批门放行之后运行——审批 `ask` 短路（dsh-edit-approval）**无法跳过**备份，被拒绝的调用也不会记录。若读取失败（如权限错误），该次变更直接不入备份——插件只在日志中警告，**不会阻塞写操作**。
2. **落盘提交**（`tools/post-execute`）：备份按当前轮**锚点消息 seq** 写入 `~/.dsh/rewind-snapshots/<会话>/<锚点 seq>/<callId>.json`。
3. **还原**（`/rewind @<seq> both`）：锚点 ≥ 目标的每条备份生效——被修改的文件写回其**最早一次**捕获的 before 内容，目标之后新建的文件被删除，符号/硬链接跳过（它们与另一名字共享 inode，透过一个还原会误伤两个）。写入走纯 `node:fs`，不经 fs 服务——sandbox / 远程 backend 下路径解析可能受限。
4. 工具体**抛异常**会跳过 `tools/post-execute`；`tools/result` 兜底清掉 pending，避免内存泄漏。

备份跨 host 重启持久化，每会话有界保留最近 100 组锚点。

## 明确不做的事

- **整树 / git-first 快照**——只备份写类工具编辑。`bash`、其他工具与外部程序的修改不在备份内、无法还原：与 Claude Code 相同，官方同样不覆盖，此类回退交由用户 git 处理。
- **子代理（subagent）的编辑**——不跟踪（同 Claude Code）：子代理运行在自己的会话里，其备份无法被父会话的回退还原。
- **fork / 分支回退与 `/compact`**——harness 已内置（「在新对话中分支」、compact）。
- **快捷键**（esc+esc 打开回退菜单）——规划中的后续项。

## 与同类项目对比

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 还有 [Anionex/dsh-turn-rewind](https://github.com/Anionex/dsh-turn-rewind)——同样是回退插件，用户面想法相同（每条消息下挂一个动作，回退对话并还原工作区文件），但路线不同：

| 维度 | dsh-rewind（本项目） | Anionex dsh-turn-rewind |
| --- | --- | --- |
| 对话回退 | **同窗口就地**——把模型可见 surface 剪回目标；append-only 日志原封不动 | 在上一 `turn/end` 处**派生新 Session**；原会话永远保留 |
| 文件还原引擎 | **轻量写前备份**，只跟踪写类工具，纯 `node:fs` 还原 | **Change Ledger**——持久化还原点引擎，带 Git 围栏、审批门、救援点与崩溃对账 |
| 跟踪范围 | 仅写类工具编辑（同 Claude Code） | 任意 Git 管理文件（要求 Git worktree） |
| 公共服务 API | 无——聚焦单用途插件 | 有——`ctx.changeLedger` 服务 + `/turn-rewind` HTTP 端点 |

本质区别：dsh-turn-rewind 因保持日志不可变而必须派生新会话；本插件用空标记**就地剪掉**模型可见 surface，于是原对话在同一个窗口继续——这段并不平凡的实现（见[已知问题](#已知问题)）正是 dsh-turn-rewind 绕开的部分。

## 兼容性

- Node.js `^22.19.0 || >=24.0.0`。
- DeepSeek Harness web 配置档（`dsh --profile web`）；peer `@deepseek-ai/*` 包由 harness 运行时解析。

> [!WARNING]
> 本项目与 DeepSeek Harness 均处于开发者预览阶段。可复现环境请 pin 精确版本，
> 并阅读上述行为说明。

## 已知问题

`v0.2.4` 及之前版本创建的回退在随后继续对话时可能损坏客户端重放（标记 turn 与下一个 `turn/start` 撞号）。离线修复工具**已随 npm 包内置**（`dsh-rewind-repair`）。只影响升级前就已存在的旧会话——全新安装永不触发。

完整步骤见：[docs/troubleshooting.zh.md](docs/troubleshooting.zh.md)

## 安全

本插件只向会话日志追加回退标记事件，从不删除或改写已记录的历史。文件写入仅在你选择「回退对话和代码」时发生，备份与还原都限定在 `~/.dsh/rewind-snapshots/` 内。不触碰你的 git 仓库，无网络请求，不访问任何凭据。

> **注意：** 回退只是把消息从视图中隐藏——导出的会话日志（`/export`）仍包含撤回前的内容，本插件无法改动导出。要彻底删除对话，请删除对应的会话文件。

## 开发

```sh
npm install            # devDeps 来自 npm registry
npm run typecheck      # tsc 双面编译（host + client）
npm test               # vitest：rewind / snapshot / hidden / session-cwd / 集成
npm run build          # esbuild：lib/index.js（host ESM）+ lib/client.js（loader 闭包）+ .d.ts
node scripts/verify-host.mjs   # 端到端验证构建产物（18 项检查）
```

`prepare` 执行完整构建，所以 git 安装与 `npm pack` / `npm publish` 总会产出完整的 `lib/` 与 `LICENSE`。

维护者：模块地图与 harness 接口参考见 [docs/harness-reference.md](docs/harness-reference.md)；发布步骤见 [docs/release.md](docs/release.md)。

## 发布

通过 GitHub Actions Trusted Publishing（OIDC，无存储 `NPM_TOKEN`）发布：推送 `v<版本>` tag，CI 即带 Sigstore provenance 发布。

```sh
npm version patch && git push origin main --tags
```

一次性 npm 侧配置与完整流程：见 [docs/release.md](docs/release.md)。

## 许可

[MIT](LICENSE)
