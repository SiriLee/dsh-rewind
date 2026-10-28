# Compatibility audit (compat-audit)

> Method: **the tests are the audit**. The probes in `tests/compat-invariants.test.ts`,
> `tests/compat-interop.test.ts`, `tests/compat-gaps.test.ts`,
> `tests/compat-tool-updates.test.ts` and `scripts/verify-host.mjs` drive the plugin's real
> execution paths through the DSH subsystems' **real consumer paths** (real `@deepseek-ai/*`
> packages) and assert the invariants below; a probe failure is a finding.
>
> **Retention rule.** Only two things are recorded: a behavior the harness could offer better
> and does not, or a defect the plugin must **not** compensate for. Correct-by-design behavior
> is not restated (the probes pin it; [Deliberate semantics](#deliberate-semantics-no-entry-kept)
> names it). Upstream references use symbols and file names, never line numbers — they rot.
>
> Targeted version: npm `@deepseek-ai/*@0.2.2-alpha.2` (the last verified release).
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
| Client composer refill | `conversation.input.setDraft` facade |
| Client image restore | `SessionFace.readAttachment` (complete `ImageAttachmentRef`) + `conversation.createDrafts(..., uploadImages)` |
| Client settings card | entry form via `ctx.configForms.get(entryId)` (`plugins.bundle.config`) |
| Client seat-button DOM | structural locate of the copy-`<button>` container (`actionsContainerOf`) |

**Admission.** DSH reads `engines.dsh` alone when a manifest declares it, and the
`@deepseek-ai/dsh-*` peers only when it does not (both under `includePrerelease`), re-checking
every row the bundle's patch inserts. This plugin declares both, in sync, so the bound is the
adapted line: a runtime outside it is refused at load rather than admitted into unadapted code.

## Definition of "fully compatible" (invariants)

| Invariant | Meaning | Probe |
|---|---|---|
| I1 log replayability | A rewound log passes token-meter replay and `Session.create` (the resume-preflight validation) without throwing | `compat-invariants` I1, `verify-host` 12/13 |
| I2 surface consistency | After a cut, the surface has no duplicate nodes, every node exists in the log, the withdrawn target never returns, and `deriveMessages()` is legal | `compat-invariants` I2 |
| I3 step/turn structure | Client turn-tail ordering, unique `step/start` (real turns), no ghost turns; the `user/message` rewind marker adds no step frame | `compat-invariants` I3, `helpers.assertTurnTailOrdering` |
| I4 fold-service safety | stats / title / goal / projection fold a marker-bearing log without throwing, with predictable values | `compat-invariants` I4, `compat-gaps` G4 |
| I5 compact interop | A tool call orphaned by a cancelled turn is pair-balanced once shadowed by a rewind; a rewind across a compaction checkpoint is refused; rewind-then-compact stays legal | `compat-interop` I5, `verify-host` 12/14 |
| I6 tool pipeline | before-snapshot capture/commit/restore is correct for `write` / `edit`, and cancellation timing never hangs. (`str_replace_editor` is an optional DSH package that stopped being a default tool in DSH 0.1.3, so it is not tracked) | `verify-host` 4–9 |
| I7 client ordering | A log carrying tool turns and rewind markers (a single `user/message` replace) satisfies the client builder ordering | `compat-interop` I7 |
| I8 runtime safety | `rewind` / `compact` combinations never leave a dangling step/turn frame | `verify-host` 13 |
| I9 tool-update projection | `Session.toolHistory()` folds the whole log, so a withdrawn `tool-addition` stays recorded; after a withdrawal no `tool-addition` / `tool-removal` block reaches the provider and the current declarations stay complete | `compat-tool-updates` I9 |

## Open items

Each is a gap the plugin cannot close on its side, with the stance that keeps a future fix
pointed the right way.

### U1 — a surface replacement must masquerade as a `user/message`

`assistant/message` forbids `sourceEventSeqs` (it embeds its provider stream) and no
non-conversational carrier exists, so the cut is a visible user turn whose content must be the
`(empty message)` placeholder — a truly empty user message is rejected by strict
OpenAI-compatible gateways (#21). **Ask:** a dedicated replacement/checkpoint event.
**Stance:** no compensation; the placeholder is deliberate and both legacy marker shapes stay
readable (a stored marker is immutable).

### U2 — no per-message action slot for user / steering rows

The ↶ button is a React portal located **structurally** in the row's own `MessageIconActions`
container; assistant rows have `conversation.chat.assistant-actions`, user / steering rows have
no counterpart. **Ask:** the symmetric slot, or publish the `data-chat-*` anchors with a
deprecation path. **Stance:** keep the portal; a locate miss degrades to "no button", never a
button on the wrong row. Pending-steering matching also keys on `data-message-attachments`,
which renders inside the `conversation.chat.user.content` Factory (still a descendant of the
row). Reported upstream: Discussions #8345.

### U3 — client row visibility is not an extension input

`isVisibleChatNode` already drives chat order, process grouping, turn navigation and process
presentation, but is first-party-only. **Ask:** a derived, recomputable visibility input at that
evaluation point.

**Workaround (current line):** wrap the registered `chat` view builder's `create()` and mark the
rewind span `visibility: 'hidden'` before `ChatSnapshotBuilder` computes `order`. Nodes stay in
the store for composer refill; there is no DOM hiding. The seam is private and the Turn rail is
still fed by the host `turnOutline`, so a fully hidden Turn remains an unloaded mark; U3 stays open.

### U4 — no in-process paged history read

`Session.eventAt` / `snapshotEvents` / `ownEvents` are deprecated ("existing calls may remain,
new calls are prohibited") with no in-process replacement: `page` + `follow` shipped only on
the client-facing Remote surface. A projection cannot answer the rewind question — "is this
message still on the surface?" is surface semantics, while projections fold the whole log.
**Stance:** keep the deprecated reads (turn anchor + candidate listing) under the grace
period; no plugin-side index. **Ask:** an in-process paged read, or document the Remote route.

### U5 — no supported file write-back primitive

A restore writes through plain `node:fs` (it must reach paths the fs service would refuse as
stale/absent), which the host's observation/version layer cannot see, so the next write of the
same file is judged stale (`FS_STALE_VERSION`); the plugin re-emits `fs/observed` to
compensate. **Ask:** a supported write-and-sync primitive. **Stance:** keep the compensation,
best-effort and per-file — it heals only what a restore itself broke, and `fs/observed`
semantics remain the risk to watch.

### U6 — the attachment bytes behind a withdrawn message (open question)

Upstream states attachments are never deleted (a reference model over session lineage would be
needed first) and nothing observes surface replacement; `dsh-attachment-local` is mounted in
the shipped profile but is not in this plugin's verification dependencies. **Stance:** request
a clarification; no plugin-side reclamation, no guess.

### U7 — a dangling `step/start` still breaks token-meter replay (upstream defect)

Crash-left boundaries are auto-closed at load (`interruptedTurnClosers`) and the marker adds no
step frame, so the original amplifier is closed; a leftover unclosed step (a third-party
`Session.append('step/start')`, or a hand-edited log) still makes replay reject later step
activity, so `/compact` fails and automatic compaction stays silently disabled. **Stance: no
guard** — a `hasOpenStep` pre-refusal was implemented, misjudged real logs, and was reverted;
the fix direction is upstream (token-meter recovery).

### U8 — command seam: focus policy and localized copy

`PopupSelectController.settle()` restores composer focus unconditionally after `onSelect` (no
supported suppression), and command-*description* localization is a closed allowlist
(`HOST_FACES`: compact, export, feedback, goal, permission, plan) while **no** host command
*output* is localized for anyone. **Stance:** no compensation — keep the own capture-phase
panel and the own host dictionary (locale read through `settings.describe({ redactSecrets: true })`).

### U9 — peer ranges are not enforced at runtime

A nearer physical copy wins over a higher peer declaration, and a peer range is not a resolver
filter, so the `@deepseek-ai/schemastery` peer floor is the real availability guarantee for
`.volatile()`: an older shadowing copy fails the top-level `Config` evaluation before the
plugin loads. **Stance:** keep the floor; never treat the range as enforcement.

### U10 — generic RPC route registration fails from a plugin scope

`connection.rpc.handle` registers its route inside
`owner.effect(() => owner.webServer.register(route))`; a plugin-scoped `owner` loses the
`webServer` inject inside that effect (`cannot get property "webServer" without inject`).
**Ask:** capture `webServer` outside the effect so RPC/Fetch registration works from a normal
plugin scope. **Stance:** register from the root context and dispose with the plugin; remove
the shim when upstream fixes it.

## Coverage gaps

- **Real browser rendering replay**: the visibility wrapper's logic is covered in tests, but the
  rendered result is verified in a real engine manually, not in CI — and 0.2.2 reworked the
  chat viewport and collapse motion, so re-check the hide + scroll behavior there.
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
- **Real Connection route registration**: `verify-host` uses a fake `connection` and calls the
  RPC handler directly, so the real `webServer` registration path is verified manually on a
  live Web host, not in CI.

## Deliberate semantics (no entry kept)

Correct by design, named only so a future maintainer does not re-investigate: post-rewind
stats / telemetry fold the whole log; the title re-derives from the surface; a rewind leaves
`plan/mode` and the working directory alone; withdrawn content stays searchable and exportable
(the log is append-only, only the surface is cut); the bundle card's locale + icon are declared
by the plugin and read by the manager; a `Session` handle's synchronous reads are deprecated but
still usable; the token-meter units fold an unmetered surface `replace` at zero delta, so their
figures do not roll back after a rewind (pinned by G4).
