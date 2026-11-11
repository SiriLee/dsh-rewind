# DeepSeek Harness interface reference

> Maintainer doc: the harness subsystems this plugin depends on, the seams it
> hooks, and the key source files behind each interface. Targeted version is the
> one locked in `package-lock.json`. Official repo:
> [github.com/deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)

## Seams this plugin uses

| Seam | Ordering / payload | What the plugin relies on |
| --- | --- | --- |
| `agent/pre-step` | Runs after `inbox.claim` and before `step()` appends the claimed `user/message` events. Payload carries `messages: UserMessage[]` (plus `turn`, `step`, model selection). A prepended listener `await next()` and acts only on `decision.kind === 'enter'`. | One dense checkpoint per user-sourced message in the claimed batch; `message.id` is the key because no seq exists yet; a reject creates nothing. |
| `inbox.claim` | Returns all `next-step` messages plus at most one `next-turn`; the default `next` may append a `runtime-context` message. | One step can claim several user messages (prompt, steering, queued turn); the checkpoint filter is `source.kind === 'user'`, matching `listRewindCandidates`. |
| `tools/execute` | The around-dispatch wrapper, after `tools/pre-execute` approval/guards and before the tool body. | First-touch capture for `write` / `edit`; a denied or pre-dispatch-cancelled call never reaches it, so it records nothing. |
| Session format | `session.header.version` identifies the session format. | Written as `meta.sessionFormat`; a mismatch discards the new storage. |
| User message id | `UserMessage.id` is stable and is assigned when the message is created (`createUserMessage`). | Checkpoint file key; a rewind resolves target seq → `user/message` event → `data.id` → checkpoint. |

## Subsystem docs (`docs/subsystems/`)

- [session.md](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/subsystems/session.md) — `Session` / `SessionStore` / event model (`Session.append`, `surfaceOp`, `sourceEventSeqs`)
- [core.md](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/subsystems/core.md) — `Agent` (`status`, `session`) and other core types
- [commands.md](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/subsystems/commands.md) — command registration (`ctx.commands.register`, `CommandInvocation`, `CommandResult`)
- [tools.md](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/subsystems/tools.md) — tool execution seam (`tools/pre-execute` / `tools/execute`, `ToolExecution`)
- [session-query.md](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/subsystems/session-query.md) — session query / `foldSurface` read-only interfaces
- [token-meter.md](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/subsystems/token-meter.md) — replay-aware token meter (`TokenMeter.measure`, surface pricing)
- [compaction.md](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/subsystems/compaction.md) — compaction seam / `compaction/*` events / `BasicCompactionEngine` (`summarize()` hook)
- [session-projection.md](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/subsystems/session-projection.md) — projection registry (async `register` / `ProjectionHandle` / `snapshot` / `checkpoint`)
- [session-stats](https://github.com/deepseek-ai/deepseek-harness/blob/main/packages/session/session-stats) — whole-log stats projection (folds ALL events; rewind does not roll back counts)
- [session-title.md](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/subsystems/session-title.md) — durable title state (`foldSessionTitle`)
- [goal.md](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/subsystems/goal.md) — goal fold (`foldGoal`) and round admission

Compatibility probes against these subsystems (test-driven investigation, the
`compat-invariants` / `compat-interop` vitest suites plus the host-side
`verify-host` checkpoint/restore chain): [compat/audit.md](compat/audit.md).

Also in the harness repo's `docs/`: `persistence-catalog.md` (full
`SessionEventMap`), `tool-catalog.md` (tool inventory), `config-catalog.md`
(configuration inventory).

## Key source (`packages/`)

| Interface | File |
|---|---|
| `Session.append`, surface validation | [packages/core/session/src/index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/main/packages/core/session/src/index.ts) |
| `foldSurface`, replacement rules | [packages/core/session/src/surface.ts](https://github.com/deepseek-ai/deepseek-harness/blob/main/packages/core/session/src/surface.ts) |
| `SessionEventMap`, `SurfaceOp` | [packages/core/session/src/types.ts](https://github.com/deepseek-ai/deepseek-harness/blob/main/packages/core/session/src/types.ts) |
| `Session.header.version` / `SESSION_FORMAT_VERSION` | [packages/core/session/src/types.ts](https://github.com/deepseek-ai/deepseek-harness/blob/main/packages/core/session/src/types.ts) |
| `createUserMessage`, `UserMessage.id`, `MessageSource` | [packages/llm/llm/src/message.ts](https://github.com/deepseek-ai/deepseek-harness/blob/main/packages/llm/llm/src/message.ts) |
| `CommandDefinition`, `CommandInvocation` | [packages/interaction/commands/src/index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/main/packages/interaction/commands/src/index.ts) |
| `Agent` (`status` / `session`) | [packages/core/agent/src/runtime-types.ts](https://github.com/deepseek-ai/deepseek-harness/blob/main/packages/core/agent/src/runtime-types.ts) |
| `agent/pre-step` waterfall, `step()` ordering | [packages/core/agent-loop/src/agent.ts](https://github.com/deepseek-ai/deepseek-harness/blob/main/packages/core/agent-loop/src/agent.ts) |
| `inbox.claim` batch shape | [packages/core/agent-loop/src/inbox.ts](https://github.com/deepseek-ai/deepseek-harness/blob/main/packages/core/agent-loop/src/inbox.ts) |
| `tools/pre-execute` / `tools/execute` ordering, `ToolExecution` | [packages/core/tools/src/pipeline.ts](https://github.com/deepseek-ai/deepseek-harness/blob/main/packages/core/tools/src/pipeline.ts), [packages/core/tools/src/index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/main/packages/core/tools/src/index.ts) |
| Chat node slot entries (`conversation.chat.node`, keys `user` / `steering`) | [packages/client/ui-chat/src/client/chat/register-node-renderers.ts](https://github.com/deepseek-ai/deepseek-harness/blob/main/packages/client/ui-chat/src/client/chat/register-node-renderers.ts) |
| User/steering row: `actions(text)` prop, `extraActions`, `data-pending-steering`, `data-message-attachments` | [packages/client/ui-chat/src/client/chat/MessageItem.tsx](https://github.com/deepseek-ai/deepseek-harness/blob/main/packages/client/ui-chat/src/client/chat/MessageItem.tsx), [MessageIconActions.tsx](https://github.com/deepseek-ai/deepseek-harness/blob/main/packages/client/ui-chat/src/client/chat/MessageIconActions.tsx), [UserContent.tsx](https://github.com/deepseek-ai/deepseek-harness/blob/main/packages/client/ui-chat/src/client/chat/UserContent.tsx) |
| Client DOM anchors (`data-conversation-session`, `data-composer-input`) | [packages/client/ui-conversation/src/client/skeleton/ConversationContent.tsx](https://github.com/deepseek-ai/deepseek-harness/blob/main/packages/client/ui-conversation/src/client/skeleton/ConversationContent.tsx), [ComposerContentEditable.tsx](https://github.com/deepseek-ai/deepseek-harness/blob/main/packages/client/ui-conversation/src/client/input/editor/ComposerContentEditable.tsx) |
| Client `SessionFace` (`command` / `cancel` / `readAttachment(ImageAttachmentRef)` / `updateQueue` / `projections`) | [packages/api/session-controller/src/client/contract/session.ts](https://github.com/deepseek-ai/deepseek-harness/blob/main/packages/api/session-controller/src/client/contract/session.ts) |
| Client `inbox` projection (pending `next-step` rows: id, source, content) | [packages/core/agent-loop/src/inbox.ts](https://github.com/deepseek-ai/deepseek-harness/blob/main/packages/core/agent-loop/src/inbox.ts) |
