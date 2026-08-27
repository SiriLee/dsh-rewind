# 客户端契约 — 回退可见性

第三方 DOM 插件如何获知**哪些转录行被回退撤回**。这是该问题的唯一权威
答案；未在此列出的内容均属内部实现，可随时变更，恕不另行通知。

## 稳定性分级

| 通道 | 稳定性 | 适用方 |
| --- | --- | --- |
| `/rewind` 命令 `args` 中的 `@<seq>` | ✅ 稳定，受 semver 保护 | 机器 |
| `outcome.sourceEventSeq`（marker 日志 seq） | ✅ 稳定，受 semver 保护 | 机器 |
| `data-dsh-rewind-hidden` 属性 | ✅ 属性名稳定；仅观测性 | DOM 插件 |
| `outcome.text` | ❌ **不**稳定 — 人类可读文案，禁止解析 | — |

## 唯一机器通道

`dsh-rewind-plugin/client` 导出插件自身所用的纯函数计算，与本地化无关
（不读取 DOM，也不解析 host 文案）：

```ts
import { hiddenSeqsOf, type HiddenChat } from 'dsh-rewind-plugin/client'

const chat = session.getSnapshot().chat
const hidden = hiddenSeqsOf(chat as HiddenChat) // 被隐藏的 anchor seq 集合
```

`hiddenSeqsOf` 隐藏所有内部探针行（`preview` / `__candidates`）、所有成功
执行的 `/rewind` 行，以及每条回退 `[target, marker]` 区间内的消息（每次
回退切一条区间，区间互不合并）。只需从命令 `args` 取 target 时，可用同样
导出的 `targetSeqOfArgs`。请复用这些实现，勿自行重写（参见
dsh-chat-timeline#6）。

## DOM 属性

每条被撤回的行在隐藏期间带有 `data-dsh-rewind-hidden="true"`，取消隐藏时
移除。契约如下：

- **属性名**稳定；值视为不透明。
- 仅**观测性**标记 — rewind 通过 `style.display` 隐藏，该属性记录的是
  原因而非机制。不要写它；也不要在 rewind 控制范围之外（第三方自建元素）
  期望它存在。

## 明确非契约

`outcome.text` 是面向人类用户的文案，措辞随本地化自由变更，解析它即视为
bug。preview 文案中的 `impact=<n>` 尾注是机器可读且稳定的，但不属于本
契约范围。

## 维护规则

- 任何改变 `@<seq>` / `sourceEventSeq` / `data-dsh-rewind-hidden` 语义的
  改动，必须在同一 PR 中更新本文档。
- 破坏已承诺的稳定性分级属于 minor/major 版本变更。
- `scripts/build.mjs` 在每次构建时断言导出面。
