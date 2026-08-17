# dsh-rewind

DeepSeek Harness 插件：**同一会话窗口的 in-place 对话回退**（Claude Code `/rewind` 语义）。主交互为**用户消息旁的「回退」按钮**，点击后选择回退模式；命令仅作辅助。

> 状态：v0.2.0 已实现（`dsh-rewind-plugin`，npm + GitHub Actions Trusted Publishing）。交互以 Claude Code 行为为参考，并贴合 dsh Web 实际 UI（利用现有 DOM 锚点与运行时快照，纯插件、不改仓库核心）。

## 实现状态（v0.2.0）

- ✅ host 端 `/rewind` 命令（参数化形式作为 ↶ 按钮的内部调用通道；手动输入由 client 拦截）
- ✅ **Claude Code 式 checkpoint 文件回退**：`tools/execute` 捕获写前备份、`tools/post-execute` 按消息分组**落盘**提交（`~/.dsh/rewind-snapshots`），重启后仍可还原
- ✅ **与其他审批类插件共存**：捕获在 around-dispatch 阶段，`tools/pre-execute` 被 `ask` 短路（如 dsh-edit-approval）后批准仍能记录；被拒绝的调用不留 pending 残留
- ✅ **路径按会话 cwd 解析**（复刻 `dsh-tool-fs` 的 session-cwd 规则），相对路径备份/还原指向真实文件；记录解析后的 display path
- ✅ **fs 服务动态获取**（`ctx.inject(['fs'])`）：fs 后挂载也不失效，无 fs 部署时命令仍可用
- ✅ 同窗口 in-place 回退：追加空内容标记 + `surfaceOp: replace` 替换目标及之后全部 surface（真实 `dsh-session` 集成测试通过）
- ✅ **还原走 `node:fs` 直写**（不经 fs 服务）：文件内容真正落盘；符号/硬链接跳过并警告
- ✅ client 端「回退」按钮（MutationObserver 注入用户消息行操作区）+ 模式选择浮层（含 both 模式影响清单确认）+ 手动 `/rewind` 输入拦截
- ✅ 测试：纯函数单测 + 真实 `dsh-session` 集成测试 + `verify-host` 端到端（18 项，含审批短路/会话 cwd/新建文件删除/重启持久化场景）
- ⏳ 二期：快捷键（输入框为空时 esc+esc 打开回退菜单，对齐 Claude Code）
- ❌ 明确不做：整树快照（覆盖 bash/外部修改）——Claude Code 原生同样不覆盖（官方把这类回退交给用户 git），本插件保持一致

## 安装

> 发布名：**`dsh-rewind-plugin`**（npm 上的 `dsh-rewind` 已被功能重叠的既有包占用）。
> 本地 / GitHub 路径不受影响（仓库仍为 `SiriLee/dsh-rewind`）。

```sh
# 本地 checkout
dsh plugin --profile web add /home/slev/workspace/projects/dsh-rewind

# 或 GitHub（git 安装会运行 prepare 构建；需按提示在 profile 的
# pnpm-workspace.yaml 中 allowBuilds 授权）
dsh plugin --profile web add github:SiriLee/dsh-rewind#<commit-sha>

# 或 npm 发布后（预构建产物，无需授权）
dsh plugin --profile web add dsh-rewind-plugin
```

`cordis.patch.yml` 插入一行 `dsh-rewind-plugin`（node 半面 = host 插件；行名必须
等于包名）；包声明 `dsh.bundle` + `dsh.client`，浏览器半面由
`dsh-client-modules` 从 `exports["./client"]` 解析并注入 web roster。

## 发布（维护者，CI + Trusted Publishing）

已发布版本：`0.1.0`（本地 2FA 首发）→ `0.2.0`（`0.1.1` 起走 CI OIDC +
Sigstore provenance）。
后续发版走 CI：

```sh
npm version patch    # 或 minor / major；同步更新 README 版本说明
git push --tags      # push v<version> tag → 触发 .github/workflows/publish.yml
```

- workflow：`v*` tag 或手动 `workflow_dispatch` 触发；`id-token: write` 让 npm
  registry 校验 GitHub OIDC token 后授权发布（Node 24 自带 npm ≥11.5.1，
  OIDC 必需）；自动生成 SLSA provenance；版本已发布则幂等跳过；tag 自动建
  GitHub Release。
- **一次性 npm 侧配置**（仓库内无法代做；配置**不需要包先存在**，发布后
  `npmjs.com/package/dsh-rewind-plugin` 才会出现）：
  1. 打开 [dsh-rewind-plugin 包页](https://www.npmjs.com/package/dsh-rewind-plugin)
     → 右上角 **settings** → **Trusted Publisher** → **Add**；
  2. 字段：Provider **GitHub Actions** · Organization or user **`SiriLee`** ·
     Repository **`dsh-rewind`**（GitHub 仓库名，与 npm 包名可不同）·
     Workflow filename **`publish.yml`**（只填文件名）· Environment **留空**
     （本 workflow 无 `environment` 块，OIDC subject 携带 ref，此为已验证组合）·
     **Allowed actions：`npm publish`**（2026-05-20 起必选）。
- 质量门禁（PR / push main）：`.github/workflows/ci.yml` 跑 typecheck + 测试
  + 构建 + `verify-host` + tarball 完整性检查（`lib/` 与 `LICENSE` 必须在包内）。
- 包内附带 `.d.ts` 类型声明（`exports` 已声明 `types`，可直接导入包的类型，无需源码级路径）。

## 使用

- 每条用户消息 hover 出现「↶ 回退」按钮：点击 → 选择「仅回退对话」或
  「回退对话和代码」（后者先展示影响清单再确认）。
- **回退 = 撤回（时间回溯）**：对**任意**用户消息回退（使用消息旁的 ↶ 按钮），
  效果是**撤回该消息及它之后的所有内容**（含 agent 回复、工具调用）——对话界面与
  Agent 上下文都回到这条消息发送之前；**该消息的文本自动填入输入框（编辑区）**，
  可直接修改后重发。命令结果提示"已撤回 seq N 及之后内容"。
- **手动 `/rewind` 不支持**：在输入框手动输入 `/rewind`（含裸命令）会被 client 拦截并
  提示改用按钮——`/rewind` 命令仅作为按钮的内部调用通道存在。
- **回退后前端与 Agent 一致**：回退标记是空内容消息（deriveMessages 会跳过，模型
  上下文无任何标记噪音）；client 端隐藏被撤回范围内的消息行与 `/rewind` 命令结果，
  可见对话即"撤回点之前的内容"。会话日志（append-only 审计）不受影响。

## 已知限制（v0.2）

- checkpoint 只覆盖**插件运行期间、经 `write` / `edit` / `str_replace_editor` 的变更**；
  bash 或外部程序的修改无法还原（与 Claude Code 相同的限制，官方同样不覆盖，此类回退
  交由用户 git 处理）。备份按消息分组**落盘**（每会话保留最近 100 组，最旧先清理），dsh
  重启不丢失。
  写前备份读取失败时（如权限错误）该次变更不会入备份，`both` 回退无法还原它——插件会在
  日志中警告，但不会阻塞写操作本身。
- 文件删除/还原走真实路径直删直写（本地 backend）；sandbox/远程 backend 下路径解析
  可能受限。符号链接与硬链接不写入（与 Claude Code 一致，恢复时跳过并在结果中提示）。
- 回退本身可再回退（标记进入日志），但文件还原动作不再记录新备份。
- 回退按钮只出现在**当前会话**渲染的用户消息行上（DOM 注入范围即当前视图）；
  subagent/分屏等非当前会话的对话需要先切到该会话再回退。
- 目标消息之后没有跟踪的文件变更时，模式浮层不显示「回退对话和代码」（与 Claude Code
  隐藏 code-restore 选项的行为一致），仅提供「仅回退对话」。

## 背景与定位

社区 rewind 类插件（`dsh-recall-plugin`、`dsh-checkpoint-rewind`、`dsh-turn-rewind`）均为 **fork 路线**（回退 = fork 出新会话，用户切换会话继续），且没有「仅回退对话 / 对话+代码」的选项。本插件提供：**在当前会话窗口内**改写模型上下文 + 可选还原工作区文件。

## 交互设计（按钮两步；手动命令不支持）

按钮流程遵循两步：**第一步选择要回退到的 user 消息，第二步选择回退模式**。手动
`/rewind` 命令不支持输入——client 端在输入框拦截所有手动 `/rewind` 并提示改用按钮。

### 1. 用户消息旁的「回退」按钮（主入口）

- 在你**发送过的每条用户消息**下方/旁边显示「↶ 回退」按钮（hover 出现，与现有 clock/copy 操作并排）。
- **第一步（目标即已确定）**：点击某条消息旁的按钮，回退目标就是这条消息——无需再选。
- **第二步（模式选择浮层）**：弹出小型浮层（非新页面），选项：
  - **仅回退对话** —— 只回退模型上下文，不动工作区文件
  - **回退对话和代码** —— 对话回退 + 工作区文件还原到该消息之前
  - **取消**
- 选「回退对话和代码」时，浮层内先显示将受影响的内容清单（将还原/删除的文件名与数量），确认后执行。
- 执行结果以一条对话内消息呈现（如「已回退到 seq N，移除 M 条上下文；还原 2 个文件」）。

### 2. 命令（仅作按钮内部通道，不支持手动输入）

- **手动输入 `/rewind`（含裸命令）会被 client 端在输入框直接拦截**，并提示改用消息旁
  的 ↶ 按钮。`/rewind` 命令仅作为按钮的内部调用通道存在
  （`/rewind @seq chat|both`、`/rewind preview @seq both`）。
- UI 按钮与命令共享同一套 host 端回退逻辑（`/rewind @seq <mode>`）。

## 回退机制（host 端，全部公开 API）

### 3. 同窗口 in-place 对话回退

- `Session.append('assistant/message', { turn, step, message: 空标记 }, { surfaceOp: { op:'replace', start, end }, sourceEventSeqs })`：追加**空内容**标记（deriveMessages 跳过 → 模型上下文无噪音），把目标及其之后的所有 surface 节点从模型上下文替换掉。
- 效果：当前窗口上下文从目标点重新开始；**不产生新会话、不切换窗口**；原始日志完整保留（append-only 审计不变），仅不再进入模型上下文。
- 依赖：`@deepseek-ai/dsh-session`（`Session.append`、`foldSurface`）、`@deepseek-ai/dsh-llm`（`createUserMessage`）、`@deepseek-ai/dsh-commands`（命令注册）、`@deepseek-ai/dsh-agent`（`Agent.status` idle 守卫）。

### 4. 文件回退：Claude Code 式 checkpoint（写前备份，按消息分组落盘）

- 在 `tools/execute`（around-dispatch 阶段）读取目标文件**写前备份**（before；文件不存在记
  为「新建」），`tools/post-execute` 将备份按**当前轮用户消息 seq（锚点）**落盘提交到
  `~/.dsh/rewind-snapshots/<会话>/<锚点 seq>/`。捕获放在 execute 而非 pre-execute：
  **审批类插件（如 dsh-edit-approval）在 `tools/pre-execute` 返回 `ask` 会短路后续监听器**，
  但批准后 dispatch 阶段必然执行——共存的写操作照样入备份；被拒绝的调用不 dispatch，
  不会留下残留。
- 相对路径按**会话 cwd** 解析（与 `dsh-tool-fs` 同规则，`src/session-cwd.ts`），
  备份记录解析后的 display path，preview/还原始终指向真实文件。
- 回退「对话和代码」到消息 N 时：对锚点 ≥ N 的每条备份取**该文件最早一条**——内容写回
  before、新建文件删除（与 Claude Code 的 rewind 语义一致）。恢复用 `node:fs` 直写真实
  文件，不经过 fs 服务；符号/硬链接跳过并在结果中提示。
- 持久化：备份在磁盘上，**dsh 重启后仍可还原**；每会话保留最近 100 个消息分组，最旧先清理。
- 边界（已知限制）：只覆盖**插件运行期间、经写类工具**的变更；bash 命令或外部程序的修改
  不在备份内，无法还原（与 Claude Code 相同的限制，官方同样不覆盖，此类回退交由用户 git
  处理）。

### 5. 安全守卫

- agent 运行中（LLM 思考/输出）执行回退时**自动强制停止**当前回合（`cancel({kind:'user'})`），
  等待 quiescence 后回退；停止超时/失败则中止并报错。无需先手动停止。
- 文件还原是破坏性操作：UI 选择「对话和代码」时需经影响清单确认；命令路径用 `preview` 先行查看。
- 回退本身可再回退（回退动作同样进入会话日志），但文件还原动作不再记录新备份。

## 客户端实现要点（纯插件，无源码补丁）

- 按钮注入锚点：用户行 `[data-chat-flow-kind="user"]`（行容器 `data-chat-anchor-key` 为节点 key）；用 MutationObserver 跟踪新增行。
- 消息 seq 获取：从行元素的 `data-chat-anchor-key` → 运行时快照 `session.getSnapshot().chat.nodes.get(key)` → `UserMessageNode.seq`（DOM 只用于定位，数据取自 runtime，不解析 DOM 文本）。
- **按钮两步选择浮层**：点击消息旁按钮时，客户端接管交互——目标即该消息，第二步展示模式选项（仅回退对话 / 回退对话和代码 / 取消；目标之后无文件变更时只显示「仅回退对话」，与 Claude Code 隐藏 code-restore 选项一致）；确认后调 `session.command('/rewind @<seq> <mode>')` 执行。**手动 `/rewind` 被 client 整体拦截**（含裸命令）：输入框 guard 阻止提交并提示改用按钮；`/rewind` 命令仅作为按钮内部调用通道存在。
- 执行结果以命令节点出现在对话中。
- 注入按钮与「在新对话中分支」等官方操作并排，样式遵循 dsh 设计 token。

## 明确不包含（本期）

- 快捷键（esc+esc 回退等）——独立的快捷键插件，二期。
- 压缩（`/compact`）——官方已有。
- fork/分支回退——官方已有（「在新对话中分支」）。
- 快照式文件回退（整树/git-first，覆盖 bash 与外部修改）——**明确不做**（与 Claude Code
  一致：官方原生同样不覆盖，把这类回退交给用户 git；见「已知限制」）。

## 目录结构（实际）

```
src/index.ts           host 插件：/rewind 命令 + tools/execute|post-execute checkpoint（fs 动态注入）
src/rewind.ts          planRewind 纯函数（目标解析、surface 范围计算、候选列表）
src/snapshot.ts        checkpoint 存储（写前备份按消息分组落盘、还原/删除/影响清单、有界清理）
src/session-cwd.ts     会话 cwd 解析（复刻 dsh-tool-fs 规则，可单测）
src/client/index.ts    client 插件：消息行「回退」按钮 + 模式选择浮层
src/client/popover.ts  浮层 DOM（含 both 模式影响清单确认）
src/client/locales.ts  zh/en 文案（LocaleNamespaceMap 合并）
src/client/styles.ts   注入样式（dsh 设计 token）
scripts/build.mjs      esbuild 构建：lib/index.js（host ESM）+ lib/client.js（loader 闭包）
scripts/verify-host.mjs  端到端验证（真实 cordis + dsh-session + 真实临时文件，18 项断言）
tests/                 rewind/snapshot 单测 + 真实 dsh-session 集成测试
cordis.patch.yml       bundle patch（插入 dsh-rewind-plugin 一行，双面）
package.json           dsh.bundle + dsh.client 声明、optional peerDependencies
```

## 参考：deepseek-harness 接口文档

本地 fork：`../../oss/deepseek-harness/` · 官方仓库：[github.com/deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)

### 子系统文档（`docs/subsystems/`）

- [session.md](../../oss/deepseek-harness/docs/subsystems/session.md) — `Session` / `SessionStore` / 事件模型（`Session.append`、`surfaceOp`、`sourceEventSeqs`）
- [core.md](../../oss/deepseek-harness/docs/subsystems/core.md) — `Agent`（`status`、`session`）等核心类型
- [commands.md](../../oss/deepseek-harness/docs/subsystems/commands.md) — 命令注册（`ctx.commands.register`、`CommandInvocation`、`CommandResult`）
- [tools.md](../../oss/deepseek-harness/docs/subsystems/tools.md) — 工具执行 seam（`tools/pre-execute` / `tools/post-execute`、`ToolExecution`）
- [session-query.md](../../oss/deepseek-harness/docs/subsystems/session-query.md) — 会话查询/`foldSurface` 相关只读接口
- 根目录目录：`docs/persistence-catalog.md`（`SessionEventMap` 全量事件）、`docs/tool-catalog.md`（工具清单）、`docs/config-catalog.md`（配置清单）

### 关键源码（`packages/`）

| 接口 | 文件 |
|---|---|
| `Session.append`、surface 校验 | [packages/core/session/src/index.ts](../../oss/deepseek-harness/packages/core/session/src/index.ts) |
| `foldSurface`、替换规则 | [packages/core/session/src/surface.ts](../../oss/deepseek-harness/packages/core/session/src/surface.ts) |
| `SessionEventMap`、`SurfaceOp` | [packages/core/session/src/types.ts](../../oss/deepseek-harness/packages/core/session/src/types.ts) |
| `createUserMessage`、`MessageSource` | [packages/llm/llm/src/message.ts](../../oss/deepseek-harness/packages/llm/llm/src/message.ts) |
| `CommandDefinition`、`CommandInvocation` | [packages/interaction/commands/src/index.ts](../../oss/deepseek-harness/packages/interaction/commands/src/index.ts) |
| `Agent`（`status`/`session`） | [packages/core/agent/src/runtime-types.ts](../../oss/deepseek-harness/packages/core/agent/src/runtime-types.ts) |
| `tools/pre-execute` / `execute` / `post-execute` | [packages/core/tools/src/index.ts](../../oss/deepseek-harness/packages/core/tools/src/index.ts) |
| 客户端 DOM 锚点（`data-chat-flow-kind`/`data-chat-anchor-key`） | [packages/client/ui-conversation/src/client/chat/ChatNodeSeat.tsx](../../oss/deepseek-harness/packages/client/ui-conversation/src/client/chat/ChatNodeSeat.tsx) |
| 用户气泡渲染 | [packages/client/ui-conversation/src/client/chat/MessageItem.tsx](../../oss/deepseek-harness/packages/client/ui-conversation/src/client/chat/MessageItem.tsx) |
| 客户端 `SessionFace`（`command`/`cancel`） | [packages/client/runtime/src/client/contract/session.ts](../../oss/deepseek-harness/packages/client/runtime/src/client/contract/session.ts) |
| 客户端 `PendingWait`（`respond`） | [packages/client/runtime/src/client/sessions/pending.ts](../../oss/deepseek-harness/packages/client/runtime/src/client/sessions/pending.ts) |
