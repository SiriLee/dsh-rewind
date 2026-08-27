# 故障修复

[English](troubleshooting.md)

## 历史加载失败：`…turn-tail… received an update before its start Match`

0.2.4 及之前版本的回退与下一条真实回合的 `turn/start` 撞号，重开会话时历史整段消失。0.2.5 起的新回退不再产生该冲突；**已损坏的旧会话需离线修复**（日志是 append-only 的）。修复工具（`dsh-rewind-repair`）v0.4.0 起不再随包提供——安装 v0.4.0 之前的版本即可获取（先完全退出 dsh web / host，然后）：

```sh
npm exec --yes --package=dsh-rewind-plugin@0.3.3 -- dsh-rewind-repair
npm exec --yes --package=dsh-rewind-plugin@0.3.3 -- dsh-rewind-repair -- --dry-run  # 只预览不写盘
```

工具只改写标记事件的 `data.turn`（保持 seq / 顺序 / zstd 帧结构不变），改前自动备份原文件——可安全重复运行。源码方式：v0.4.0 之前的 tag 下 `node scripts/repair-markers.mjs`（参数相同）。

## 已知兼容边界

以下均为**预期行为而非崩溃**（探针钉住，完整依据见 [audit.md](audit.md) 事实源）：

- 会话统计 / 遥测**不回退**（折叠的是完整日志）；
- 被撤回的消息**仍可搜索、可导出**（`/export` 与全文搜索基于原始日志）；
- 会话标题可能**重新生成**（标题由当前 surface 派生）；
- 被**取消的工具调用**写入的文件（无快照提交）无法由「回退对话和代码」恢复。

**R-OPENSTEP**（harness 侧，插件不设守卫）：日志中存在*未闭合* `step/start`
（agent 循环的 `finally` 闭合 step 前崩溃）时，后续 step 活动会破坏 token-meter
重放，回退后 `/compact` 可能报错。harness `0.1.1-rc.2` 已在加载时自动闭合
（`interruptedTurnClosers`）；插件曾实现前置拒绝但已回退（`177ec14`，真实日志
误判）。深入分析：[audit.md](audit.md) → R-OPENSTEP。
