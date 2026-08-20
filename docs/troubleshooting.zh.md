# 故障修复

[English](troubleshooting.md)

## 历史加载失败：`…turn-tail… received an update before its start Match`

0.2.4 及之前版本在回退**之后继续对话**的场景下会损坏会话的客户端重放：标记的 turn 号
与下一条真实回合的 `turn/start` 编号冲突，重新打开会话时界面报

```
历史加载失败：conversation Context …:turn-tail… received an update before its start Match（internal）
```

历史整段消失。0.2.5 起新的回退不再产生该冲突；但**已损坏的会话需要离线修复**（日志是
append-only 的，不能在内存中改写）。

修复工具**已随 npm 包发布**（`dsh-rewind-repair`）——无需下载源码：

```sh
# 1. 先完全退出 dsh web / host（会话处于驻留内存时，磁盘修复会被下次 checkpoint 覆盖）
# 2. 运行离线修复（扫描 ~/.dsh/sessions 下所有会话，把标记 turn 改回最后一个已开始的回合）
npm exec --yes --package=dsh-rewind-plugin -- dsh-rewind-repair
npm exec --yes --package=dsh-rewind-plugin -- dsh-rewind-repair -- --dry-run  # 只预览不写盘
# 3. 重启 dsh web，损坏的会话即可正常加载历史
```

也可以全局安装一次（`npm i -g dsh-rewind-plugin`）后直接运行 `dsh-rewind-repair`；
源码方式为 `node scripts/repair-markers.mjs`（参数相同）。

工具只改写 `dsh-rewind` 空标记事件的 `data.turn` 字段（保持 seq / 顺序 / zstd 帧结构不变），
改前自动备份原文件为 `session.jsonl.zstd.bak-<时间戳>`；不改动任何其它事件，可安全重复运行。
