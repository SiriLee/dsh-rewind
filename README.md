# dsh-rewind

DeepSeek Harness 插件：**一键就地回退对话到任意更早的用户消息**——同窗口内完成，不新建分支、不换窗口，可一并还原工作区文件（完整 Claude Code `/rewind` 语义）。

[![npm version](https://img.shields.io/npm/v/dsh-rewind-plugin.svg)](https://www.npmjs.com/package/dsh-rewind-plugin)
[![npm license](https://img.shields.io/npm/l/dsh-rewind-plugin.svg)](https://github.com/SiriLee/dsh-rewind/blob/main/LICENSE)
[![npm downloads](https://img.shields.io/npm/dm/dsh-rewind-plugin.svg)](https://www.npmjs.com/package/dsh-rewind-plugin)

> [English](README.en.md) | 中文

刻意聚焦、保持极简，只做一件事：**就地回退到任意远的用户消息**，还能**顺手还原改过的文件**。

- **回退 = 时间回溯**——目标消息及其之后的全部内容（agent 回复、工具调用）同时从**模型上下文**和**渲染对话**中撤回，不新建会话、不切换窗口；目标消息文本会回填输入框，改完可重发。**在原理上就真正无感、便捷**。
- **轻量工作区备份**——行为对齐 Claude Code：只跟踪写文件的工具，写前做轻量备份并**落盘持久化**，不依赖、也不触碰 git 仓库。一个轻型插件，即拥有**完备的智能体回退能力**。
- **信息安全优先**——插件从不删改会话日志（append-only），从不真正删除你的任何对话；文件还原限定在插件自己的备份目录。
- **完备测试系统**——单元、探针、端到端主机验证，覆盖兼容性探测、日志重放、续接、跨重启等场景；随 harness 升级持续维护，确保功能稳定。

## 效果预览

每条用户消息的操作行都有一个 **↶ 回退** 按钮。点击后弹出模式选择浮层——「**仅回退对话**」或「**回退对话和代码**」，后者会先展示文件变更清单再确认。还可以通过 **`/rewind` 命令**和**快捷键**便捷地选择和回退。

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

> ⚠️ npm 上的 `dsh-rewind` 属于其他作者，请用 `dsh-rewind-plugin` 安装。

## 使用

1. 在对话中找到要回退的那条用户消息，或输入 `/rewind` 打开候选列表选择。
2. **选中它。** 小浮层提供两种模式（「回退对话和代码」仅在目标之后有可还原的变更时显示）。
3. 回退立即生效：对话回到目标消息当时的样子，被撤回消息的文本自动填入输入框——改完直接重发。

**键盘操作**：候选列表与模式浮层均支持 ↑↓ 移动、Enter 确认、Esc 取消/返回。

<details>
<summary><b>边界说明</b></summary>

- 回退可以反复进行——没有阶段或次数限制。
- 回退本身**无法撤销**，但被撤回的内容仍保留在会话日志中，可手动编辑日志恢复。
- **插话也能回退**——模型尚未读取的 `steering` 插话消息，同样可作为回退目标。
- **回退会打断当前正在运行的回合**——确保回退安全执行。

</details>

## 本插件的优势

和常见的几种做法相比，本插件在"回退"这件事上的取舍：

| 维度 | 常见做法 | 本插件 |
| --- | --- | --- |
| 对话回退 | Fork 分支新建对话 | **就地回退**——不新建会话、不切窗口，便捷回退 |
| 文件还原 | 无还原功能 / git 管理或完整快照 | **写前轻量备份**——写文件前自动存原内容，一键还原（对齐 Claude Code） |
| 依赖 | 常依赖 Git 仓库或完整快照引擎 | **无依赖**——不依赖 git，普通目录即可用 |
| 存储开销 | 整树快照占空间大 | **轻量**——只存被写工具改动过的文件，落盘持久化 |

## 原理

机制与 Claude Code 的 checkpointing 同源（Claude Code 的文件历史也是逐文件记录 + 每条消息重扫已跟踪文件，并非整树快照）。本插件实现的是同一套语义，落在 dsh 上：

### 1. 对话回退：怎么做到"就地"又不丢日志

对话日志是**只追加**的——插件绝不改写历史。回退的做法：往日志里追加一条**空内容标记**，用它把目标消息之后的全部对话内容"遮蔽"掉，让模型和界面都只看到目标之前的部分：

- 标记本身是**空的**——不进入模型上下文、不渲染成任何对话内容，agent 和你看到的对话就是目标消息当时的样子；
- 因为只是"遮蔽"而非"删除"，**被撤回的每一条事件都完整留在日志里**，审计可追溯；
- 标记复用"最后一个已开始的回合"的编号，并自带独立的步骤框架——让 dsh 自身的机制（日志重放、`/compact` 压缩、续接检查）都能正确识别它，不会误认为真实对话（这些兼容细节经过专门的探针测试固化，见[开发](#开发)一节）。

<details>
<summary><b>实现细节（给维护者）</b></summary>

插件向会话日志追加一条空内容标记 `assistant/message`，其 `surfaceOp: { op: 'replace', start, end }` 把目标消息之后的全部 surface 节点替换为标记本身：

- 标记携带 `sourceEventSeqs` 覆盖所有被遮蔽节点，`Session.append` 的 surface 规则校验切割合法性（仅限当前 surface 上的连续区间）。
- 因为标记**内容为空**，harness 会将其派生为 `null`——永不进入模型上下文、也永不渲染成对话内容。
- 标记的 **turn 号复用最后一个已开始的回合**（`markerTurnOf`），而不是「最后回合 + 1」：harness 恰好用 `最后 turn/start + 1` 编号下一条真实回合。若标记也取这个数，日志里就会出现同一 turn 的 `assistant/message` 先于 `turn/start` 的乱序，客户端 conversation 构建器会以 `conversation Context …:turn-tail… received an update before its start Match` 拒绝重放——历史加载失败、整个对话从界面消失。复用已消费的 turn 号则标记只是上一个已完成回合尾部的一次无害追加，永不与新回合冲突。
- 标记自带**幽灵步骤框架**——自己的 `step/start` … `step/end`，step 号取该回合未用过的新号（`markerStepOf`）：harness 的 token-meter 重放要求每条 `assistant/message` 位于打开的 step 内，裸标记则会让该会话的 `/compact` 失效。

</details>

若 agent 正在运行（LLM 思考/流式输出），会先强制停止并等待安静下来再回退；停不下来则中止并报错。

### 2. 文件还原：写前备份 + 外部变更追踪 + 磁盘比对

插件跟踪写文件的工具——`write`、`edit`、`str_replace_editor`：

1. **写前备份**：每次写文件**之前**先把原内容存下来（在审批门放行之后捕获——审批短路不会漏备份，被拒绝的调用也不会记录；读取失败只警告、不阻塞写操作）。备份按当前对话轮次分组，**跨重启保留**（每会话保留最近 100 组）。
2. **外部变更也追踪**：每条用户消息边界会重新检查所有已跟踪文件——外部编辑或删除（写工具从没参与过的改动）同样被记录下来，回退时一并还原。
3. **还原前真实磁盘比对**：回退时实时读取文件当前内容，与目标状态比对——**只操作真正不一致的文件**：改过的写回最早备份、目标之后新建的删除、已一致的一律跳过（重复回退零副作用）。符号/硬链接跳过，避免误伤。

<details>
<summary><b>实现细节（给维护者）</b></summary>

1. **写前备份**（`tools/execute`，around-dispatch 阶段）：读取目标文件，把解析后的路径与内容放入 pending 表。此阶段只在任何 pre-execute 审批门放行之后运行——审批 `ask` 短路（dsh-edit-approval）**无法跳过**备份，被拒绝的调用也不会记录。若读取失败（如权限错误），该次变更直接不入备份——插件只在日志中警告，**不会阻塞写操作**。
2. **落盘提交**（`tools/post-execute`）：备份按当前轮**锚点消息 seq** 写入 `~/.dsh/rewind-snapshots/<会话>/<锚点 seq>/<callId>.json`。
3. **外部变更追踪**（`reconcileTracked`）：消息边界处重扫已跟踪文件，磁盘状态与上次记录不同则记录一条 `recheck-<锚点>-<hash>` 条目（锚定边界消息）；首见路径必记（重启后第一次边界无条件记录当前状态——冗余但正确，对应 Claude Code 的 resume 后 restat 行为）。
4. **还原**（`/rewind @<seq> both`）：`planRestore` 对每条记录实时探测磁盘——`before === null`（目标时不存在）仅当文件当前存在才计划删除（已缺失即已达成）；`before === 'X'` 仅当当前内容 ≠ X 才计划还原（一致即 no-op，幂等）；探测失败保守视为不一致（绝不静默跳过）。执行时 restore = 建父目录 + 写回内容，delete = 删文件（已不存在容忍为 no-op）；符号/硬链接跳过（与另一名字共享 inode，透过一个还原会误伤两个）；失败逐文件记录、不中止整轮。
5. 工具体**抛异常**会跳过 `tools/post-execute`；`tools/result` 兜底清掉 pending，避免内存泄漏。备份跨 host 重启持久化，`prune` 每会话有界保留最近 100 组锚点。

</details>

## 明确不做的事

本插件刻意保持轻量、聚焦"对话回退"这一件事，以下场景**不属于它的职责**：

- **整树 / Git 级快照**——只跟踪写类工具编辑 + 已跟踪文件的外部改动，从未被工具碰过的文件不还原。需要 Git 工作树级的完整快照回退时，请交给专门的快照工具（或你的 git）。
- **子代理的编辑**——不追踪（同 Claude Code）：子代理运行在自己的会话里，其备份无法由父会话的回退还原，只会在磁盘上残留。
- **fork / 分支回退**——harness 已内置「在新对话中分支」，不重复造轮子。

## 兼容性

- Node.js `^22.19.0 || >=24.0.0`。
- DeepSeek Harness web 配置档（`dsh --profile web`）；peer `@deepseek-ai/*` 包由 harness 运行时解析。

> [!WARNING]
> 本项目与 DeepSeek Harness 均处于开发者预览阶段。可复现环境请 pin 精确版本，
> 并阅读上述行为说明。

## 客户端契约

需要获知哪些转录行被回退撤回的第三方 DOM 插件，应使用 `dsh-rewind-plugin/client` 导出的稳定、与本地化无关的纯函数，切勿解析 `outcome.text`。`data-dsh-rewind-hidden` 属性标记被撤回的行（仅观测性）。
详见：[docs/contract/client-contract.zh.md](docs/contract/client-contract.zh.md)。

## 已知问题

1. **导出的日志是完整内容**——回退只是把消息从模型上下文和视图中移除，`/export` 导出的会话日志包含**已撤回的消息**。本插件无法改动导出。
2. **v0.2.4 及更早版本**回退过的会话，继续对话后可能加载历史失败。可安装 v0.3.3 及之前版本的随附修复工具处理（[完整步骤](docs/compat/troubleshooting.zh.md)）。
3. **v0.3.3 及更早版本**回退过的会话，压缩对话（compact）不可用。新版本已兼容；受影响的旧会话建议新建会话。

## 安全

本插件只向会话日志追加回退标记事件，从不删除或改写已记录的历史。工作区文件仅在「回退对话和代码」时被改写，备份与还原都限定在 `~/.dsh/rewind-snapshots/` 内。不触碰你的 git 仓库，无网络请求，不访问任何凭据。删除 `~/.dsh/rewind-snapshots/` 仅清除文件备份（对话回退不受影响），插件会自动重建。

## 开发

```sh
npm install            # devDeps 来自 npm registry
npm run typecheck      # tsc 三面编译（host + client + client-test）
npm test               # vitest：全部单元与兼容性测试套件
npm run build          # esbuild：lib/index.js（host ESM）+ lib/client.js（loader 闭包）+ .d.ts
node scripts/verify-host.mjs   # 端到端验证构建产物
```

`prepare` 执行完整构建，所以 git 安装与 `npm pack` / `npm publish` 总会产出完整的 `lib/` 与 `LICENSE`。

维护者：模块地图与 harness 接口参考见 [docs/harness-reference.md](docs/harness-reference.md)

## 发布

通过 GitHub Actions Trusted Publishing（OIDC，无存储 `NPM_TOKEN`）发布：推送 `v<版本>` tag，CI 即带 Sigstore provenance 发布。

```sh
npm version patch && git push origin main --tags
```

一次性 npm 侧配置与完整流程：见 [docs/release/release.md](docs/release/release.md)。

## 许可

[MIT](LICENSE)
