# dsh-rewind

DeepSeek Harness 插件：**同一会话窗口的 in-place 对话回退**（Claude Code `/rewind` 语义）。主交互为**用户消息旁的「回退」按钮**，点击后选择回退模式；命令仅作辅助。

> 状态：v0.1.0 已实现（host + client 双面插件）。交互以 Claude Code 行为为参考，并贴合 dsh Web 实际 UI（利用现有 DOM 锚点与运行时快照，纯插件、不改仓库核心）。

## 实现状态（v0.1.0）

- ✅ host 端 `/rewind` 命令（两步文本引导 + 直接执行 + `preview` 影响清单）
- ✅ host 端变更台账（`tools/execute` 捕获 before、`tools/post-execute` 提交），按会话隔离
- ✅ **与其他审批类插件共存**：捕获在 around-dispatch 阶段，`tools/pre-execute` 被 `ask` 短路（如 dsh-edit-approval）后批准仍能记录；被拒绝的调用不留 pending 残留
- ✅ **路径按会话 cwd 解析**（复刻 `dsh-tool-fs` 的 session-cwd 规则），相对路径台账/还原指向真实文件；台账记录解析后的 display path
- ✅ **fs 服务动态获取**（`ctx.inject(['fs'])`）：fs 后挂载也不失效，无 fs 部署时命令仍可用
- ✅ 同窗口 in-place 回退：追加标记节点 + `surfaceOp: replace` 替换目标点之后的 surface（真实 `dsh-session` 集成测试通过）
- ✅ client 端「回退」按钮（MutationObserver 注入用户消息行操作区）+ 模式选择浮层（含 both 模式影响清单确认）
- ✅ 测试：纯函数单测 + 真实 `dsh-session` 集成测试 + `verify-host` 端到端（14 项，含审批短路/会话 cwd 场景）
- ⏳ 二期：快捷键、git-first 快照式文件回退、命令路径的 client 两步浮层接管

## 安装

```sh
# 本地 checkout
dsh plugin --profile web add /home/slev/workspace/projects/dsh-rewind

# 或 GitHub（git 安装会运行 prepare 构建；需按提示在 profile 的
# pnpm-workspace.yaml 中 allowBuilds 授权）
dsh plugin --profile web add github:SiriLee/dsh-rewind
```

`cordis.patch.yml` 插入一行 `dsh-rewind`（node 半面 = host 插件）；包声明
`dsh.bundle` + `dsh.client`，浏览器半面由 `dsh-client-modules` 从
`exports["./client"]` 解析并注入 web roster。

## 使用

- 每条用户消息 hover 出现「↶ 回退」按钮：点击 → 选择「仅回退对话」或
  「回退对话和代码」（后者先展示影响清单再确认）。
- 键盘流：`/rewind` → 选消息 → `/rewind <序号> chat|both`；`/rewind preview <目标>`
  只输出影响清单不执行。
- 回退后：模型上下文从目标消息重新开始；会话日志与可见对话完整保留
  （append-only）；标记节点不渲染为气泡（非 append surface 事件），结果以命令节点呈现。

## 已知限制（v0.1）

- 台账只覆盖插件运行期间、经 `write` / `edit` / `str_replace_editor` 的变更；
  bash 或外部程序的修改无法还原（二期可加 git-first 快照层）。
- 文件删除走 `processPath` 直删（本地 backend）；sandbox/远程 backend 下还原
  可能受限。
- 回退本身可再回退（标记进入日志），但文件还原动作不再重新入台账。

## 背景与定位

社区 rewind 类插件（`dsh-recall-plugin`、`dsh-checkpoint-rewind`、`dsh-turn-rewind`）均为 **fork 路线**（回退 = fork 出新会话，用户切换会话继续），且没有「仅回退对话 / 对话+代码」的选项。本插件提供：**在当前会话窗口内**改写模型上下文 + 可选还原工作区文件。

## 交互设计（Claude Code 式两步：先选消息，再选模式）

所有入口（按钮、命令）都遵循同一流程：**第一步选择要回退到的 user 消息，第二步选择回退模式**。不会在一开始就要求指定模式。

### 1. 用户消息旁的「回退」按钮（主入口）

- 在你**发送过的每条用户消息**下方/旁边显示「↶ 回退」按钮（hover 出现，与现有 clock/copy 操作并排）。
- **第一步（目标即已确定）**：点击某条消息旁的按钮，回退目标就是这条消息——无需再选。
- **第二步（模式选择浮层）**：弹出小型浮层（非新页面），选项：
  - **仅回退对话** —— 只回退模型上下文，不动工作区文件
  - **回退对话和代码** —— 对话回退 + 工作区文件还原到该消息之前
  - **取消**
- 选「回退对话和代码」时，浮层内先显示将受影响的内容清单（将还原/删除的文件名与数量），确认后执行。
- 执行结果以一条对话内消息呈现（如「已回退到 seq N，移除 M 条上下文；还原 2 个文件」）。

### 2. 命令（辅助入口，面向键盘流与 headless；同样两步）

```
/rewind                   第一步：列出最近的 user 消息（序号 + 时间 + 内容预览），等待选择
/rewind <序号|@seq>        第二步：对选中的消息展示模式选项，等待选择
/rewind <序号|@seq> chat   执行：仅回退对话
/rewind <序号|@seq> both   执行：对话 + 代码
/rewind preview <目标>     只输出影响清单，不执行
```

- 分步示例：`/rewind` → 返回「1. 14:02 … / 2. 13:47 …」→ 输 `/rewind 1` → 返回「回退到消息 1：/rewind 1 chat 或 /rewind 1 both」→ 输 `/rewind 1 both` 执行。
- 若输入直接带全参数（`/rewind 1 both`），等价于跳过前两步直接执行——高级用法，不强制。
- UI 按钮与命令共享同一套 host 端回退逻辑（`/rewind @seq <mode>`）。

## 回退机制（host 端，全部公开 API）

### 3. 同窗口 in-place 对话回退

- `Session.append('user/message', marker, { surfaceOp: { op:'replace', start, end }, sourceEventSeqs })`：在当前会话日志内追加回退标记节点，把目标点之后的所有 surface 节点从模型上下文替换掉。
- 效果：当前窗口上下文从目标点重新开始；**不产生新会话、不切换窗口**；原始日志完整保留（append-only 审计不变），仅不再进入模型上下文。
- 依赖：`@deepseek-ai/dsh-session`（`Session.append`、`foldSurface`）、`@deepseek-ai/dsh-llm`（`createUserMessage`）、`@deepseek-ai/dsh-commands`（命令注册）、`@deepseek-ai/dsh-agent`（`Agent.status` idle 守卫）。

### 4. 文件回退：变更台账

- 在 `tools/execute`（around-dispatch 阶段）读取目标文件 before，`tools/post-execute` 记录
  `{ 消息锚点 seq, 文件路径(解析后), before, after }`。捕获放在 execute 而非
  pre-execute：**审批类插件（如 dsh-edit-approval）在 `tools/pre-execute` 返回 `ask`
  会短路后续监听器**，但批准后 dispatch 阶段必然执行——共存的写操作照样入台账；
  被拒绝的调用不 dispatch，不会留下 pending 残留。
- 相对路径按**会话 cwd** 解析（与 `dsh-tool-fs` 同规则，`src/session-cwd.ts`），
  台账记录解析后的 display path，preview/还原始终指向真实文件。
- 回退「对话和代码」时，把目标点之后发生的变更**逆序还原**（内容写回 before、新建文件删除）。
- 边界（已知限制）：台账只覆盖**插件运行期间、经写类工具**的变更；bash 命令或外部程序的修改不在台账内，无法还原（二期可加 git-first 快照层）。

### 5. 安全守卫

- agent 运行中拒绝执行（`status !== 'idle'`）。
- 文件还原是破坏性操作：UI 选择「对话和代码」时需经影响清单确认；命令路径用 `preview` 先行查看。
- 回退本身可再回退（回退动作同样进入台账/日志）。

## 客户端实现要点（纯插件，无源码补丁）

- 按钮注入锚点：用户行 `[data-chat-flow-kind="user"]`（行容器 `data-chat-anchor-key` 为节点 key）；用 MutationObserver 跟踪新增行。
- 消息 seq 获取：从行元素的 `data-chat-anchor-key` → 运行时快照 `session.getSnapshot().chat.nodes.get(key)` → `UserMessageNode.seq`（DOM 只用于定位，数据取自 runtime，不解析 DOM 文本）。
- **两步选择浮层（命令与按钮共用）**：输入 `/rewind` 或点击消息旁按钮时，客户端接管交互——第一步展示最近 user 消息列表（序号 + 时间 + 预览），选中后第二步展示模式选项（仅回退对话 / 回退对话和代码 / 取消）；确认后调 `session.command('/rewind @<seq> <mode>')` 执行。host 端分步文本引导作为无客户端/headless 场景的降级。
- 执行结果以命令节点出现在对话中。
- 注入按钮与「在新对话中分支」等官方操作并排，样式遵循 dsh 设计 token。

## 明确不包含（本期）

- 快捷键（esc+esc 回退等）——独立的快捷键插件，二期。
- 压缩（`/compact`）——官方已有。
- fork/分支回退——官方已有（「在新对话中分支」）。
- 快照式文件回退（git-first）——二期（台账方案先行）。

## 安装（预期）

```sh
dsh plugin --profile web add /home/slev/workspace/projects/dsh-rewind
```

包声明 `dsh.bundle` + `dsh.client`（双面：host 回退逻辑 + 浏览器按钮），可发布 GitHub 并打 `dsh-plugin` topic。

## 目录结构（实际）

```
src/index.ts           host 插件：/rewind 命令 + tools/execute|post-execute 台账（fs 动态注入）
src/rewind.ts          planRewind 纯函数（目标解析、surface 范围计算、候选列表）
src/ledger.ts          变更台账（记录、查询、逆序还原、影响清单；按会话 cwd 解析）
src/session-cwd.ts     会话 cwd 解析（复刻 dsh-tool-fs 规则，可单测）
src/client/index.ts    client 插件：消息行「回退」按钮 + 模式选择浮层
src/client/popover.ts  浮层 DOM（含 both 模式影响清单确认）
src/client/locales.ts  zh/en 文案（LocaleNamespaceMap 合并）
src/client/styles.ts   注入样式（dsh 设计 token）
scripts/build.mjs      esbuild 构建：lib/index.js（host ESM）+ lib/client.js（loader 闭包）
scripts/verify-host.mjs  端到端验证（真实 cordis + dsh-session，14 项断言）
tests/                 rewind/ledger 单测 + 真实 dsh-session 集成测试
cordis.patch.yml       bundle patch（插入 dsh-rewind 一行，双面）
package.json           dsh.bundle + dsh.client 声明
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
