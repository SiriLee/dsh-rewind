# 兼容性排查记录（compat-audit）

> 排查方式：**测试即排查**。`tests/compat-invariants.test.ts`、`tests/compat-interop.test.ts`
> 与 `scripts/verify-host.mjs` 中的探针，把插件的真实执行路径插入 DSH 各子系统的
> **真实消费路径**（真实 `@deepseek-ai/*` 包），断言兼容性不变量。探针失败即发现，
> 进入「修复 / 钉住 / 记录」闭环。
>
> 针对版本：npm `@deepseek-ai/*@0.1.0-rc.8`（与 `package-lock.json` 一致）；
> 源码参考：`oss/deepseek-harness` 本地 fork。

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

### R-OPENSTEP：日志存在未闭合 step 时，rewind 会破坏 token-meter 重放（中等风险，待修复）

- **场景**：日志携带未闭合的 `step/start`（异常日志：手工编辑、崩溃发生在 agent-loop 的
  `finally` 闭合之前、或第三方插件 bug）。插件无感知地追加幽灵 step 帧，token-meter 随后
  抛 `step/start at seq N arrived before turn T/step S ended`——之后每次 `measure()` 都抛错，
  会话的 `/compact` 与自动压缩**持续失效**。
- **探针**：`tests/compat-interop.test.ts` → `DISCOVERY R-OPENSTEP`（钉住当前不兼容行为）。
- **判定**：待修复。真实 agent-loop 用 `finally` 保证正常路径总闭合 step/turn
  （`packages/core/agent-loop/src/agent.ts`），所以正常会话不触发；但防御性修复成本低：
  rewind 前检测未闭合 step 并**明确拒绝**（新增 `RewindError('open-step')`），避免静默破坏
  `/compact`。修复后该探针断言反转（拒绝而非重放失败）。
- **修复建议**：`planRewind` 开头扫描 `step/start`/`step/end` 配对，未闭合即抛
  `RewindError('open-step')`；`rewindErrorResult` 增加文案映射（zh/en）。

### G3（新确认，行为差异非崩溃）：rewind 让 token-meter 的 usage 锚点短暂失效

- **场景**：rewind 的 marker 是日志最后一条 `assistant/message` 且无 `usage`，token-meter
  的 `_sync` 重放以它收尾，把 `MeasurementAnchor.baseline` 从 provider 实测 `usage` 覆盖为
  启发式 `estimated`——直到下一条带 usage 的真实消息才恢复（探针验证了完整链条：
  `usage → rewind → estimated → 真实 turn → usage`）。
- **影响**：token 压力估算短暂退回启发式；对自动压缩阈值判断有微小偏差，不破坏功能。
- **探针**：`tests/compat-gaps.test.ts` → `G3`（钉住该行为）。

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

✓ = 探针通过；— = 不适用。R-OPENSTEP 未列入（待修复项）。G3 见「已知边界」。
缺口探针 `tests/compat-gaps.test.ts`：G1 surface 分类（`foldSurface` current/shadowed/log-only）
与 G2 projection checkpoint 均验证通过；G3 钉住 token-meter baseline 行为差异。
