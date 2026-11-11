# Architecture

How dsh-rewind is built: source layout, module layering, and the two flows that
do the work — rewind and checkpointing. The DSH interfaces behind these modules
are in `docs/harness-reference.md`; the durable formats are in `docs/format.md`,
the security model in `security-model.md`, and compatibility findings in
`docs/compat/audit.md`.

## Purpose

One thing: rewind a conversation **in place** to any earlier user message —
never forking a session or switching windows — with an optional Claude-Code-
style workspace file restore (`both` mode). No network, no git operations, no
credentials access.

## Module layering

The module map:

```
src/index.ts            host plugin: /rewind, /undo, /snapshot-auto-cleanup + checkpoint pipeline
src/rewind.ts           pure planning: target resolution, surface range, candidate listing
src/snapshot.ts         checkpoint store: dense manifests, first-touch capture,
                        restore/preview, retention/GC, whole-session cleanup
src/snapshot-format.ts  durable format: naming, meta/checkpoint codecs,
                        structural validation
src/snapshot-fs.ts      filesystem primitives: atomic JSON, streaming compares,
                        location pin, unsafe-target rejection
src/snapshot-cleanup.ts cleanup policy + config persistence + auto-sweep throttle
src/locales.ts          host i18n (t() renderer, HostKey)
src/client/index.ts     client entry: command decoration, mounts, locale, teardown
src/client/action.tsx   the ↶ button both mount paths share
src/client/mount.tsx    durable-row action: takes over the user/steering renderer
src/client/pending-mount.tsx  unclaimed-steering retract layer
src/client/pending.ts   pending-steering bubble ↔ inbox next-step (user-sourced) matching, pure
src/client/retract.ts   pending retract: queue removal + composer refill
src/client/rewind-flow.ts  executed rewind + composer refill
src/client/popover.ts   mode-selection popover, plus the pending-retract confirm
src/client/visibility.ts  snapshot-level hidden span (wraps the chat builder)
src/client/hidden.ts    Chat-snapshot readers and executed-rewind cut derivation, pure
src/client/candidates.ts  rewind candidate listing (rewindCandidatesOf), pure
src/client/host-api.ts  exact /api reads (preview, candidates)
src/client/settings-card.tsx  settings form on the bundle page (plugins.bundle.config)
src/client/locales.ts   per-language copy registry (LocaleNamespaceMap)
src/client/styles.ts    injected styles (dsh design tokens)
src/client/build-info.ts  client build identity (__DSH_REWIND_VERSION__ / __DSH_REWIND_BUILD__)
src/client/log.ts       client logger (namespaced, dsh-rewind.debug-gated)
scripts/build.mjs       esbuild: lib/index.js (host ESM) + lib/client.js (loader closure) + .d.ts
scripts/update-badge.mjs       regenerate the tests badge (CI only)
scripts/verify-host.mjs end-to-end host verification (checkpoint pipeline + restore + clear)
scripts/session-decode.mjs / session-encode.mjs  `.jsonl.zstd` codec (test fixtures)
tests/                  vitest suites (rewind / checkpoint / client / lifecycle / compatibility)
docs/                   maintainer docs: compat/, release/ subdirectories
assets/screenshots/     UI screenshots
cordis.patch.yml        bundle patch (mounts the dual-face plugin row)
package.json            dsh.bundle + dsh.client manifests, optional peerDependencies
```

`@deepseek-ai/*` dependencies stay external at build time: the DSH host resolves
them at runtime, so the published tarball does not carry them.

Two dependency rules keep the design testable:

1. **`rewind.ts` is pure** — no I/O, no `Session` dependency; everything
   derives from the event log + ordered surface, so the whole planning layer
   is unit-testable without a host.
2. **`snapshot.ts` is host-independent** — it talks to the disk through
   `snapshot-fs.ts` (plain `node:fs` primitives and a test-only restore-rename
   hook), and the on-disk shape lives in `snapshot-format.ts`, so the store is
   testable without the harness and the format is testable without the store.

## Rewind pipeline

```
↶ button / /rewind-plugin @<seq> both
  → handleRewind: parseRewindTarget + planRewind (target must be a
    user/message currently on the surface)
  → agent.cancel({ keepInbox: true }) if running; waitForAgentIdle
  → dropPendingSteering (next-step inbox only; queued messages untouched)
  → append the rewind marker = a user/message with surfaceOp
    { op: 'replace', startSeq, endSeq } over the target and every surface
    node after it (+ sourceEventSeqs = shadowed seqs)  [a single event]
  → if mode 'both': target seq → user/message.data.id →
    store.restoreAfter(messageId) + syncRestoreObservations
  → result text reports restored/deleted counts and every skipped/failed path
    (human copy, never parsed)
  → client: hides withdrawn rows through the Chat snapshot visibility input,
    refills composer with the target message's text
```

Key invariants:

- **The log is append-only.** The marker is the *only* mutation: it cuts the
  model-visible surface, never the raw history (search/export still see it).
- **The marker content is a constant `(empty message)` placeholder.** It carries
  the dsh-rewind plugin source and is a `user/message`, the only surface type
  that can cite the shadowed seqs (`sourceEventSeqs`) — `assistant/message` can
  no longer carry them (v2). It derives to itself, so it stays as a present
  user turn at the surface tail. The content is provider-independent and never
  empty: the session log is immutable but the model serving a session may
  change later, and a strict OpenAI-compatible gateway rejects an empty user
  message (HTTP 400, Issue #21).
- **No ghost step frame is needed**: the token-meter step machine ignores
  `user/message`, and the session invariant imposes no open-turn requirement
  on it, so the marker is appended while idle, outside any turn, as one event.
- **Restore is reconciled against the live disk** (the checkpoint plan), so
  repeated rewinds are idempotent and a target state that already matches is a
  no-op. A path whose directory no longer resolves to its checkpoint-time
  location is skipped and reported, never written through (see
  `security-model.md`).

### Marker format history

The current form is a `user/message` carrying a `surfaceOp.replace` over the
shadowed range, `sourceEventSeqs`, and the constant `(empty message)` content.
Earlier forms — a bare `assistant/message`, then a ghost turn frame — became
unreadable once v2 reserved surface `replace` to a node that cites
`sourceEventSeqs`; the `/dsh-rewind-fix` migration command rewrote them and was
removed in the `0.10.x` line.

## Checkpoint pipeline

```
agent/pre-step      message boundary: after claim and before the user messages
                    are appended, writes one dense manifest per user-sourced
                    message in the batch; the last is current.
tools/execute       first touch: for write / edit, before the body runs, a path
                    not yet in the current manifest gets a v1 row with its
                    pre-touch state.
load / GC           read meta, drop malformed/orphan manifests, retain the
                    bounded window, reclaim unreferenced versions; current
                    stays undefined until the next admitted step.
clearSession /      whole-session cleanup deletes the session directory
pruneStale          (new storage and old members), independent of references.
```

## Open directions

Ideas under consideration, not commitments:

- **Multi-process identity/lock**: the current in-flight guard is
  per-process; a cross-process exclusive lock would cover multiple host
  processes on one worktree.
- **Locale expansion**: copy lives in per-language dictionaries registered through
  `HOST_DICTS` / `CLIENT_DICTS`; adding a language is a dictionary plus its
  `locale/<tag>.json` metadata, with no wiring or test edits.
- **Composer re-send polish**: the target text is already refilled after a
  rewind; a first-class "edit and re-send" affordance is a small extension.
