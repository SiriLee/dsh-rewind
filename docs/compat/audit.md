# Compatibility audit (compat-audit)

> Method: **the tests are the audit**. The probes in `tests/compat-invariants.test.ts`,
> `tests/compat-interop.test.ts`, `tests/compat-gaps.test.ts` and
> `scripts/verify-host.mjs` drive the plugin's real execution paths through the DSH
> subsystems' **real consumer paths** (real `@deepseek-ai/*` packages) and assert
> compatibility invariants. A probe failure is a finding; it enters the
> fix/pin/record loop.
>
> Targeted version: npm `@deepseek-ai/*@0.1.1-rc.2` (matches `package-lock.json`);
> source reference: the `oss/deepseek-harness` local fork.
>
> Version alignment: `peerDependencies` use an OR-union (e.g.
> `^0.1.0-rc.6 || ^0.1.1-rc.2 || ^0.1.2-alpha.2`) covering each published tuple series. npm's
> prerelease matching rules require a candidate to share the range comparator's
> `[major, minor, patch]` tuple, so each new tuple series (e.g. a future
> `0.1.2-rc.x`, `0.2.x`) requires appending a union member; rc rolling within a
> tuple (`0.1.1-rc.2 → rc.3`) is a no-op. Signal: `npm view @deepseek-ai/dsh version`;
> flow: `scripts/check-dsh-version.mjs` (it reads the `latest` dist-tag only; a
> `-alpha` prerelease published under another tag, e.g. `0.1.2-alpha.2` under
> `alpha`, is a manual pre-release check).
>
> Client channel (harness `0.1.2-alpha.x`; `0.1.2-alpha.2` is published to npm
> under the `alpha` dist-tag while `latest` stays `0.1.1-rc.2`): the plugin reads
> the session chat through `uiConversation` whenever the DSH client exposes it.
> `uiConversation` surfaces the chat as a per-session named `"chat"` view
> (contributed by `dsh-client-ui-chat` through the `uiSession` slot hook) instead
> of the session-face `chat` field. `src/client/hidden.ts` (`chatSnapshotOf`) reads
> the session-face snapshot first (rc.2 path), then the `uiConversation` `"chat"`
> view (alpha path); both missing degrades to `undefined` (no targets, never a
> crash). The channel is held via a lazy `ctx.get` (never a declared `inject`), so
> the plugin keeps the rc.2 type baseline while the OR-union covers the published
> `0.1.2` tuple: `^0.1.0-rc.6 || ^0.1.1-rc.2 || ^0.1.2-alpha.2`. Pinned by
> `tests/chat-channel.test.ts` (channel precedence + the alpha snapshot shape) and
> `tests/client-dom.test.ts` (the button-target pairing that consumes the chat).
> The composer refill is dual-channel the same way: on alpha the withdrawn text is
> written through the `conversation` service's `input` resolver's `setDraft` (the
> harness's own Lexical editor), else the rc.2 `<textarea>` / alpha `contenteditable`
> DOM write (`writeComposer` in `src/client/portals.tsx`); pinned by
> `tests/client-composer.test.ts`.

## Definition of "fully compatible" (invariants)

| Invariant | Meaning | Probe location |
|---|---|---|
| I1 log replayability | A rewound log passes token-meter replay and `Session.create` (the resume-preflight validation) without throwing | `compat-invariants` I1, `verify-host` 12/13 |
| I2 surface consistency | After a cut, the surface has no duplicate nodes, every node exists in the log, the withdrawn target never returns to the surface, and `deriveMessages()` is legal | `compat-invariants` I2 |
| I3 step/turn structure | Client turn-tail ordering, unique `step/start`, every `step/end` and `assistant/message` has a paired `step/start`, no ghost turns | `compat-invariants` I3, `helpers.assertTurnTailOrdering` |
| I4 fold-service safety | stats / title / goal / projection fold a marker-bearing log without throwing, with predictable values | `compat-invariants` I4 |
| I5 compact interop | A tool-call orphaned by a cancelled turn is pair-balanced once shadowed by a rewind; a rewind across a compaction checkpoint is explicitly refused; a rewind-then-compact transaction stays legal | `compat-interop` I5, `verify-host` 12/14 |
| I6 tool pipeline | before-snapshot capture/commit/restore is correct (existing `snapshot.test.ts` + `verify-host` 4–8); cancellation timing never hangs | `verify-host` 4–8, 15 |
| I7 client ordering | A log carrying tool turns, rewind markers, and ghost steps satisfies the client builder ordering | `compat-interop` I7 |
| I8 runtime safety | `rewind`/`compact` combinations never leave a dangling step/turn frame | `verify-host` 15 |

## Verified-compatible surfaces (probes pass)

- **token-meter replay** (marker + ghost-step frames + multiple rewinds + interleaved real turns + compact stacking).
- **compaction transactions**: `toolPairingBalancedBefore/After` stays balanced after a marker cut; the real `/compact` command (`command-compact` + `compaction-basic`, stub summarizer) can land `compaction/start…end` on top of a rewind marker and stay replayable; `/compact` is a legal no-op on a small surface.
- **resume replay**: `Session.create(id, events)` replays a rewind/compact-bearing log.
- **session-stats**: a ghost-step frame adds one step but no phantom turn (reuses the turn number).
- **session-title / goal fold**: a marker does not disturb `foldSessionTitle` / `foldGoal`.
- **client ordering**: turn-tail ordering + `step/start` uniqueness hold for tool turns + marker logs.
- **rewind across a compact checkpoint**: `RewindError('not-on-surface')` refuses cleanly, no crash.
- **plan-mode**: a marker reuses the last started turn (no phantom turn); a rewind never touches the log-only `plan/mode` state (plan mode stays active; the user leaves it with `/plan off`) and the log stays replayable (`compat-invariants` I1/I3 marker + `plan/mode` probe, `verify-host`).
- **agent-loop cancellation**: `finally` guarantees step/turn closure; the rewind force-stop path leaves no dangling frame.

## Known behavior boundaries (deterministic differences, non-crash, documented)

- **session-stats / session-telemetry fold the full log**: post-rewind stats do **not** rewind — `turns`/`steps`/`llmMs` still include withdrawn content; telemetry reports the marker and ghost-step frames one-by-one (under the reused old turn). This is the intended "fold the full log" semantics, pinned by probe.
- **token-meter usage anchor briefly reverts** (G3): after a rewind, the baseline falls back to the heuristic `estimated` until the next real-usage call restores it. Confirmed expected behavior (a marker inherently carries no usage); pinned by `compat-gaps` G3.
- **Withdrawn content stays searchable/exportable**: session-query full-text and `/export` read the raw log; a rewind cuts only the surface, so withdrawn messages remain (declared in the README).
- **Session title auto-regeneration**: the title derives from the surface, so an automatically-derived title may change after a rewind.
- **Files written but uncommitted in a cancelled turn**: a `both` rewind cannot restore them (tool side-effect timing; same as Claude Code).
- **Attachment files left after a message is shadowed**: attachment storage is not cleaned with the surface (`dsh-attachment-local` not installed, not automatically verified).
- **Rewind leaves plan mode untouched**: `/plan text` is two independent actions (enter plan mode + steer the message). Rewinding the message undoes only the message — the log-only `plan/mode` state stays active, and the user leaves plan mode with `/plan off`, which still commits after a rewind (the marker creates no open turn). Pin: `verify-host` plan checks (`plan rewind leaves plan mode active`, `/plan off after rewind turns plan mode off`), `tests/hidden.test.ts` `messageTextAt`.

## Upstream (harness) issues and the plugin's no-compensation stance

The plugin treats these as harness-side defects it does not compensate for. Each entry records the harness issue, its current status, and the plugin's stance, so a future maintainer does not "fix the wrong direction."

### RU-I18N: host-side locale preference is not reliably readable at command registration (harness-side structural timing defect; plugin reads once, never retries)

- **Root cause (harness-side)**: the plugin resolves `activeLocale` in an
  `ctx.inject(['settings'])` callback that reads `settings.get(settingsNamespace('locale')).preference`
  **once, with no retry** (`src/index.ts`). `dsh-client-locale`'s host half
  registers that `locale` settings section **through its own `ctx.inject(['settings'])`**
  (`packages/client/locale/src/index.ts`). Both callbacks wait only on `settings` and are
  independent of each other, so cordis makes **no ordering guarantee** between the
  section registration and the plugin's read.
- **Observed failure**: a probe confirmed that when the plugin's read runs, `settings.get('locale')`
  returns `undefined` (the section is not yet registered), so `activeLocale` stays at the
  default `'en'` and — because the read is one-shot — is never corrected. The result is that
  **all host-side `t()` output (runtime messages and command descriptions alike) renders in
  English**, regardless of the user's language preference.
- **Not a user-config problem**: `settings.yaml` correctly carries `locale.preference: zh`;
  reading it directly works. The defect is purely the host-side read racing the section
  registration.
- **Plugin stance**: no compensation. The plugin does not add a lazy re-read, a retry loop, or a
  post-locale description re-registration as a workaround, because the guarantee belongs to the
  harness (make the locale preference available before plugin registration, or support per-locale
  command descriptions). The plugin's `t()` design is retained; localized host output is treated
  as an upstream capability to be restored when the harness provides it. (Command descriptions
  are English for **every** host command — system plugins also pass raw English `description`
  strings, e.g. `/goal` — so this behavior is consistent with the ecosystem, not a plugin
  deviation.)

### R-OPENSTEP: an unclosed `step` in the log lets a rewind break token-meter replay (harness-side; plugin guard attempted and reverted)

> **Root cause (harness-side)**: an unclosed step left by a crash makes token-meter replay
> reject any later step activity. DSH `0.1.1-rc.2` now auto-closes crash-left step/turn/tool
> boundaries at load via `interruptedTurnClosers` (`dsh-session`, consumed by
> `session-persistence/src/coordinator.ts`) — **the crash path is fixed**.
>
> **Plugin guard (attempted and reverted)**: a `hasOpenStep` + `planRewind` pre-refusal was
> implemented (`open-step`) but misjudged on **real session logs** (normal rewinds refused, GUI
> verification broken), and was reverted (`177ec14`). Conclusion: **the plugin sets no guard**,
> accepting residual risk (an unclosed step produced by a third-party plugin can break
> `/compact` — that log is already abnormal, and continuing the conversation triggers the same).
> The fix direction is in the harness (token-meter recovery for unclosed steps), not the plugin.

#### Concrete `step/start` trigger paths (source-confirmed)

The tree has exactly **one** `append('step/start')` producer: `packages/core/agent-loop/src/agent.ts:279`
(no other producer inside the official packages; `session/end-seed` etc. only truncate torn writes,
not logically-unclosed steps).

| # | Trigger path | Plausibility | Basis |
|---|---|---|---|
| P1 | **Abnormal process termination**: `step/start` is batched to disk (write-behind, `maxDelayMs` per batch) → the step is mid-execution (LLM stream/tool, seconds to minutes) → SIGKILL / OOM-kill / power loss / WSL hard-close → `step/end` (in `finally`, only runs while the process is alive) is never persisted | **Most realistic** | `agent.ts:292` finally; write-behind batching; torn-write fix truncates only a half-written line |
| P2 | **Third-party plugin bug**: only the official agent-loop produces one, but external plugins may `session.append('step/start', …)` and never close it | possible | public `Session.append` |
| P3 | **Manual session-file editing**: edit `~/.dsh/…/session.jsonl[.zstd]` (zstd needs decompress/recompress; plaintext config edits directly) | possible but laborious | `persistence-jsonl/format.ts` (`JsonlCompression = 'zstd' \| 'none'`) |
| P4 | **append itself failing**: `append('step/end')` in `finally` throws (payload is plain numbers, nearly impossible) | theoretical | `agent.ts:292` |

**Amplifier (rewind is not the only trigger)**: after a crash resume, agent-loop `turn()` opens a
new turn at `phase.turn + 1` (`agent.ts:251-255`) **without closing the leftover step** — so
"continue the conversation" (a new `step/start`) trips the same token-meter check. Scope:

- **The conversation itself is unaffected** (the request path does not call `tokenMeter.measure`; only compaction-basic does tree-wide).
- **Manual `/compact` fails permanently** (`compactNow`'s first `measure()` throws the raw error).
- **Automatic compaction silently stays disabled** (the `agent/pre-step` hook catches and warns; the conversation continues).
- **rewind's role**: if the user rewinds first (rather than continuing), the ghost `step/start` becomes the first trip-wire, and the plugin has no defensive detection — upgrading a "locally abnormal log" into a "user-visible `/compact` failure."

## Uncovered boundaries (need an additional e2e layer; non-blocking)

- Real LLM streaming and auto title generation (L2 stubbed).
- Real SQLite index lifetime (`dsh-session-query-sqlite` not installed; native deps).
- Actual browser rendering replay (the client contract's logic layer is covered by `client-contract.test.ts`).
- Real JSONL persistence round-trip (`dsh-session-persistence-jsonl` depends on native `koffi`; the round-trip validates the harness's own zstd/JSON codec, the plugin is not party to it, not worth the cost, not installed).
- `session-reference`'s `SessionReferenceResolver.prepare` needs a full session-query service; its data base (current-surface projection) is already covered by the G1 probe (`foldSurface`).
- telemetry pipeline (`dsh-session-telemetry-otel`) and the attachment provider (`dsh-attachment-local`).
- Running workflow/jobs cancelled by a rewind: the tool contract requires observing `exec.signal` and settling (`packages/core/tools/src/index.ts`); a rewind triggers the harness's standard cancel, not plugin-specific — statically confirmed, real workflows untested.

## Audit matrix (subsystem × invariant)

| DSH subsystem | I1 | I2 | I3 | I4 | I5 | I6 | I7 | I8 |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| Session core (append/surface/deriveMessages) | ✓ | ✓ | ✓ | — | ✓ | — | ✓ | ✓ |
| token-meter | ✓ | — | ✓ | — | ✓ | — | — | — |
| compaction (transaction/command/tool-pairing) | ✓ | — | — | — | ✓ | — | — | ✓ |
| session-stats / projection | — | — | ✓ | ✓ | — | — | — | — |
| session-title | — | — | — | ✓ | — | — | — | — |
| goal | — | — | — | ✓ | — | — | — | — |
| resume / session-query replay | ✓ | — | ✓ | — | — | — | ✓ | — |
| tool pipeline (snapshot/restore) | — | — | — | — | — | ✓ | — | ✓ |
| client ordering | — | — | ✓ | — | — | — | ✓ | — |
| plan-mode | ✓ | — | ✓ | — | — | — | — | ✓ (static) |

✓ = probe passes; — = not applicable. RU-I18N and R-OPENSTEP are upstream issues the plugin
does not compensate for (see above); G3 is a confirmed-non-defect behavior pinned in
`compat-gaps.test.ts` (G1 surface classification via `foldSurface` and G2 projection checkpoint
both pass).
