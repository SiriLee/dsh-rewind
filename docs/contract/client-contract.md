# Client contract — rewind visibility

How third-party DOM plugins learn **which transcript rows a rewind withdrew**.
This is the only sanctioned answer to that question; anything not listed here
is internal and may change without notice.

## Stability tiers

| Channel | Stability | Consumers |
| --- | --- | --- |
| `/rewind` command `args` `@<seq>` | ✅ stable, semver-protected | machine |
| `outcome.sourceEventSeq` (marker log seq) | ✅ stable, semver-protected | machine |
| `data-dsh-rewind-hidden` attribute | ✅ stable name; observational only | DOM plugins |
| `outcome.text` | ❌ **not** stable — human copy, never parse | — |

## The sanctioned machine channel

`dsh-rewind-plugin/client` exports the pure, locale-independent computation
the plugin itself uses (it never reads the DOM or host copy):

```ts
import { hiddenSeqsOf, type HiddenChat } from 'dsh-rewind-plugin/client'

const chat = uiConversation.binding(sessionId).target('chat')?.getSnapshot() // the 0.1.2-rc.1 "chat" view
const hidden = hiddenSeqsOf(chat as HiddenChat) // Set<number> of anchor seqs
```

`hiddenSeqsOf` hides every internal probe row (`preview` / `__candidates`),
every successful executed `/rewind` row, and every message inside its
`[target, marker]` span (each rewind cuts one span; spans stay separate).
`targetSeqOfArgs` is exported for consumers that only need the target from a
command's `args`. Reuse these instead of re-deriving the logic (cf.
dsh-chat-timeline#6).

## DOM attribute

Each withdrawn row carries `data-dsh-rewind-hidden="true"` while hidden,
removed on un-hide. Contract:

- The **attribute name** is stable; treat the value as opaque.
- It is **observational only** — rewind hides via `style.display`; the
  attribute records the cause, not the mechanism. Do not write it, and do
  not expect it on rows outside rewind's control (third-party own elements).

## Explicit non-contract

`outcome.text` is human-facing copy. Its wording changes freely with
localization; parsing it is a bug. The `impact=<n>` trailer on preview text
is machine-readable and stable but outside this contract's scope.

## Maintenance rules

- Any change to the meaning of `@<seq>` / `sourceEventSeq` /
  `data-dsh-rewind-hidden` updates this document in the same PR.
- Breaking a listed stability tier is a minor/major version bump.
- `scripts/build.mjs` asserts the export surface on every build.
