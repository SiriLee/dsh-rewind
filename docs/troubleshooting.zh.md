# 故障修复

[English](troubleshooting.md)

## 历史加载失败：`…turn-tail… received an update before its start Match`

0.2.4 及之前版本的回退与下一条真实回合的 `turn/start` 撞号，重开会话时历史整段消失。0.2.5 起的新回退不再产生该冲突；**已损坏的旧会话需离线修复**（日志是 append-only 的）。修复工具（`dsh-rewind-repair`）v0.4.0 起不再随包提供——安装 v0.4.0 之前的版本即可获取（先完全退出 dsh web / host，然后）：

```sh
npm exec --yes --package=dsh-rewind-plugin@0.3.3 -- dsh-rewind-repair
npm exec --yes --package=dsh-rewind-plugin@0.3.3 -- dsh-rewind-repair -- --dry-run  # 只预览不写盘
```

工具只改写标记事件的 `data.turn`（保持 seq / 顺序 / zstd 帧结构不变），改前自动备份原文件——可安全重复运行。源码方式：v0.4.0 之前的 tag 下 `node scripts/repair-markers.mjs`（参数相同）。
