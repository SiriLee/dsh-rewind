# 兼容性排查记录（compat-audit）

> 排查方式：**测试即排查**。`tests/compat-invariants.test.ts`、`tests/compat-interop.test.ts`
> 与 `scripts/verify-host.mjs` 中的探针，把插件的真实执行路径插入 DSH 各子系统的
> **真实消费路径**（真实 `@deepseek-ai/*` 包），断言兼容性不变量。探针失败即发现，
> 进入「修复 / 钉住 / 记录」闭环。
>
> 针对版本：npm `@deepseek-ai/*@0.1.1-rc.2`（与 `package-lock.json` 一致）；
> 源码参考：`oss/deepseek-harness` 本地 fork。
>
> 版本适配说明：peerDependencies 采用 OR 并集（如 `^0.1.0-rc.6 || ^0.1.1-rc.2`），
> 覆盖 DSH 已发布的 rc 元组系列。npm 的 prerelease 匹配规则要求候选与范围内比较器
> **同 `[major, minor, patch]` 元组**，因此 DSH 每次发布新元组（如未来的 `0.1.2-rc.x`、
> `0.2.x`）时需追加并集项；同元组内 rc 滚动（如 `0.1.1-rc.2 → rc.3`）无需动作。
> 判断信号：`npm view @deepseek-ai/dsh version`；流程见 `scripts/check-dsh-version.mjs`。

## 「完全适配」的可执行定义（不变量）

| 不变量 | 含义 | 探针位置 |
|---|---|---|
| I1 日志可重放 | rewind 后日志过 token-meter 重放、`Session.create`（resume preflight 同款校验）均不抛 | `compat-invariants` I1、`verify-host` 12/13 |
| I2 surface 一致 | 切割后 surface 无重复节点、节点存在于日志、被撤目标不再回到 surface、`deriveMessages()` 合法 | `compat-invariants` I2 |
| I3 step/turn 结构合法 | 客户端 turn-tail 顺序、step/start 唯一、step/end 与 assistant/message 均有配对 step/start、无幽灵 turn | `compat-invariants` I3、`helpers.assertTurnTailOrdering` |
| I4 折叠服务安全 | stats / title / goal / projection 对含 marker 日志折叠不抛且值可预测 | `compat-invariants` I4 |
| I5 compact 互操作 | 取消 turn 遗留的 tool-call 被 rewind 遮蔽后配对恢复平衡；跨 checkpoint 的 rewind 明确拒绝；rewind 后 compact 事务合法 | `compat-interop` I5、`verify-host` 12/14 |
| I6 工具管线正确 | before-快照捕获/提交/恢复正确（既有 `snapshot.test.ts` + `verify-host` 4-8）；取消时序不悬挂 | `verify-host` 4-8、15 |
| I7 客户端顺序合法 | 含工具 turn、rewind marker、幽灵 step 的日志满足客户端 builder 顺序 | `compat-interop` I7 |
| I8 运行时安全 | rewind/compact 组合不留下悬空 step/turn 帧 | `verify-host` 15 |

## 发现的兼容性问题

### R-OPENSTEP：日志存在未闭合 step 时，rewind 会破坏 token-meter 重放（**harness 侧问题；插件守卫已尝试并回退**）

> **根因（harness 侧）**：崩溃遗留的未闭合 step 会让 token-meter 重放拒绝任何后续
> step 活动。DSH `0.1.1-rc.2` 已在加载时用 `interruptedTurnClosers`
> （`dsh-session/repair`）自动闭合崩溃遗留的 step/turn/tool 边界——**崩溃路径已根治**。
>
> **插件守卫（已尝试并回退）**：曾实现 `hasOpenStep` + `planRewind` 前置拒绝
> （`open-step`），但在**真实会话日志上产生误判**（正常回退被拒、GUI 验证功能缺失），
> 已 revert（`177ec14`）。结论：**插件不设守卫**，接受残余风险（运行中第三方插件
> 产生未闭合 step 时，rewind 可能破坏 /compact——该日志本身已异常，继续对话同样触发）。
> 根治方向在 harness（token-meter 对未闭合 step 的恢复），不在插件。

#### 未闭合 `step/start` 的具体触发情况（源码确认）

全仓**只有一处** append `step/start`：`packages/core/agent-loop/src/agent.ts:279`（官方包内
无其他生产者；`session/end-seed` 等修复只做 torn-write 截断，不处理逻辑未闭合）。

| # | 触发路径 | 现实性 | 依据 |
|---|---|---|---|
| P1 | **进程非优雅终止**：`step/start` 经 write-behind 批量落盘（`session-persistence/src/write-behind.ts`，`maxDelayMs` 后写一批）→ step 执行中（LLM 流式/工具，秒级到分钟级）→ SIGKILL / OOM-kill / 断电 / WSL 强关 → `step/end`（在 `finally`，进程活着才执行）未落盘 | **最现实** | `agent.ts:292` finally；write-behind 批量；torn-write 修复只截断写一半的行 |
| P2 | **第三方插件 bug**：官方包只有 agent-loop 一个生产者，但外部插件可任意 `session.append('step/start', …)` 不闭合 | 可能 | 公开 `Session.append` |
| P3 | **手工编辑会话文件**：改 `~/.dsh/…/session.jsonl[.zstd]`（zstd 需解压/重压；plaintext 配置可直接改） | 可能但费事 | `persistence-jsonl/format.ts`（`JsonlCompression = 'zstd' \| 'none'`） |
| P4 | **append 自身故障**：`finally` 里 `append('step/end')` 抛错（payload 是纯数字，几乎不可能） | 理论 | `agent.ts:292` |

**放大机制（rewind 不是唯一触发者）**：崩溃后 resume，agent-loop `turn()` 直接
`phase.turn + 1` 开新 turn（`agent.ts:251-255`），**不闭合遗留 step**——所以「继续对话」
（新 `step/start`）同样踩中 token-meter 校验。影响范围精确界定：

- **对话本身不受影响**（请求路径不调用 `tokenMeter.measure`，全仓仅 compaction-basic 调用）；
- **手动 `/compact` 永久报错**（`compactNow` 首步 `measure()` 抛原始错误）；
- **自动压缩永久静默失效**（`agent/pre-step` 钩子 catch 后仅 warn，对话继续）；
- **rewind 的角色**：若用户先 rewind（而非继续对话），幽灵 step/start 成为第一个踩中者，
  且插件无防御性检测——把「局部异常日志」升级为「用户可感知的 /compact 失效」。

### G3（已确认：合理行为，非缺陷）：rewind 让 token-meter 的 usage 锚点短暂失效

- **机制**：rewind 的 marker 是日志最后一条 `assistant/message` 且无 `usage`，token-meter
  的 `_sync` 重放以它收尾，把 `MeasurementAnchor.baseline` 从 provider 实测 `usage` 覆盖为
  启发式 `estimated`——直到下一条带 usage 的真实消息才恢复（探针验证了完整链条：
  `usage → rewind → estimated → 真实 turn → usage`）。
- **定性（已确认）**：marker 语义上就是空消息，不携带 usage 是正确的；锚点短暂退回估算
  是该语义的自然结果，且短暂、自愈、不破坏功能。**属于预期行为，不修复**。
- **探针**：`tests/compat-gaps.test.ts` → `G3`（钉住该行为，防止未来 harness 变更改变它）。

## 已验证兼容的面（探针通过）

- **token-meter 重放**（含 marker + 幽灵 step 帧 + 多次 rewind + 交错真实 turn + compact 叠加）。
- **compaction 事务**：`toolPairingBalancedBefore/After` 对 marker 切割后的 surface 恒平衡；
  真实 `/compact` 命令（`command-compact` + `compaction-basic`，stub summarizer）可在 rewind
  marker 之上落地 `compaction/start…end` 并保持可重放；小 surface 时 `/compact` 合法 no-op。
- **resume 重放**：`Session.create(id, events)` 对含 rewind/compact 的日志重放通过。
- **session-stats**：ghost step 帧只 +1 step、不新增 phantom turn（复用 turn 号）。
- **session-title / goal fold**：marker 不干扰 `foldSessionTitle` / `foldGoal`。
- **客户端顺序**：turn-tail ordering + step/start 唯一性对工具 turn + marker 日志成立。
- **跨 compact checkpoint 的 rewind**：`RewindError('not-on-surface')` 明确拒绝，不崩溃。
- **plan-mode**：`hasOpenTurn` 只配对 `turn/start`/`turn/end`，marker 不产生 `turn/start`，
  激活 plan 期间 rewind 无影响（静态审查确认）。
- **agent-loop 取消**：`finally` 保证 step/turn 闭合，rewind 的 force-stop 路径不悬挂帧。

## 已知边界（行为差异，非崩溃，文档化）

- **session-stats / session-telemetry 折叠完整日志**：rewind 后统计**不回退**——`turns` /
  `steps` / `llmMs` 仍含被撤内容；telemetry 逐条上报 marker 与幽灵 step 帧（归入被复用
  的旧 turn）。这是「折叠完整日志」的预期语义，探针钉住该行为。
- **token-meter usage 锚点短暂失效**（G3）：rewind 后 baseline 退回启发式 `estimated`，
  下一条真实 usage 调用恢复（探针钉住）。
- **被撤内容仍可搜索、可导出**：session-query 全文搜索与 `/export` 基于原始日志，
  rewind 只切 surface，被撤消息仍在其中（README 已声明）。
- **session-title 自动重生成**：标题由 surface 派生，rewind 后自动标题可能变化。
- **取消 turn 中已写盘但未提交快照的文件**：rewind both 无法恢复（工具副作用时序，
  Claude Code 同限制）。
- **附件消息被遮蔽后文件残留**：attachment 存储不随 surface 清理（`dsh-attachment-local`
  未装，未自动化验证）。

## 未覆盖边界（需要额外端到端层，不阻塞）

- 真实 LLM 流式与自动标题生成（L2 stub 化）。
- 真实 SQLite 索引生命周期（`dsh-session-query-sqlite` 未安装、含原生依赖）。
- 浏览器端实际渲染 replay（客户端契约已由 `client-contract.test.ts` 覆盖逻辑层）。
- 真实 JSONL 持久化往返（`dsh-session-persistence-jsonl` 依赖 native `koffi`；往返验证的是
  harness 自身 zstd/JSON 编解码，插件不参与，价值/成本不划算，未安装）。
- session-reference 的 `SessionReferenceResolver.prepare` 需完整 session-query 服务；其数据
  基础（current-surface 投影）已由 G1 探针（`foldSurface` 转换）覆盖。
- telemetry 管道（`dsh-session-telemetry-otel`）与附件 provider（`dsh-attachment-local`）。
- 运行中的 workflow/jobs 被 rewind 取消：工具契约要求 observe `exec.signal` 并 settle
  （`packages/core/tools/src/index.ts`），rewind 触发的是 harness 标准取消，非插件特有——
  静态确认，未实测真实 workflow。

## 排查矩阵（子系统 × 不变量）

| DSH 子系统 | I1 | I2 | I3 | I4 | I5 | I6 | I7 | I8 |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| 会话内核（append/surface/deriveMessages） | ✓ | ✓ | ✓ | — | ✓ | — | ✓ | ✓ |
| token-meter | ✓ | — | ✓ | — | ✓ | — | — | — |
| compaction（事务/命令/tool-pairing） | ✓ | — | — | — | ✓ | — | — | ✓ |
| session-stats / projection | — | — | ✓ | ✓ | — | — | — | — |
| session-title | — | — | — | ✓ | — | — | — | — |
| goal | — | — | — | ✓ | — | — | — | — |
| resume / session-query 重放 | ✓ | — | ✓ | — | — | — | ✓ | — |
| 工具管线（快照/恢复） | — | — | — | — | — | ✓ | — | ✓ |
| 客户端顺序 | — | — | ✓ | — | — | — | ✓ | — |
| plan-mode | — | — | — | — | — | — | — | ✓（静态） |

✓ = 探针通过；— = 不适用。R-OPENSTEP 见上（harness 已修、插件不设守卫）。G3 见「已知边界」。
缺口探针 `tests/compat-gaps.test.ts`：G1 surface 分类（`foldSurface` current/shadowed/log-only）
与 G2 projection checkpoint 均验证通过；G3 钉住 token-meter baseline 行为差异。
