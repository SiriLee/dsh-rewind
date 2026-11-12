# Compatibility audit (compat-audit)

> Method: **the tests are the audit**. The probes in `tests/compat-invariants.test.ts`,
> `tests/compat-interop.test.ts`, `tests/compat-gaps.test.ts`,
> `tests/compat-tool-updates.test.ts` and `scripts/verify-host.mjs` drive the plugin's real
> execution paths through the DSH subsystems' **real consumer paths** (real `@deepseek-ai/*`
> packages) and assert the invariants below; a probe failure is a finding.
>
> **Retention rule.** A finding records an upstream behavior the plugin works
> within, with its owner and impact named; a plugin defect is fixed, not listed.
> Upstream references use symbols and file names, never line numbers — they rot.
>
> **Boundary contract.** What the plugin owns, and why a boundary sits where it
> does, is in [design boundaries](../boundaries.md); this file records the
> compatibility findings against it.
>
> Targeted version: npm `@deepseek-ai/*@0.2.2-rc.2` (the last verified release).
> Source reference: the upstream [github.com/deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness).
> Version alignment: see `docs/release/release.md`.

## Seams at the targeted version

The plugin targets one channel and reads the targeted version's shape only (no
`Session.events` / `<textarea>` / legacy face branch).

| Seam | Implementation |
| --- | --- |
| Host session log | `session.snapshotEvents()` |
| Host working directory | `ctx.workingDirectory.ensure(agent)` — the base the fs tools resolve against |
| Client chat snapshot | `uiConversation` `chat` view (`chatSnapshotOf`) |
| Client composer refill | `conversation.input.setDraft` facade, else the `[data-composer-input]` DOM fill |
| Client image restore | `SessionFace.readAttachment` (complete `ImageAttachmentRef`) + `conversation.createDrafts(..., uploadImages)` |
| Client settings card | entry form via `ctx.configForms.get(entryId)` (`plugins.bundle.config`) |
| Client message action | default-priority chat-node entry takeover (row `actions` prop + `extraActions`); pending bubbles matched in the session DOM |

**Admission.** DSH reads `engines.dsh` alone when a manifest declares it, and the
`@deepseek-ai/dsh-*` peers only when it does not (both under `includePrerelease`), re-checking
every row the bundle's patch inserts. This plugin declares both, in sync, so the bound is the
adapted line: a runtime outside it is refused at load rather than admitted into unadapted code.

## Definition of "fully compatible" (invariants)

| Invariant | Meaning | Probe |
|---|---|---|
| I1 log replayability | A rewound log passes token-meter replay and `Session.create` (the resume-preflight validation) without throwing | `compat-invariants` I1, `compact-compat` |
| I2 surface consistency | After a cut, the surface has no duplicate nodes, every node exists in the log, the withdrawn target never returns, and `deriveMessages()` is legal | `compat-invariants` I2 |
| I3 step/turn structure | Client turn-tail ordering, unique `step/start` (real turns), no ghost turns; the `user/message` rewind marker adds no step frame | `compat-invariants` I3, `helpers.assertTurnTailOrdering` |
| I4 fold-service safety | stats / title / goal / projection fold a marker-bearing log without throwing, with predictable values | `compat-invariants` I4, `compat-gaps` G4 |
| I5 compact interop | A tool call orphaned by a cancelled turn is pair-balanced once shadowed by a rewind; a rewind across a compaction checkpoint is refused; rewind-then-compact stays legal | `compat-interop` I5, `compact-compat` |
| I6 tool pipeline | checkpoint capture (a dense manifest at `agent/pre-step`, first touch at `tools/execute`) and restore are correct for `write` / `edit`, and cancellation timing never hangs. (`str_replace_editor` is a standalone package for custom compositions and is mounted in no shipped composition, so it is not tracked; a composition that mounts it leaves its edits outside restore coverage) | `verify-host` 2–9 |
| I7 client ordering | A log carrying tool turns and rewind markers (a single `user/message` replace) satisfies the client builder ordering | `compat-interop` I7 |
| I8 runtime safety | `rewind` / `compact` combinations never leave a dangling step/turn frame | `compat-interop` R-OPENSTEP, `compact-compat` |
| I9 tool-update projection | `Session.toolHistory()` folds the whole log, so a withdrawn `tool-addition` stays recorded; after a withdrawal no `tool-addition` / `tool-removal` block reaches the provider and the current declarations stay complete | `compat-tool-updates` I9 |

## Findings

Each item starts with its owner and impact. Findings record upstream behavior
or deliberate design, not plugin defects; **plugin design** / **plugin scope**
labels mark choices, not limitations.

**U1 · Upstream constraint — the placeholder is all that reaches the model.**
`assistant/message` cannot carry `sourceEventSeqs` and no other carrier exists,
so a cut is a visible user turn with the constant `(empty message)` placeholder
(a truly empty user message is rejected by strict OpenAI-compatible gateways,
#21). **Impact:** that constant is the only thing that reaches the model context;
no behavioral side effect. **Stance:** no compensation; old marker shapes stay
readable.

**U2 · Upstream inconsistency — no user-row action slot; maintenance watch.**
Assistant rows have `conversation.chat.assistant-actions`; user / steering rows
have no counterpart, and an unread steering bubble has no component at all.
**Impact:** none on behavior — the durable action is injected through the row
entry's own `component` and `actions` row, closer to the official path and
lighter than a DOM pass. **Stance:** keep the takeover; reported upstream
(Discussions #8345).

**U3 · Upstream constraint — private seam, maintenance watch.**
`isVisibleChatNode` drives order, grouping, turn navigation and presentation but
is first-party-only. **Impact:** the plugin wraps the registered chat builder's
`create()` to mark the rewind span hidden; that private seam needs re-checking
when the builder changes, and DOM hiding was rejected as less standard. The only
display artifact is the Turn rail's unloaded mark; nothing else is user-visible.
**Stance:** keep the wrapper; no DOM fallback.

**U4 · Upstream issue — no plugin impact.**
The synchronous reads are deprecated with no in-process replacement; the paged
route exists only on the Remote surface. **Impact:** none — the plugin keeps the
deprecated reads under the grace period and adds no index. **Stance:** none;
revisit if the grace period ends.

**U5 · Plugin design — external-editor write, not a limitation.**
A restore writes through plain `node:fs` with the host user's existing
authority: the plugin is an external editor of the workspace, not the model's
tool path, so that is the correct primitive, not a missing host API. A
host with the observation policy enabled is kept current, best-effort, by
re-emitting `fs/observed`.

**U6 · Plugin scope — images only, no document attachments.**
Images are refilled through the supported `readAttachment(ImageAttachmentRef)`
contract plus the normal composer intake. Files have no such path: the harness
exposes no client-side file-bytes loader (file uploads are one-way), so a
`FileAttachmentRef` cannot be turned back into a `File` without guessing a
storage path. The plugin does not guess; this is scope, not omission.

**U7 · Archived upstream issue — no plugin impact.**
Crash-left steps are closed by upstream tail repair, and the marker adds no step
frame, so the plugin no longer amplifies this; a hand-edited / third-party log is
outside the contract. **Stance:** archived; no guard (a `hasOpenStep`
pre-refusal was reverted).

**U8 · Upstream limitation — shared by every command-seam plugin.**
`PopupSelectController.settle()` restores composer focus unconditionally, and
command descriptions are a closed allowlist while no host command output is
localized. **Impact:** any plugin using the command seam hits this; this plugin
keeps its own capture-phase panel and host dictionary. **Stance:** no
compensation.

**U9 · Upstream design — not plugin-specific.**
A nearer physical copy wins over a peer declaration, and a range is not a
resolver filter; `.volatile()` relies on the `schemastery` peer floor. **Impact:**
only an install that shadows an older copy is affected; true of any plugin.
**Stance:** keep the floor; never treat the range as enforcement.

**U10 · Upstream defect — no longer used, no plugin impact.**
`connection.rpc.handle` registers through the Connection owner's context, which
injects only `credentials`. **Impact:** none now — the two read-only queries use
exact `/api` routes and never read `owner.webServer`. **Stance:** no
compensation; reported upstream.

**U11 · Upstream constraint — display only, paged loading.**
`paginate` counts append-origin messages, not `visibility`; hidden rows keep
`hasMore` true. **Impact:** when the target predates the loaded window, the
transcript cannot show the target until earlier history is paged in — display
only, no data loss. **Stance:** no host patch; one manual load starts the
paging.

## Verification coverage

These are paths verified manually or not yet in CI, not known-broken behavior.

- **Real browser rendering**: the hidden span and the action's placement are tested at the
  logic level only; the rendered result is verified manually in a real engine, not in CI.
- **Workflow/jobs cancelled by a rewind**: statically confirmed only; log-only
  `job/registered` / `job/settled` carry the creating `toolCall` and a termination `cause`.
- **Providers outside the verification dependencies**: `dsh-attachment-local` (so image refill is
  manual), `dsh-session-telemetry-otel`, `dsh-session-query-sqlite` (mounted in the shipped
  profile; its index is configured `openAt: never`, so it is never opened) and
  `dsh-session-persistence-jsonl` (a real JSONL write round-trip needs the platform prebuilt
  `node-addon-system` flock addon).
- **Real LLM streaming / auto title (L2 stubbed)**, and
  **`session-reference`'s `SessionReferenceResolver.prepare`** (needs a full session-query
  service; its data base is already covered by the G1 probe).
- **Real HTTP carrier and browser authentication**: `verify-host` mounts the real
  `HostConnectionService` and drives the exact `/api` routes through its shared Fetch handler;
  the HTTP bridge, browser cookie authentication and the served page are verified manually on
  a live Web host, not in CI.
- **Policy-enabled restore sync**: the compensation is checked by its `fs/observed` emissions,
  not by a following write under the re-enabled policy.

## Deliberate semantics (no entry kept)

Correct by design, named only so a future maintainer does not re-investigate:

- **Post-rewind folds.** Stats and telemetry fold the whole log; the title
  re-derives from the surface; token-meter units fold an unmetered surface
  `replace` at zero delta, so their figures do not roll back after a rewind
  (pinned by G4).
- **State left alone.** A rewind leaves `plan/mode` and the working directory
  alone; withdrawn content stays searchable and exportable (the log is
  append-only, only the surface is cut); the bundle card's locale + icon are
  declared by the plugin and read by the manager.
- **Deprecated reads.** A `Session` handle's synchronous reads are deprecated but
  still usable.
