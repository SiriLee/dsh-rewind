# DeepSeek Harness interface reference

> Maintainer doc: the harness subsystems this plugin depends on, and the key
> source files behind each interface. Local fork (if present):
> `<workspace>/oss/deepseek-harness/` — official repo:
> [github.com/deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)

## Subsystem docs (`docs/subsystems/`)

- [session.md](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/subsystems/session.md) — `Session` / `SessionStore` / event model (`Session.append`, `surfaceOp`, `sourceEventSeqs`)
- [core.md](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/subsystems/core.md) — `Agent` (`status`, `session`) and other core types
- [commands.md](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/subsystems/commands.md) — command registration (`ctx.commands.register`, `CommandInvocation`, `CommandResult`)
- [tools.md](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/subsystems/tools.md) — tool execution seam (`tools/pre-execute` / `tools/post-execute`, `ToolExecution`)
- [session-query.md](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/subsystems/session-query.md) — session query / `foldSurface` read-only interfaces

Also under `docs/` at the repo root: `persistence-catalog.md` (full
`SessionEventMap`), `tool-catalog.md` (tool inventory), `config-catalog.md`
(configuration inventory).

## Key source (`packages/`)

| Interface | File |
|---|---|
| `Session.append`, surface validation | [packages/core/session/src/index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/main/packages/core/session/src/index.ts) |
| `foldSurface`, replacement rules | [packages/core/session/src/surface.ts](https://github.com/deepseek-ai/deepseek-harness/blob/main/packages/core/session/src/surface.ts) |
| `SessionEventMap`, `SurfaceOp` | [packages/core/session/src/types.ts](https://github.com/deepseek-ai/deepseek-harness/blob/main/packages/core/session/src/types.ts) |
| `createUserMessage`, `MessageSource` | [packages/llm/llm/src/message.ts](https://github.com/deepseek-ai/deepseek-harness/blob/main/packages/llm/llm/src/message.ts) |
| `CommandDefinition`, `CommandInvocation` | [packages/interaction/commands/src/index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/main/packages/interaction/commands/src/index.ts) |
| `Agent` (`status` / `session`) | [packages/core/agent/src/runtime-types.ts](https://github.com/deepseek-ai/deepseek-harness/blob/main/packages/core/agent/src/runtime-types.ts) |
| `tools/pre-execute` / `execute` / `post-execute` | [packages/core/tools/src/index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/main/packages/core/tools/src/index.ts) |
| Client DOM anchors (`data-chat-flow-kind` / `data-chat-anchor-key`) | [packages/client/ui-conversation/src/client/chat/ChatNodeSeat.tsx](https://github.com/deepseek-ai/deepseek-harness/blob/main/packages/client/ui-conversation/src/client/chat/ChatNodeSeat.tsx) |
| User bubble rendering | [packages/client/ui-conversation/src/client/chat/MessageItem.tsx](https://github.com/deepseek-ai/deepseek-harness/blob/main/packages/client/ui-conversation/src/client/chat/MessageItem.tsx) |
| Client `SessionFace` (`command` / `cancel`) | [packages/client/runtime/src/client/contract/session.ts](https://github.com/deepseek-ai/deepseek-harness/blob/main/packages/client/runtime/src/client/contract/session.ts) |
| Client `PendingWait` (`respond`) | [packages/client/runtime/src/client/sessions/pending.ts](https://github.com/deepseek-ai/deepseek-harness/blob/main/packages/client/runtime/src/client/sessions/pending.ts) |
