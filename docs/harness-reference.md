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
- [token-meter.md](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/subsystems/token-meter.md) — replay-aware token meter (`TokenMeter.measure`, surface pricing)
- [compaction.md](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/subsystems/compaction.md) — compaction seam / `compaction/*` events / `BasicCompactionEngine` (`summarize()` hook)
- [session-projection.md](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/subsystems/session-projection.md) — projection registry (`SessionProjectionRegistry.snapshot/checkpoint`)
- [session-stats](https://github.com/deepseek-ai/deepseek-harness/blob/main/packages/session/session-stats) — whole-log stats projection (folds ALL events; rewind does not roll back counts)
- [session-title.md](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/subsystems/session-title.md) — durable title state (`foldSessionTitle`)
- [goal.md](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/subsystems/goal.md) — goal fold (`foldGoal`) and round admission

Compatibility probes against these subsystems (test-driven investigation, the
`compat-invariants` / `compat-interop` vitest suites + the `verify-host` real
`/compact` chain): [compat/audit.md](compat/audit.md).

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

## Plugin source layout

The module map below duplicates `AGENTS.md` (`Layout at a glance`), which is
the canonical source; this block only adds the finer-grained client-side files
and packaging entries.

```
src/index.ts            host plugin: /rewind command + checkpoint pipeline (tools/execute|post-execute)
src/rewind.ts           pure planning: target resolution, surface range, candidate listing
src/snapshot.ts         checkpoint store (disk before-backups, restore/preview, bounded prune)
src/session-cwd.ts      session-cwd resolution (fs-tools rule)
src/client/index.ts     client plugin: per-message ↶ button + manual /rewind guard
src/client/popover.ts   mode-selection popover (both-mode impact confirm)
src/client/hidden.ts    withdrawn-span computation (hiddenSeqsOf), pure
src/client/locales.ts   zh / en copy (LocaleNamespaceMap)
src/client/styles.ts    injected styles (dsh design tokens)
scripts/build.mjs       esbuild: lib/index.js (host ESM) + lib/client.js (loader closure) + .d.ts
scripts/verify-host.mjs end-to-end host verification (18 checks)
tests/                  vitest suites (rewind / snapshot / hidden / session-cwd / integration)
docs/                   maintainer docs: contract/, compat/, release/ subdirectories
assets/screenshots/     UI screenshots
cordis.patch.yml        bundle patch (mounts the dual-face plugin row)
package.json            dsh.bundle + dsh.client manifests, optional peerDependencies
```

