# 浏览器诊断与详细输出开关

[English](diagnostics.md)

本插件在浏览器端输出的所有诊断信息都经由同一条通道，这样可用一个控制台过滤器抓取报告，且无需重建插件即可开启详细输出模式。

## 按作用域前缀输出

诊断以 `[dsh-rewind:<scope>] ...` 形式打印。`scope` 标明子系统，同时也正是详细输出开关的过滤依据：

| scope | 报告内容 |
| --- | --- |
| `hiding` | 行隐藏路径（回退切断哪些行；`rewind not hidden` 异常） |
| `refill` | 回退后的输入框回填（目标 seq、模式、所用通道、写入结果） |
| `portals` | 每条消息按钮的挂载问题（如无会话绑定） |
| `settings` | 快照清理设置卡片 |

## 分级

| 级别 | 默认 | 含义 |
| --- | --- | --- |
| `error` | 开 | 意外/破坏性；总是打印 |
| `warn` | 开 | 可恢复的异常护栏（`rewind not hidden`、`refill skipped/refused/threw`）；总是打印 |
| `info` | 关 | 事件级生命周期（每次回退/回填一行） |
| `debug` | 关 | 逐批细节（每批 refresh 的 hiding 情况） |

`error`/`warn` 总是打印，这样即使没碰过开关的用户，异常也会浮现；`info`/`debug` 则受开关控制，保持普通用户控制台干净、流式不刷屏。

## 开启详细输出

开关位于**浏览器**的 `localStorage`、且使用插件专属键，因此它不会开启其它插件/功能，别的功能也无法唤醒本插件。设置后刷新页面、复现一次，再把控制台按 `[dsh-rewind]` 过滤即可：

```js
// 全部 dsh-rewind 命名空间。
localStorage['dsh-rewind.debug'] = 'dsh-rewind*'

// 或只开所关心的子系统（精确 scope 匹配）。
localStorage['dsh-rewind.debug'] = 'dsh-rewind:refill'

// 同时开多个（逗号分隔）。
localStorage['dsh-rewind.debug'] = 'dsh-rewind:refill,dsh-rewind:hiding'
```

设置后刷新（`F5`）。关闭：

```js
delete localStorage['dsh-rewind.debug']
```

## 采集一段报告

1. 在**复现问题的那台机器/那个浏览器页面**，开启相应命名空间（见上）并刷新。
2. 复现一次。
3. 在 DevTools 里把 Console 按 `[dsh-rewind]` 过滤，复制输出（连同插件版本、DSH/内核版本）。

对「回退后没回填输入框」这类问题，重点是 `refill` 作用域：其 `composer write` 一行会报告草稿是通过 harness facade（`facade`）还是 DOM 回退（`dom`）恢复、写入是否成功，从而区分「插件没写入」与「harness 侧渲染不同步」。

## 备注

- 该开关是维护者与配合排查者使用的工具，**不是**稳定公开接口；其具体键与输出可能不经通知而改变。
- 它受单个浏览器 origin、单个浏览器限定；请在实际出问题的地方开启。

相关：[audit.md](audit.md) 为已验证兼容矩阵，[troubleshooting.md](troubleshooting.md) 为历史修复步骤。
