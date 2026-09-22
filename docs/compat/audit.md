# Compatibility audit (compat-audit)

> Method: **the tests are the audit**. The probes in `tests/compat-invariants.test.ts`,
> `tests/compat-interop.test.ts`, `tests/compat-gaps.test.ts` and
> `scripts/verify-host.mjs` drive the plugin's real execution paths through the DSH
> subsystems' **real consumer paths** (real `@deepseek-ai/*` packages) and assert
> compatibility invariants. A probe failure is a finding; it enters the
> fix/pin/record loop.
>
> Targeted version: npm `@deepseek-ai/*@0.1.7-alpha.1` (the range the peers and `dsh.engines.dsh` declare).
> Source reference: the upstream [github.com/deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness).
>
> Version alignment: `peerDependencies` use one tuple per DSH line
> (e.g. `^0.1.2-rc.1`). npm's prerelease matching rules require a candidate to
> share the range comparator's `[major, minor, patch]` tuple, so a new DSH tuple
> replaces the peer tuple (single-line model). The range is conservative — it
> declares only what was verified, so a release already inside it changes
> nothing — unless it changes interfaces inside the tuple: `0.1.6-alpha.2`
> removed the client session-ownership and queue-mirror APIs, and
> `0.1.7-alpha.1` moved the session writer to format v4 (producer-owned message
> sources, tool-role results, `developer/message`) and replaced the settings
> namespace registry with each entry's volatile `Config`, so the peer floor and
> both plugin seams moved with them. Signal: `npm view @deepseek-ai/dsh dist-tags`;
> flow: `scripts/check-dsh-version.mjs` (it reads the `latest` dist-tag only; a
> prerelease published under another tag is a manual pre-release check).
>
> The plugin targets a single DSH version line; compatibility with earlier
> lines is not kept.

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

## Verified-compatible surfaces (probes pass)

- **token-meter replay** (the `user/message` marker + multiple rewinds + interleaved real turns + compact stacking).
- **compaction transactions**: `toolPairingBalancedBefore/After` stays balanced after a marker cut; the real `/compact` command (`command-compact` + `compaction-basic`, stub summarizer) can land `compaction/start…end` on top of a rewind marker and stay replayable; `/compact` is a legal no-op on a small surface.
- **resume replay**: `Session.create(id, events)` replays a rewind/compact-bearing log.
- **session-stats**: the `user/message` marker adds no step (the step count stays at the real turns' steps), no phantom turn.
- **session-title / goal fold**: a marker does not disturb `foldSessionTitle` / `foldGoal`.
- **client ordering**: turn-tail ordering + `step/start` uniqueness hold for tool turns + marker logs.
- **rewind across a compact checkpoint**: `RewindError('not-on-surface')` refuses cleanly, no crash.
- **plan-mode**: the marker is a turn-less `user/message` (no phantom turn); a rewind never touches the log-only `plan/mode` state (plan mode stays active; the user leaves it with `/plan off`) and the log stays replayable (`compat-invariants` I1/I3 marker + `plan/mode` probe, `verify-host`).
- **agent-loop cancellation**: `finally` guarantees step/turn closure; the rewind force-stop path leaves no dangling frame.
- **settings-card registration (`0.1.7-alpha.1`)**: `settingsScope` is gone with the namespace registry. The card declares `configForms` as a module-level inject (the web profile always composes `ui-settings`), stages through the harness's own `SettingsFormModel` + `SettingsForm`, and registers into `plugins.bundle.config` keyed by the bundle package name; it reads the entry's form snapshot and writes through its revision-fenced `mutate`, and disposes the model's subscription with the fiber.
- **client session ownership (`0.1.6-alpha.2`)**: `SessionListState.current` / `currentAddress` are gone; main-view ownership is read from the row's `retainedBy.mainView` label — what `ui-workspace` retains the open session with. Pin: `tests/client-refill.test.ts`.
- **client pending input (`0.1.6-alpha.2`)**: `SessionSnapshot.queue` and the host `queue-mirror` are gone; pending steering rows come from the session's own `inbox` projection, and only USER-sourced `next-step` rows are retractable (the removed mapping was `source.kind === 'user' ? 'steering' : 'context'`). Pins: `tests/pending.test.ts`, `tests/client-retract.test.ts`.
- **client settings slot (`0.1.6-alpha.2`)**: `settings.plugin.item` is gone; the configuration form registers into `plugins.bundle.config`, keyed by the bundle package name. Pin: `tests/client-contract.test.ts`.
- **client settings form (`0.1.7-alpha.1`)**: the same release retired the `settingsScope` bind (namespace registry) in favour of the shared per-entry form; the card now reads that form's snapshot and stages edits through `mutate`. Pin: `tests/client-settings-card.test.ts` (staged plan, refusal, and the fiber releasing the model's subscription), `tests/client-lifecycle.test.ts`.

- **`agent/created` lifecycle guard**: the session-format reconcile runs on the alpha line's `agent/created` (fire-and-forget); pin: `verify-host` 4e dispatches it.
- **marker vs `/compact`**: the checkpoint shape is unchanged on this line — a `user/message` replace (`surfaceOp {replace, startSeq, endSeq}` + `sourceEventSeqs`); `assistant/message` still cannot carry `sourceEventSeqs`.
- **`image/offload` projection**: the alpha line's first `SessionMessageProjection` changes derived content without touching surface node membership; candidate listing and target resolution tolerate it. Pin: `tests/image-offload-projection.test.ts`.
- **session-cwd**: the fs tools no longer canonicalize a parent-traversing cwd, so `src/session-cwd.ts` returns `header.cwd` verbatim. Pin: `tests/session-cwd.test.ts`.

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

- **Synchronous Session history reads are deprecated** on this line (`snapshotEvents` / `eventAt` / `ownEvents`): existing calls may remain, new calls are prohibited. The plugin keeps its existing reads (turn anchor + candidate listing); the migration path is a `ctx.sessionProjections` projection unit or the async paged history read this line has not shipped yet — not a plugin-side index. Not migrated in this release.

## Upstream (harness) issues and the plugin's no-compensation stance

The plugin treats these as harness-side defects it does not compensate for. Each entry records the harness issue, its current status, and the plugin's stance, so a future maintainer does not "fix the wrong direction."

### RU-I18N (resolved on the 0.1.7 line): host command copy follows the user's language

- **History (0.1.2–0.1.6 lines)**: the plugin resolved `activeLocale` in an
  `ctx.inject(['settings'])` callback that read `settings.get('locale').preference`
  **once, with no retry** (`src/index.ts`), while `dsh-client-locale`'s host half registered that
  `locale` settings section through its own `ctx.inject(['settings'])`
  (`packages/client/locale/src/index.ts`). Both callbacks wait only on `settings` and are
  independent of each other, so cordis made **no ordering guarantee** between the section
  registration and the plugin's read; a probe confirmed the read could see `undefined`, leaving
  every host-side `t()` string (runtime messages and command descriptions alike) in English.
- **Resolution (0.1.7)**: the section is gone — the locale host half now only calls
  `settings.configure({ auto: false })`, and the preference lives in the `locale` entry's own
  Config. The plugin reads that same value through the settings service's descriptor read
  (`readHostLocale` in `src/index.ts` calls `settings.describe({ redactSecrets: true })`, the route
  the settings UI and the client's own locale runtime take) at mount, which covers the
  once-registered command descriptions, and again before each command renders, so a language
  switch needs no remount. The read is best-effort: a missing method, a missing entry, or a
  throwing read stays on the neutral English default.
- **Client-side command-description i18n is still first-party-only**: DSH localizes host command
  descriptions through the client `locale` binding (`ui-commands`), but the description keys come
  from a **closed allowlist** (`HOST_FACES`: compact, export, feedback, goal,
  permission, plan). A command outside that set — every third-party plugin — is passed through
  verbatim, never translated (`builtinRowFace` only rewrites a description that equals the
  first-party English copy), and no host command *output* is localized by the harness for anyone.
  This plugin's host dictionary is what carries both, in the language read above.

### R-OPENSTEP (rewind part resolved): an unclosed `step` in the log breaks token-meter replay; the rewind no longer compounds it

> **Root cause (harness-side)**: an unclosed step left by a crash makes token-meter replay
> reject any later step activity. DSH `0.1.1-rc.2` now auto-closes crash-left step/turn/tool
> boundaries at load via `interruptedTurnClosers` (`dsh-session`, consumed by
> `packages/core/agent-loop/src/index.ts:907`) — **the crash path is fixed**.
>
> **Plugin guard (attempted and reverted)**: a `hasOpenStep` + `planRewind` pre-refusal was
> implemented (`open-step`) but misjudged on **real session logs** (normal rewinds refused, GUI
> verification broken), and was reverted (`177ec14`). Conclusion: **the plugin sets no guard**,
> accepting residual risk (an unclosed step produced by a third-party plugin can break
> `/compact` — that log is already abnormal, and continuing the conversation triggers the same).
> The fix direction is in the harness (token-meter recovery for unclosed steps), not the plugin.

#### Concrete `step/start` trigger paths (source-confirmed)

The tree has exactly **one** `append('step/start')` producer: `packages/core/agent-loop/src/agent.ts:303`
(no other producer inside the official packages; `session/end-seed` etc. only truncate torn writes,
not logically-unclosed steps).

| # | Trigger path | Plausibility | Basis |
|---|---|---|---|
| P1 | **Abnormal process termination**: `step/start` is batched to disk (write-behind, `maxDelayMs` per batch) → the step is mid-execution (LLM stream/tool, seconds to minutes) → SIGKILL / OOM-kill / power loss / WSL hard-close → `step/end` (in `finally`, only runs while the process is alive) is never persisted | **Most realistic** | `agent.ts:313` finally; write-behind batching; torn-write fix truncates only a half-written line |
| P2 | **Third-party plugin bug**: only the official agent-loop produces one, but external plugins may `session.append('step/start', …)` and never close it | possible | public `Session.append` |
| P3 | **Manual session-file editing**: edit `~/.dsh/…/session.jsonl[.zstd]` (zstd needs decompress/recompress; plaintext config edits directly) | possible but laborious | `persistence-jsonl/format.ts` (`JsonlCompression = 'zstd' \| 'none'`) |
| P4 | **append itself failing**: `append('step/end')` in `finally` throws (payload is plain numbers, nearly impossible) | theoretical | `agent.ts:313` |

**Amplifier (rewind is not the only trigger)**: after a crash resume, agent-loop `turn()` opens a
new turn at `phase.turn + 1` (`agent.ts:277-283`) **without closing the leftover step** — so
"continue the conversation" (a new `step/start`) trips the same token-meter check. Scope:

- **The conversation itself is unaffected** (the request path does not call `tokenMeter.measure`; only compaction-basic does tree-wide).
- **Manual `/compact` fails permanently** (`compactNow`'s first `measure()` throws the raw error).
- **Automatic compaction silently stays disabled** (the `agent/pre-step` hook catches and warns; the conversation continues).
- **rewind's role (resolved)**: the v2 `user/message` rewind marker appends no `step/start`, so a rewind no longer introduces the first trip-wire and the R-OPENSTEP rewind amplifier is closed. The harness-side root cause (an unclosed step after a crash, tripped by continuing the conversation) remains.

### R-PROMPTCARD (not compensated): the `System prompt` card repeats at every new request series

> **Root cause (harness-side, by design since 0.1.2)**: Chat renders a collapsed `System prompt`
> card at every request-series start. Any surface mutation bumps `contentGeneration` (a positional
> `replace` — rewind, `/compact` — or a `SessionMessageProjection`, e.g. image offload), so the next
> request logs `request/header { reason: 'series' }`; a process restart logs `'resume'`. The client
> shows the card for every reason except `'change'`. The effective prompt is unchanged — only the
> card repeats. Triggers beyond rewind: `/compact`, restart/resume, projections, explicit
> `startsSeries`.
>
> **Upstream decision (deliberate, twice)**: `6ad01cbd8d` suppressed the repeat on `resume` (note
> `2026-09-03-resume-headers-do-not-repeat-system-prompts.md`, rejecting the card as a "lifecycle
> marker" that "incorrectly implies another prompt injection"); three days later `77b6b10c21`
> restored it — a resume/series header starts a visible request series. Locked by the `ui-chat` test
> `repeats an unchanged system prompt after a surface rewrite…`.
>
> **Plugin stance**: no compensation (README known issue #4). Display-layer hiding was analysed and
> rejected: the card node carries `data.text` but not its `reason`, and boundaries can coincide
> (rewind then restart/`/compact`), so exact attribution is impossible client-side. The only clean
> fixes are upstream (decouple boundary annotation from prompt display, or expose `reason`/visibility
> to third-party clients). The existing DOM row-hiding seam (`hiddenSeqsOf`) covers withdrawn
> messages, where hiding is essential, not cosmetic.

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

✓ = probe passes; — = not applicable. RU-I18N is resolved on the 0.1.7 line (see above);
R-OPENSTEP and R-PROMPTCARD are upstream issues the
plugin does not compensate for (see above); G3 is a confirmed-non-defect behavior pinned in
`compat-gaps.test.ts` (G1 surface classification via `foldSurface` and G2 projection checkpoint
both pass).
