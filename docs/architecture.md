# Architecture

How dsh-rewind is built: module layering, the rewind pipeline, the checkpoint
pipeline, the compatibility strategy, and the roadmap. The module map below is
the same one in `AGENTS.md`; this document adds the wiring between the
modules. The durable on-disk format is specified separately in
`docs/format.md`, the security model in `SECURITY.md`.

## Purpose

One thing: rewind a conversation **in place** to any earlier user message —
never forking a session or switching windows — with an optional Claude-Code-
style workspace file restore (`both` mode). No network, no git operations, no
credentials access.

## Module layering

```
src/
├── index.ts          host plugin: /rewind command + checkpoint pipeline
├── rewind.ts         pure planning: target parsing, surface-range plan,
│                     candidate listing, marker turn/step math
├── snapshot.ts       checkpoint store: disk before-backups, journaled restore,
│                     reconcile / continue / rollback, bounded prune
├── session-cwd.ts    session working-directory resolution (fs-tools rule)
└── client/           browser half: per-message ↶ button (portal bridge),
                     mode popover, hidden-span computation, candidate parsing,
                     locales, styles
```

Two dependency rules keep the design testable:

1. **`rewind.ts` is pure** — no I/O, no `Session` dependency; everything
   derives from the event log + ordered surface, so the whole planning layer
   is unit-testable without a host.
2. **`snapshot.ts` is host-independent** — it talks to the disk through plain
   `node:fs` plus injected seams (`DiskProbe`, `DeleteFile`, a test-only
   `crash` hook), so the store is testable without the harness.

The client never reads the DOM to derive rewind state; it consumes the host's
machine channels (see [Compatibility strategy](#compatibility-strategy)).

## Rewind pipeline

```
↶ button / /rewind @<seq> both
  → handleRewind: parseRewindTarget + planRewind (target must be a
    user/message currently on the surface)
  → agent.cancel({ keepInbox: true }) if running; waitForAgentIdle
  → dropPendingSteering (next-step inbox only; queued messages untouched)
  → append ghost step frame: step/start (turn = last started turn,
    step = that turn's next unused number) … marker … step/end
  → marker = empty assistant/message with
    surfaceOp { op: 'replace', start, end } over every surface node
    after the target (+ sourceEventSeqs = shadowed seqs)
  → if mode 'both': store.restoreAfter(targetSeq) + syncRestoreObservations
  → result text carries machine tokens (impact=<n>, restore:/delete: lines)
  → client: hides withdrawn rows (data-dsh-rewind-hidden), refills composer
    with the target message's text
```

Key invariants:

- **The log is append-only.** The marker is the *only* mutation: it cuts the
  model-visible surface, never the raw history (search/export still see it).
- **The marker is empty** (`content: []`, derives to `null` in the model
  context) so it renders nothing and enters no model context.
- **The ghost step frame exists for the token-meter**: replay requires every
  `assistant/message` inside an open step of the same `(turn, step)`; a bare
  marker appended while idle would throw on the next `measure()` and silently
  break `/compact`. The turn/step numbers are chosen so they can never collide
  with a future real turn (`markerTurnOf` / `markerStepOf` — see
  `src/rewind.ts`).
- **Restore is reconciled against the live disk** (`planRestore`), so repeated
  rewinds are idempotent and a rewind whose target state already matches is a
  no-op.

## Checkpoint pipeline (Claude Code before-backup model)

```
tools/execute        captureBefore: for write / edit / str_replace_editor
                     (mutating commands only), read the file's BEFORE state;
                     subagent edits are NOT tracked (Claude Code alignment).
tools/post-execute   commitEntry: anchor = latest user/message seq; skip
                     failed calls; write the before-backup to the store.
session/event        user/message boundary: reconcileTracked re-reads every
  (user/message)     tracked file and records a new before-backup for any
                     whose disk state changed since last seen — external
                     edits/deletions enter the record this way.
prune                keeps the newest 100 anchor groups per session and
                     recycles terminal restore journals.
```

## Compatibility strategy

- **Peer ranges as OR-union of DSH rc tuples** (`^0.1.0-rc.6 || ^0.1.1-rc.2`):
  npm's prerelease rules require the peer range to share the host's
  `[major, minor, patch]` tuple; `scripts/check-dsh-version.mjs` detects when
  a new tuple requires appending. See `docs/release/release.md`.
- **Test-driven investigation**: `tests/compat-invariants.ts` /
  `compat-interop` / `compat-gaps` probe harness behavior and pin findings in
  `docs/compat/audit.md`; `scripts/verify-host.mjs` runs a real end-to-end
  rewind + `/compact` chain (18 checks).
- **Stable machine channels for third parties**: `dsh-rewind-plugin/client`
  exports the pure hidden-span computation; withdrawn rows carry
  `data-dsh-rewind-hidden`; both are semver-protected
  (`docs/contract/client-contract.md`). DOM coupling is minimized to a small
  set of marked rows plus a structurally-typed slot registration.

## Roadmap

Ideas under consideration, not commitments:

- **Multi-process identity/lock**: the current in-flight guard is
  per-process; a cross-process exclusive lock (like the change-ledger
  competitors) would cover multiple host processes on one worktree.
- **Lazy-commit UX**: an explicit confirm-then-apply step (a pending state)
  to reduce mis-touch risk on in-window rewinds, which are inherently less
  reversible than forked branches.
- **Locale expansion**: client/host copy is zh/en today; the copy layer
  (`src/locales.ts`, `src/client/locales.ts`) is already keyed for more.
- **Composer re-send polish**: the target text is already refilled after a
  rewind; a first-class "edit and re-send" affordance is a small extension.
