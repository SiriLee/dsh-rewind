# Compatibility audit (compat-audit)

> Method: **the tests are the audit**. The probes in `tests/compat-invariants.test.ts`,
> `tests/compat-interop.test.ts`, `tests/compat-gaps.test.ts`,
> `tests/compat-tool-updates.test.ts` and
> `scripts/verify-host.mjs` drive the plugin's real execution paths through the DSH
> subsystems' **real consumer paths** (real `@deepseek-ai/*` packages) and assert
> compatibility invariants. A probe failure is a finding; it enters the
> fix/pin/record loop.
>
> Targeted version: npm `@deepseek-ai/*@0.1.7-rc.2`, declared by the peers as `^0.1.7-rc.2`.
> Source reference: the upstream [github.com/deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness).
>
> Version alignment: one peer tuple per DSH line, declaring only what was verified — the
> model, the update steps, and the `check-dsh-version.mjs` signal live in
> `docs/release/release.md`. The floor moved when a release changed interfaces inside the
> tuple: `0.1.6-alpha.2` removed the client session-ownership and queue-mirror APIs, and
> `0.1.7-alpha.1` moved the session writer to format v4 (producer-owned message sources,
> tool-role results, `developer/message`) and replaced the settings namespace registry with
> each entry's volatile `Config`, so the peer floor and both plugin seams moved with them.
> The plugin targets a single DSH version line; compatibility with earlier lines is not kept.

### Single channel

The plugin targets one DSH channel. Each seam below reads the targeted
version's shape only (no `Session.events` / `<textarea>` / face-`chat`
legacy branch).

| Seam | Implementation at the targeted version |
| --- | --- |
| Host session log | `session.snapshotEvents()` |
| Client chat snapshot | `uiConversation` `chat` view (`chatSnapshotOf`) |
| Client composer refill | `conversation.input.setDraft` facade |
| Client settings card | entry form via `ctx.configForms.get(entryId)` (`plugins.bundle.config`) |
| Client seat-button DOM | structural locate of the copy-`<button>` container (`actionsContainerOf`) |

## Definition of "fully compatible" (invariants)

| Invariant | Meaning | Probe location |
|---|---|---|
| I1 log replayability | A rewound log passes token-meter replay and `Session.create` (the resume-preflight validation) without throwing | `compat-invariants` I1, `verify-host` 12/13 |
| I2 surface consistency | After a cut, the surface has no duplicate nodes, every node exists in the log, the withdrawn target never returns to the surface, and `deriveMessages()` is legal | `compat-invariants` I2 |
| I3 step/turn structure | Client turn-tail ordering, unique `step/start` (real turns), no ghost turns; the `user/message` rewind marker adds no step frame | `compat-invariants` I3, `helpers.assertTurnTailOrdering` |
| I4 fold-service safety | stats / title / goal / projection fold a marker-bearing log without throwing, with predictable values | `compat-invariants` I4 |
| I5 compact interop | A tool-call orphaned by a cancelled turn is pair-balanced once shadowed by a rewind; a rewind across a compaction checkpoint is explicitly refused; a rewind-then-compact transaction stays legal | `compat-interop` I5, `verify-host` 12/14 |
| I6 tool pipeline | before-snapshot capture/commit/restore is correct (existing `snapshot.test.ts` + `verify-host` 4–8) for the tracked tools `write` / `edit` — `str_replace_editor` is an optional DSH package that stopped being a default tool in DSH 0.1.3, so it is not tracked; cancellation timing never hangs | `verify-host` 4–9 |
| I7 client ordering | A log carrying tool turns and rewind markers (a single `user/message` replace) satisfies the client builder ordering | `compat-interop` I7 |
| I8 runtime safety | `rewind`/`compact` combinations never leave a dangling step/turn frame | `verify-host` 13 |
| I9 tool-update projection | rc.2 folds mid-conversation tool additions from the whole log while a rewind cuts only the surface: after a withdrawal no `tool-addition`/`tool-removal` block reaches the provider and the current declarations stay complete | `compat-tool-updates` I9 |

## Verified-compatible surfaces (probes pass)

- **compaction transactions**: `toolPairingBalancedBefore/After` stays balanced after a marker cut; the real `/compact` command (`command-compact` + `compaction-basic`, stub summarizer) can land `compaction/start…end` on top of a rewind marker and stay replayable; `/compact` is a legal no-op on a small surface.
- **tool-update history (`0.1.7-rc.2`)**: `Session.toolHistory()` folds the full append-only log, so a withdrawn `tool-addition` stays recorded after a rewind; `projectToolUpdates` drops every update whose message left the request and falls back to the complete current declarations. Pin: `tests/compat-tool-updates.test.ts` (on-surface projection, then the post-rewind fallback).
- **session-stats**: the `user/message` marker adds no step (the step count stays at the real turns' steps), no phantom turn.
- **session-title / goal fold**: a marker does not disturb `foldSessionTitle` / `foldGoal`.
- **plan-mode**: the marker is a turn-less `user/message` (no phantom turn); a rewind never touches the log-only `plan/mode` state (plan mode stays active; the user leaves it with `/plan off`) and the log stays replayable (`compat-invariants` I1/I3 marker + `plan/mode` probe, `verify-host`).
- **agent-loop cancellation**: `finally` guarantees step/turn closure; the rewind force-stop path leaves no dangling frame.
- **settings card (`0.1.7-alpha.1`)**: the card declares `configForms` as a module-level inject (the web profile always composes `ui-settings`), stages through the harness's own `SettingsFormModel` + `SettingsForm`, and registers into `plugins.bundle.config` keyed by the bundle package name; it reads that shared per-entry form's snapshot and writes through its revision-fenced `mutate`, disposing the model's subscription with the fiber. The host half declares the bundle's page policy (`configure({ auto: false }, ctx.fiber)` inside a `ctx.inject(['settings'])` child, per the dsh-settings README), opting the entry out of a client-built schema page. Pins: `verify:host` (`the bundle declares its own config page`), `tests/client-settings-card.test.ts` (staged plan, refusal, subscription release), `tests/client-lifecycle.test.ts`.
- **client session ownership (`0.1.6-alpha.2`)**: `SessionListState.current` / `currentAddress` are gone; main-view ownership is read from the row's `retainedBy.mainView` label — what `ui-workspace` retains the open session with. Pin: `tests/client-refill.test.ts`.
- **client pending input (`0.1.6-alpha.2`)**: `SessionSnapshot.queue` and the host `queue-mirror` are gone; pending steering rows come from the session's own `inbox` projection, and only USER-sourced `next-step` rows are retractable (the removed mapping was `source.kind === 'user' ? 'steering' : 'context'`). Pins: `tests/pending.test.ts`, `tests/client-retract.test.ts`.
- **client settings slot (`0.1.6-alpha.2`)**: `settings.plugin.item` is gone; the configuration form registers into `plugins.bundle.config`, keyed by the bundle package name. Pin: `tests/client-contract.test.ts`.
- **`agent/created` lifecycle guard**: the session-format reconcile runs on the alpha line's `agent/created` (fire-and-forget); pin: `verify-host` 4e dispatches it.
- **marker vs `/compact`**: the checkpoint shape is unchanged on this line — a `user/message` replace (`surfaceOp {replace, startSeq, endSeq}` + `sourceEventSeqs`); `assistant/message` still cannot carry `sourceEventSeqs`.
- **`image/offload` projection**: the alpha line's first `SessionMessageProjection` changes derived content without touching surface node membership; candidate listing and target resolution tolerate it. Pin: `tests/image-offload-projection.test.ts`.
- **session-cwd**: the fs tools no longer canonicalize a parent-traversing cwd, so `src/session-cwd.ts` returns `header.cwd` verbatim. Pin: `tests/session-cwd.test.ts`.
- **startup admission (`0.1.7-rc.1`)**: the gate reads the manifest's own `@deepseek-ai/dsh-*` peers and requires each to satisfy the runtime with `includePrerelease`; it runs for a profile bundle and again for every row its patch inserts, and a denial skips the bundle or disables the row. This plugin's declarations all satisfy `0.1.7-rc.2`, so it is admitted with no exemption — a skipped bundle on a later line is a peer mismatch, not a load failure.

## Known behavior boundaries (deterministic differences, non-crash, documented)

- **session-stats / session-telemetry fold the full log**: post-rewind stats do **not** rewind — `turns`/`steps`/`llmMs` still include withdrawn content; the `user/message` marker is folded as a present user turn (it adds no step). This is the intended "fold the full log" semantics, pinned by probe.
- **token-meter usage anchor stays stable** (G3): the `user/message` marker carries no usage, but because it is not an `assistant/message`, the baseline anchor does not drop to a heuristic estimate — it stays `usage` across a rewind. Pinned by `compat-gaps` G3.
- **marker content is the constant `(empty message)` placeholder**: never empty, because the session log is immutable but the model serving a session may change later — a strict OpenAI-compatible gateway rejects an empty user message (HTTP 400, Issue #21). The marker is a small visible user turn in derived history. Pin: `verify-host` (`marker is a user/message with the dsh-rewind producer source and the (empty message) placeholder`).
- **marker shape (v4)**: the replace `surfaceOp` is `{ op: 'replace', startSeq, endSeq }` (renamed from `start`/`end` in session-format v3); the dsh-rewind source is the single producer-owned kind `{ kind: 'dsh-rewind' }`, declared by merging `MessageSourceMap` (v4 removed the catch-all `plugin` kind and rejects it on write). Two older shapes stay readable, because a stored marker is immutable: the released v3 wrapper `{ kind: 'plugin', plugin: 'dsh-rewind' }`, and the `plugin:dsh-rewind` form the v3→v4 conversion gives a producer its rename table does not know. The `user/message` + `sourceEventSeqs` shape and the `(empty message)` content are unchanged.
- **Withdrawn content stays searchable/exportable**: session-query full-text and `/export` read the raw log; a rewind cuts only the surface, so withdrawn messages remain (declared in the README).
- **Session title auto-regeneration**: the title derives from the surface, so an automatically-derived title may change after a rewind.
- **Files written but uncommitted in a cancelled turn**: a `both` rewind cannot restore them (tool side-effect timing; same as Claude Code).
- **Attachment files left after a message is shadowed**: attachment storage is not cleaned with the surface (`dsh-attachment-local` not installed, not automatically verified).
- **Rewind leaves plan mode untouched**: `/plan text` is two independent actions (enter plan mode + steer the message). Rewinding the message undoes only the message — the log-only `plan/mode` state stays active, and the user leaves plan mode with `/plan off`, which still commits after a rewind (the marker creates no open turn). Pin: `verify-host` plan checks (`plan rewind leaves plan mode active`, `/plan off after rewind turns plan mode off`), `tests/hidden.test.ts` `messageTextAt`.
- **Bundle card metadata is declared by the plugin, not by the manager (`0.1.7-alpha.1`)**: the manager still titles a bundle with `shortName(pkg.name)` and its raw `package.json` description when nothing else is declared, but it now reads plugin-owned resources first — `locale/<lang>.json` (`meta.title`/`meta.description`) through the package exports map, and an `icon` file relative to the manifest. This plugin declares both, so its card shows an icon and copy that follows the active language; only the fallback description remains mixed-language. Pin: `tests/package-layout.test.ts` (icon path/media/size and both dictionaries).
- **Synchronous Session history reads are deprecated** on this line (`snapshotEvents` / `eventAt` / `ownEvents`): existing calls may remain, new calls are prohibited. The plugin keeps its existing reads (turn anchor + candidate listing); the migration path is a `ctx.sessionProjections` projection unit or the async paged history read this line has not shipped yet — not a plugin-side index.
- **A peer version range is never enforced at runtime**, and a physical copy nearer than the host still wins (upstream profile-resolution lookup order: "a peer version range is not an additional resolver filter"; "a nearer physical candidate wins"). So the `@deepseek-ai/schemastery` peer floor *is* the availability guarantee for `.volatile()` (#40): a plugin directory or linked checkout left holding an older copy (e.g. the pre-3.18.2 devDependency) shadows the host's 3.18.4 and fails the top-level `Config` evaluation before the plugin loads. Floor pinned at `^3.18.4`.

## Upstream (harness) issues and the plugin's no-compensation stance

The plugin treats these as harness-side defects it does not compensate for. Each entry records
the harness issue, its current status, and the plugin's stance, so a future maintainer does not
"fix the wrong direction."

### RU-I18N (resolved on the 0.1.7 line): host command copy follows the user's language

> **Status**: the `locale` settings section is gone — the locale host half only calls
> `settings.configure({ auto: false })`, and the preference lives in the `locale` entry's own
> Config. The plugin reads that value through the settings service's descriptor read
> (`readHostLocale` in `src/index.ts` calls `settings.describe({ redactSecrets: true })`, the
> route the settings UI and the client's own locale runtime take) at mount — which is what the
> once-registered command descriptions carry — and again before each command renders, so the
> output follows a language switch without a remount. The read is best-effort: a missing
> method, a missing entry, or a throwing read stays on the neutral English default.
>
> **Client-side command-description i18n is still first-party-only**: DSH localizes host
> command descriptions through the client `locale` binding (`ui-commands`), but the
> description keys come from a **closed allowlist** (`HOST_FACES`: compact, export, feedback,
> goal, permission, plan). A command outside that set — every third-party plugin — is passed
> through verbatim, and no host command *output* is localized by the harness for anyone. This
> plugin's host dictionary is what carries both, in the language read above.
>
> **Plugin stance**: no compensation; the seam is the descriptor read above. The wrong direction
> is the earlier one — reading `settings.get('locale').preference` once inside an
> `ctx.inject(['settings'])` callback and assuming cordis ordered the locale section before it
> (it does not; the descriptors were baked in the English default, defect #28).

### R-OPENSTEP (rewind part resolved): an unclosed `step` in the log breaks token-meter replay

> **Situation**: once a step is left unclosed, replay rejects any later step activity, so
> manual `/compact` fails permanently and automatic compaction silently stays disabled (the
> `agent/pre-step` hook catches and warns). The conversation itself is unaffected — only
> compaction-basic measures tree-wide. DSH now auto-closes crash-left step/turn/tool
> boundaries at load (`interruptedTurnClosers`, consumed by
> `packages/core/agent-loop/src/index.ts:907`), so **the crash path is fixed**. The tree has
> exactly one `append('step/start')` producer, `agent-loop/src/agent.ts:303`; an unclosed step
> otherwise comes from a third-party plugin appending `step/start` through the public
> `Session.append`, or from a hand-edited log. After a crash resume, `turn()` opens a new turn
> (`agent.ts:277-283`) without closing the leftover step, so continuing the conversation trips
> the same check — a rewind is **not** the only trigger.
>
> **Rewind's part**: the marker is a `user/message` and appends no `step/start`, so a rewind
> no longer introduces the first trip-wire and the R-OPENSTEP rewind amplifier is closed.
>
> **Plugin stance**: no guard. A `hasOpenStep` + `planRewind` pre-refusal was implemented and
> misjudged on **real session logs** (normal rewinds refused, GUI verification broken), so it
> was reverted — do not re-attempt a plugin-side pre-refusal. The fix direction is upstream
> (token-meter recovery for unclosed steps), and the residual risk is accepted: that log is
> already abnormal.

### R-PROMPTCARD (resolved on the 0.1.7 line): the repeated `System prompt` card is filtered out of chat

> **Status**: `isVisibleChatNode`
> (`packages/client/ui-chat/src/client/contract/chat-visibility.ts`) drops `system-prompt`
> nodes — and the `permission` command — from the visible chat rows before the row is built,
> so a rewind on this line adds no prompt row at all; the durable events and the trajectory
> inspection keep them. #22, #31 and README known issue #4 no longer reproduce.
>
> **Plugin stance**: still no compensation. The DOM row-hiding seam (`hiddenSeqsOf`) covers
> withdrawn messages, where hiding is essential, not cosmetic.

### R-PANELKEYS: the panel keyboard stays the plugin's own

> **Situation**: on Web, Escape, Tab, the four arrows, and Enter without Alt are
> platform-reserved — inline in the shortcuts `bindingIssue` list, with no exported form — so
> neither a plugin nor a user may bind them and there is nothing to read and follow. `Menu`
> is the dropdown primitive, while the harness's command-option panel (`ui-commands`'
> popupSelect) renders `MenuSurface` plus its own controller with `role="listbox"`/
> `role="option"`. `ui-commands`' `settle()` also calls `focusComposer()` unconditionally
> after `await onSelect(...)`; its only early return requires replacing the popup binding,
> which needs the internal `segment` that business code cannot reach.
>
> **Decision**: the mode-selection and retract panels keep their own capture-phase
> Escape/↑/↓ handling — focus-independent, the shape the official command panel uses — and
> keep `role="dialog"`. The plugin neither renders `Menu` nor compensates the composer focus
> restore. Capture ownership is pinned by `tests/client-popover.test.ts`; the ghost-row walk
> exclusion is **not** pinned, and on the typed `/rewind` path Enter still needs a row to hold
> focus after the shell's focus restore.

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

✓ = probe passes; — = not applicable. Statuses and stances for the named findings live in the
sections above; G1 (surface classification via `foldSurface`), G2 (projection checkpoint) and
G3 (the confirmed-non-defect usage anchor on token-meter) all pass in `compat-gaps.test.ts`.
