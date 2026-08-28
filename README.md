# dsh-rewind

DeepSeek Harness 插件：**一键就地回退对话到任意更早的用户消息**——同窗口内完成，不新建分支、不换窗口，可一并还原工作区文件（完整 Claude Code `/rewind` 语义）。

[![npm version](https://img.shields.io/npm/v/dsh-rewind-plugin.svg)](https://www.npmjs.com/package/dsh-rewind-plugin)
[![npm downloads](https://img.shields.io/npm/dm/dsh-rewind-plugin.svg)](https://www.npmjs.com/package/dsh-rewind-plugin)
[![tests](https://img.shields.io/endpoint?url=https%3A%2F%2Fgist.githubusercontent.com%2FSiriLee%2Fdb3b9260351c2b26eb3d201c2ed29df1%2Fraw%2Fbadge.json)](https://github.com/SiriLee/dsh-rewind/actions/workflows/ci.yml)

> [English](README.en.md) | 中文

刻意聚焦、保持极简，只做一件事：**就地回退到任意远的用户消息**，还能**顺手还原改过的文件**。

- **回退 = 时间回溯**——目标消息及其之后的全部内容（agent 回复、工具调用）同时从**模型上下文**和**渲染对话**中撤回，不新建会话、不切换窗口；目标消息文本会回填输入框，改完可重发。**在原理上就真正无感、便捷**。
- **轻量工作区备份**——行为对齐 Claude Code：只跟踪写文件的工具，写前做轻量备份并**落盘持久化**，不依赖、也不触碰 git 仓库。一个轻型插件，即拥有**完备的智能体回退能力**。
- **信息安全优先**——插件从不删改会话日志（append-only），从不真正删除你的任何对话；文件还原限定在插件自己的备份目录。完整安全模型：[SECURITY.md](SECURITY.md)。
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

## 存储管理

快照（写前备份）存储于 `~/.dsh/rewind-snapshots/`。插件对**同一会话**的快照做内容去重（内容未变则存为链接）并保留最近 100 组锚点；**手动删除该目录**仅清除文件备份（对话回退不受影响），插件会自动重建。

另提供**全局自动清理**（默认关闭）：把**长期不活跃**的会话快照整目录移除，不影响活动会话与对话日志。用 `/snapshot-auto-cleanup` 命令**查看与设置**，配置写入 `~/.dsh/snapshot-cleanup.json`。详见：[快照自动清理](docs/snapshot-auto-cleanup.zh.md)。

## 本插件的优势

和常见的几种做法相比，本插件在"回退"这件事上的取舍：

| 维度 | 常见做法 | 本插件 |
| --- | --- | --- |
| 对话回退 | Fork 分支新建对话 | **就地回退**——不新建会话、不切窗口，便捷回退 |
| 文件还原 | 无还原功能 / git 管理或完整快照 | **写前轻量备份**——写文件前自动存原内容，一键还原（对齐 Claude Code） |
| 依赖 | 常依赖 Git 仓库或完整快照引擎 | **无依赖**——不依赖 git，普通目录即可用 |
| 存储开销 | 整树快照占空间大 | **轻量**——只存被写工具改动过的文件，落盘持久化 |

## 原理

整套设计只有两条主线，核心哲学朴素却克制：**对话部分「只遮蔽、不删除」，文件部分「改前先备份，还原时对照真实磁盘」**。机制与 Claude Code 的 checkpointing 同源——Claude Code 的文件历史也是逐文件记录 + 每条消息重扫已跟踪文件，并非整树快照；本插件把同一套语义落在 dsh 上，并做得更轻、更稳。

### 1. 对话回退：一次「遮蔽」，而不是「删除」

`append-only` 是铁律：会话日志只追加、从不改写——这是可审计与信息安全的地基。回退从不动历史，它只做一步：往日志末尾追加**一条内容为空的消息标记**，用它把目标消息之后的全部内容「遮蔽」掉，让模型和界面都只看得到目标之前的部分。

- 标记本身是**空的**——不进入模型上下文、不渲染成任何对话内容，模型和你看到的对话就是目标消息当时的样子，真正的「就地」；
- 因为是「遮蔽」而非「删除」，**被撤回的每一条事件都完整留在日志里**，可审计、可追溯，原则上也随时能手动恢复；
- 标记非常「懂」dsh——它复用**最后一个已开始的回合**的编号（而不是「最后回合 + 1」），并自带一个独立的**幽灵步骤框架**。于是 harness 自己的日志重放、`/compact` 压缩、续接检查都能正确识别它，绝不会把它误认为真实对话。

> **设计点睛**：整个对话回退就是**一条**追加。它确定、可审计，且因为日志从未被破坏，回溯是「干净的」——用最小的动作，实现最完整的语义。那些与 harness 内部的兼容细节（幽灵步骤框架、复用回合号）正是插件的专业所在，每一条都由专门的探针测试固化。

若 agent 正在运行（LLM 思考/流式输出），会先强制停止并等待安静下来再回退；停不下来则中止并报错。

### 2. 文件还原：轻量检查点，「改前备份」

文件部分对齐 Claude Code 的检查点语义——**逐文件、写前备份 + 每条消息重扫已跟踪文件**，而不是整树快照。这项取舍既省空间，又更完整：

- **改前备份**：追踪写类工具（`write`、`edit`、`str_replace_editor`），在**每次写文件之前**先把原内容存下来。关键在时机——在审批门放行之后捕获：审批短路不会漏备份，被拒绝的调用也不会留下记录；读取失败只警告、从不阻塞写操作。备份按对话轮次分组锚定，**落盘持久化**，重启也还在。
- **外部变更也追**：每条用户消息边界，插件重新检查所有已跟踪文件——那些从没经过写工具、被外部改过或删掉的文件，同样被记录，回退时一并还原。这让「轻量」却不「残缺」。
- **还原前对照真实磁盘**：这是最值得说的一点。回退时插件实时读取文件当前内容，与目标状态逐一比对——**只操作真正不一致的文件**：改过的写回最早备份、目标之后新建的删除、已经一致的跳过。重复回退因此**零副作用、幂等**，绝不会出现「幽灵影响」。
- **安全边界**：符号/硬链接跳过，避免透过一个还原误伤另一个名字；路径经安全化处理，**绝不越出备份根目录**；单个文件失败绝不中止整轮还原。

> **设计点睛**：**「对照真实磁盘再动手」** 是这套检查点里最有洞察力的决定——它从不盲目假设，而是以磁盘为准，该做的做、不该做的跳过。

### 设计亮点一览

| 设计 | 为什么值得 |
| --- | --- |
| 一次追加即一次回退 | 极小动作、极大语义，且日志从不被破坏 |
| 只遮蔽、不删除 | 历史永远可审计，原则上可恢复 |
| 改前备份 + 按轮分组 + 落盘 | 省空间、跨重启、对齐 Claude Code |
| 同内容存为链接（去重） | 上百次重复写入几乎不占空间；淘汰组前先落地链接，绝不悬空 |
| 会话级自动清理 | 只移除长期不活跃会话的快照，活动会话与对话日志永不触及 |
| 对照真实磁盘再还原 | 幂等、零副作用、不误伤 |
| 幽灵步骤框架 + 复用回合号 | 与宿主深度兼容，且被探针测试固化 |
| 崩溃安全（原子写 + 还原日志） | 断电/崩溃后仍可续做或回滚 |
| 纯函数规划 + 注入探针的存储 | 无需宿主即可单测，测试驱动 |

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
2. **轻量文件回退存在代价**——特定情况可能无法回退所有修改。行为与 Claude Code 一致。详见：[文件回退的追踪边界](docs/compat/tracking-boundary.zh.md)。
3. **v0.2.4 及更早版本**回退过的会话，继续对话后可能加载历史失败。可安装 v0.3.3 及之前版本的随附修复工具处理（[完整步骤](docs/compat/troubleshooting.zh.md)）。
4. **v0.3.3 及更早版本**回退过的会话，压缩对话（compact）不可用。新版本已兼容；受影响的旧会话建议新建会话。

## 安全

本插件只向会话日志追加回退标记事件，从不删除或改写已记录的历史。工作区文件仅在「回退对话和代码」时被改写，备份与还原都限定在 `~/.dsh/rewind-snapshots/` 内。不触碰你的 git 仓库，无网络请求，不访问任何凭据。对**长期不活跃**的会话，另有默认关闭的全局自动清理可整目录移除其快照，不影响活动会话与对话日志。完整安全模型：[SECURITY.md](SECURITY.md)。

## 开发

```sh
npm install            # devDeps 来自 npm registry
npm run check          # 一键全检：typecheck + test + build + verify:host + pack --dry-run
npm run typecheck      # tsc 三面编译（host + client + client-test）
npm test               # vitest：全部单元与兼容性测试套件
npm run build          # esbuild：lib/index.js（host ESM）+ lib/client.js（loader 闭包）+ .d.ts
node scripts/verify-host.mjs   # 端到端验证构建产物
```

`prepare` 执行完整构建，所以 git 安装与 `npm pack` / `npm publish` 总会产出完整的 `lib/` 与 `LICENSE`。

维护者：模块地图与 harness 接口参考见 [docs/harness-reference.md](docs/harness-reference.md)

贡献指南：[CONTRIBUTING.md](CONTRIBUTING.md)

## 发布

通过 GitHub Actions Trusted Publishing（OIDC，无存储 `NPM_TOKEN`）发布：推送 `v<版本>` tag，CI 即带 Sigstore provenance 发布。

```sh
npm version patch && git push origin main --tags
```

一次性 npm 侧配置与完整流程：见 [docs/release/release.zh.md](docs/release/release.zh.md)。

## 许可

[MIT](LICENSE)
