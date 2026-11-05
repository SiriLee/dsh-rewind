# Security model

This document is the security model of **dsh-rewind** — how the plugin treats
untrusted input, what it is allowed to mutate, how it contains filesystem
writes, and how it survives crashes. It is derived from the implementation; if
this document and the code ever disagree, the code wins and this document is a
bug.

To report a vulnerability, use the [security policy](../SECURITY.md); this
document describes the guarantees behind that policy.

## Trusted boundary

The plugin runs in the DSH host process and therefore holds the host user's
filesystem authority — it reads and writes files with plain `node:fs`. The
following are treated as **untrusted inputs**:

- **Model arguments** — the `file_path` field of `write` / `edit` tool calls
  (it names the paths the checkpoint store records).
- **Session log contents** — events are parsed structurally; a hostile or
  malformed id must never escape the store root.
- **Current worktree state** — restore planning reconciles against the live
  disk, which anything may have changed.
- **Concurrent external modifications** — a restore never assumes the disk
  still matches its records.

The DSH host (and its other plugins) is trusted; this plugin does not re-verify
the host's own authority boundaries.

## Mutation gates

When snapshot backups are on, the plugin **automatically captures**
before-backups of tracked mutations, but **never automatically applies** one.
A workspace restore happens only through an explicit user action (the
per-message ↶ button or `/rewind`), and only when all of the following hold:

1. **A validated target** — a `user/message` seq currently on the session
   surface.
2. **A fresh plan** — derived from the current events and surface at execution
   time, never cached across events.
3. **Committed backups exist** — every planned action comes from a committed
   checkpoint entry anchored at or after the target.
4. **Live-disk reconciliation** — each entry is compared with the current disk
   and only actions that would actually change it are planned; an
   already-matching state is a no-op (restores are idempotent).
5. **Exclusive execution** — a per-session in-flight guard rejects concurrent
   rewinds; a running turn is cancelled (queued messages are kept) and
   quiescence is awaited before the surface is cut.
6. **Session binding** — the restore reads and writes only the rewound
   session's store, over paths that session's own tools touched.

**Concurrency scope:** the guard serializes concurrent *rewinds* of one session;
it does not stop other processes from changing the workspace. The plan is
reconciled against the live disk at plan time, with no re-validation before
apply, so a file changed in that window is overwritten by the restore. The
pre-restore state is captured at apply start, so a rollback still returns the
workspace to exactly that state, and per-file failures are reported rather than
hidden.

A failed gate fails closed: an invalid target, a missing store, an absent
backup, or a cancelled invocation aborts the rewind with an error. A store
written by a **newer** build is refused as a whole — no partial restore, no new
entry, and no automatic format-change clear — while the conversation rewind
still works. An explicit clear or the age-based sweep, being user-directed
deletion of whole session directories, is deliberately not version-gated.

**Automatic store deletion.** Two things delete session snapshots: the opt-in
`snapshot-auto-cleanup` sweep (off by default) removes whole directories of
long-inactive sessions; separately, a session's snapshots are cleared when the
session format has changed (a DSH upgrade), because the backups are anchored to
message positions that no longer line up. Both stay confined to the store root,
never follow a symlink out of it, never touch the conversation log, and the
sweep never targets the active session. The format guard runs before the clear,
so a store newer than this build is not cleared by it. See
[snapshot auto-cleanup](snapshot-auto-cleanup.md) and
[the store format](format.md).

## Conversation integrity

The session log is **append-only** — the plugin never deletes or rewrites
recorded history. A rewind appends a single marker event whose content is a
constant placeholder and whose surface operation replaces every surface node
after the target. The raw log (audit trail, search, `/export`) is untouched;
only the model-visible surface is cut, so the next request derives its context
from the target onward. The marker's constant content carries no untrusted text
into the model context, and the client hides the withdrawn span from the
rendered transcript. The marker shape is specified in
[architecture](architecture.md).

## Filesystem containment

- **Store root**: `<dsh home>/rewind-snapshots/` by default (`$DSH_HOME` feeds
  the base, `~/.dsh` is the fallback); the `snapshotDir` config overrides the
  whole path. The plugin reads no environment variable of its own. Deleting the
  root only removes file backups; the store rebuilds.
- **Path sanitization**: session and call ids are scrubbed to a safe character
  set before joining the store root; bare `.` and `..` are replaced — hostile
  ids cannot traverse out of the root.
- **Links are refused**: planning skips a path whose last component is a
  symlink or a hard link and reports it — a symlink would redirect the write
  outside the checkpoint, and a hard link would clobber every other name of the
  same inode. A link swapped in after planning is not re-checked.
- **Recorded locations are re-checked**: every record written by this build
  carries the directory location resolved at commit time; a restore re-checks
  it before touching the path, including after a restart. A directory that no
  longer resolves there is refused and reported; a missing parent chain is
  recreated only inside the recorded location. Data with no recorded location
  falls back to the link check. This matches Claude Code's checkpoint behavior.
- **Observation sync (best-effort)**: after a restore, the plugin re-emits the
  host's `fs/observed` event for the paths it changed (absent, or present with
  the current version), so a host with the observation policy enabled does not
  judge the next write against a pre-restore observation. It heals only the
  inconsistency the restore itself created; later external changes are still
  seen normally.
- **Restores name only recorded paths**: the store contains resolved display
  paths of the session's own write-class tool calls (plus boundary re-checks
  over that same tracked set) — a restore can never write an arbitrary path.
- **Path resolution**: relative paths resolve against the session's current
  working directory, read from the service the fs tools resolve through.
- **Bounded backups**: the store keeps a bounded number of anchor groups per
  session, except groups a non-terminal restore still references (pinned so the
  operation can be finished); the exact cap is in
  [the store format](format.md). Across sessions, the opt-in sweep removes
  whole long-inactive session directories and never targets the active session.

## Crash safety

- **Ordered commits**: a checkpoint writes the before-sidecar (a raw byte copy)
  before publishing the entry, so a crash can leave an unreferenced sidecar but
  never an entry whose bytes are missing. Every JSON write goes to a sibling
  temp file and is renamed over the target: a crash can leave only an inert
  `.tmp`, never a readable half-written file, and readers never pick up temp
  files.
- **Journaled restores**: before mutating anything, a restore captures each
  planned path's pre-restore state and persists an intent journal, then marks
  each action done as it is applied. A crash at any point leaves the journal on
  disk.
- **Disk is truth**: an interrupted operation keeps its journal, and recovery
  re-derives the true state from the real disk — which paths already match the
  goal and which are pending, can finish the operation, and can undo it to the
  exact pre-restore state. A journal whose goal is already reached auto-heals.
  The plugin never runs recovery on its own: an interrupted operation stays
  interrupted until an explicit caller resumes or undoes it.
- **Fail-loud vs fail-soft**: a corrupt journal is reported as
  `recovery-required`, never silently dropped — dropping it would erase the
  recovery record. Corrupt entries are ignored (they lose one backup, not the
  recovery path), and a missing or truncated sidecar fails only that file —
  never a delete of the live file.
- **Journal IO never fails the restore**: if the journal cannot be written, the
  restore proceeds with pre-journal semantics; crash safety degrades, behavior
  does not.

## Explicit non-goals

This section declares scope, not a gap list: each item names what stays outside
the plugin and what remains the host's or the user's responsibility. The
boundary contract is in [design boundaries](boundaries.md).

- It does **not** sandbox other processes or stop them from changing files
  concurrently.
- It does **not** provide confidentiality or tamper resistance against the same
  OS user: **store** files use the process default permissions under the
  process umask, and the host user remains trusted. Restored **workspace** files
  carry their recorded permission bits (a content restore reapplies them,
  best-effort), while a mode difference alone never triggers a restore.
- It does **not** exclude paths from the store, and it introduces no authority of
  its own: sensitive files (e.g. a `.env` the model may edit) and files outside
  the workspace the model may touch are backed up and restorable, unless over
  the size cap. Keeping a path out is a **DSH model-permission** concern, not a
  rewind feature.
- It does **not** touch git, make network requests, or access credentials.
- It does **not** roll back whole-log state: search, telemetry and `/export`
  still see withdrawn messages (by design; see [boundaries](boundaries.md)).
- It does **not** restore files written by a cancelled tool call that never
  committed a backup.
- **Subagent session edits are not tracked**: a subagent runs its own session,
  so its files cannot be restored by a rewind of the parent, and the plugin
  offers no rewind inside one. See [boundaries](boundaries.md).
