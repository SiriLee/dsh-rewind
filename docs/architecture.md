# Architecture

How dsh-rewind is built: module layering, the rewind pipeline, the checkpoint
pipeline, the compatibility strategy, and the roadmap. The module map lives in
`AGENTS.md`; this document adds the wiring between the modules. The durable
on-disk format is specified separately in
`docs/format.md`, the security model in `SECURITY.md`.

## Purpose

One thing: rewind a conversation **in place** to any earlier user message —
never forking a session or switching windows — with an optional Claude-Code-
style workspace file restore (`both` mode). No network, no git operations, no
credentials access.

## Module layering

The module map is the one in `AGENTS.md` (`Layout at a glance`); this document
adds the wiring between the modules and does not repeat it.

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
  → append the rewind marker = a user/message with surfaceOp
    { op: 'replace', startSeq, endSeq } over every surface node after the
    target (+ sourceEventSeqs = shadowed seqs)          [a single event]
  → if mode 'both': store.restoreAfter(targetSeq) + syncRestoreObservations
  → result text carries machine tokens (impact=<n>, restore:/delete: lines)
  → client: hides withdrawn rows (data-dsh-rewind-hidden), refills composer
    with the target message's text
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
- **Restore is reconciled against the live disk** (`planRestore`), so repeated
  rewinds are idempotent and a rewind whose target state already matches is a
  no-op. A path whose directory no longer resolves to its commit-time location
  is skipped and reported, never written through (see `SECURITY.md`).

### Why the client hides rows

`surfaceOp: 'replace'` is **model-facing only**. The harness never consumes it:
every chat node's `match()` accepts `op: 'append'` alone, so a replaced range
stays in the transcript and the human still sees it. This is intentional on the
harness side — `dsh-session`'s surface contract states the surface serves the
model and the event log serves the human transcript, and its own policy for a
replaced range is to keep a compaction summary card. Hiding withdrawn rows is
therefore **this plugin's** responsibility, not a harness feature to wait for.

Two consequences shape the client code:

- **Anchors are not event seqs.** A row's `anchorSeq` may be fractional — the
  harness places some rows beside their event (`turn/end + 0.1` for a turn
  footer, `control - 0.1` for a process summary, `turn/end - 0.9` for an
  interrupted assistant). A cut therefore spans `[target, marker + 1]`, and the
  hidden set must be compared by exact `Set.has`. Flooring a seq before lookup
  left the "已停止" header and the per-turn action row on screen after a rewind.
- **The Turn rail is host-projected and rewind-blind.** Its marks come from the
  `turnOutline` projection, a pure `turn/start` fold that ignores `surfaceOp`
  and exposes no removal API. So a rewind leaves rail marks behind while the
  transcript correctly drops those Turns. `src/client/turn-rail.ts`
  reconciles them from the same withdrawn set: a Turn counts as withdrawn when
  any of its Turn-scoped rows was cut, and its mark is addressed by
  `data-index` — the rail array position — resolved through the same
  projection's ascending Turn order.

The rail is virtualized, so a mark can mount *after* a hide pass ran (scrolling
it into view). That is why the refresh subscribes to `turnOutline` alongside the
inbox projection: a projection change re-runs the pass, and a freshly mounted
mark is judged again.

### Marker format history

The rewind marker is written as form C (a `user/message` with a
`surfaceOp.replace` over the shadowed range, `sourceEventSeqs`, and the
constant `(empty message)` content). Earlier
plugin versions wrote shapes a newer harness no longer accepts:

- **form A** — a bare `assistant/message(turn=N, step=0)` with no frame.
- **form B** — a ghost turn frame: `[step/start][assistant/message][step/end]`
  inside a closed turn.

A/B became unreadable once v2 reserved surface `replace` to a node that cites
`sourceEventSeqs` (`assistant/message` can no longer carry them). The
`/dsh-rewind-fix` command rewrote form A/B in closed sessions to form C so a
newer harness accepts the log — it was a **temporary migration tool** (kept on
the `0.9.x` line) and is **removed in the `0.10.x` line**.

## Checkpoint pipeline (Claude Code before-backup model)

```
tools/execute        captureBefore: for write / edit, stage a raw byte copy of
                     the file's BEFORE state into the store's .pending/
                     (node:fs copyFile, never through a string);
                     subagent sessions are NOT tracked and get no rewind
                     surface at all (Claude Code alignment — the Harness
                     refuses generic Session RPCs for a subagent-owned
                     identity, so /rewind cannot execute there).
tools/post-execute   commitEntry: anchor = latest user/message seq; skip
                     failed calls; publish the staged bytes as the entry's
                     sidecar and write the metadata beside them — including
                     where the directory resolved (`realpath`), the location
                     pin a restore re-checks.
session/event        user/message boundary: reconcileTracked re-reads every
  (user/message)     tracked file and records a new before-backup for any
                     whose disk state changed since last seen — external
                     edits/deletions enter the record this way.
prune                keeps the newest 100 anchor groups per session, storing
                     identical before-content as in-place links that are
                     materialized before their group is dropped, never dropping
                     a group a non-terminal restore journal still references,
                     and recycles terminal restore journals.
pruneStale            cross-session auto-cleanup (default off): whole
                     long-inactive session dirs past the cutoff are removed;
                     the active session is never targeted (a subagent's tool
                     result never triggers the sweep — it owns no dir and would
                     claim that exemption).
```

## Compatibility strategy

- **Test-driven investigation**: `tests/compat-invariants.test.ts` /
  `compat-interop.test.ts` / `compat-gaps.test.ts` probe harness behavior and pin findings in
  `docs/compat/audit.md`; `scripts/verify-host.mjs` runs a real end-to-end
  rewind + `/compact` chain (the full check suite).
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
- **Locale expansion**: client/host copy is zh/en today; the copy layer
  (`src/locales.ts`, `src/client/locales.ts`) is already keyed for more.
- **Composer re-send polish**: the target text is already refilled after a
  rewind; a first-class "edit and re-send" affordance is a small extension.
