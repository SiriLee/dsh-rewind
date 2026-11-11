# File-rewind tracking boundary

> When it rewinds files, the plugin **writes back only what its checkpoints
> recorded**: one dense manifest per user message. A file enters the
> record when a write-class tool (`write`, `edit`) first touches it; from then
> on every retained checkpoint carries a row for it. Restores reconcile against
> the live disk and never guess.
>
> Because manifests are dense at every message boundary, a target normally has a
> row for every path tracked at that point. Recording has two kinds of gaps:
> history before a file ever entered tracking (Boundary 1), and the remaining
> gaps in the record (Boundary 2). These are current limits;
> the rationale is in [design boundaries](../boundaries.md).

## 1. What a checkpoint is

A checkpoint is the answer to one question:

> **What was every tracked file when that message began?**

- **One checkpoint per user message**, including a steering message: DSH claims
  steering at a step boundary, appends it as a normal `user/message`, and it is
  a normal rewind target.
- **Dense**: the manifest holds a `path → state` row for every tracked path at
  that moment. It is not a delta against the previous message.
- **State** is either a reference to a version file (the exact bytes) or `null`,
  meaning the file did not exist at that point; restoring `null` deletes the
  file.
- **Content is shared**: a file whose content did not change reuses the same
  version across checkpoints. A new version is written only when the bytes
  differ.
- **Tracked list**: a path joins the list the first time a write-class tool
  touches it, and stays. The plugin does not scan the workspace, and a file that
  never joins the list has no checkpoint row.

## 2. When the record is built

**At the message boundary.** Before the step appends the message and before any
model call or tool runs, the plugin re-reads every tracked path and writes the
dense manifest for each user message in the claimed batch (steering included).
A file that changed since the previous checkpoint gets a new version now; an
unchanged file reuses its version. This is how an external edit — a Bash
command, a build script, an editor save — enters the record: the next message
boundary sees it.

**At first touch.** When `write` / `edit` targets a path that is not tracked yet,
the plugin records its state *before the tool body runs*: `null` for a file that
does not exist yet, otherwise its current bytes. That row is added to the
current message's checkpoint as version 1. A call that is denied or cancelled
before dispatch never reaches this point and records nothing; a tool that fails
or is cancelled after dispatch leaves the harmless pre-touch row.

**Not on unchanged edits.** Once a path is tracked, an edit does not create a
new row by itself; the next message boundary records the changed content. An
unchanged file produces no new version.

## 3. Restore: recorded state is the only standard

1. Resolve the target seq to its `user/message` event and then to that message's
   `id`; the checkpoint file is keyed by the id.
2. If the target message has **no checkpoint**, do nothing to files. The
   conversation rewind runs and the result reports `no file checkpoint`
   for the target.
3. Otherwise walk the **newest** retained checkpoint's key set (the current
   tracked set), so files created after the target and tracked later are
   included.
4. For each path, use the target checkpoint's row; if the target predates the
   path, use the **earliest later row** for it — the v1 fallback, i.e. its state
   just before the first touch.
5. Compare with the live disk. A matching file is a no-op; otherwise write the
   recorded version back (or delete for a `null` row). Only paths with a row are
   touched, and each write is an atomic replace in the target's own directory.

Repeated rewinds are idempotent: the plan is recomputed from the live disk each
time, and a file already at its target state is not touched. An interrupted
restore can be run again to converge.

A few paths are skipped and reported, not written: a final component that
is not one regular file (symlink, hard link, FIFO, device), a parent directory
that resolves somewhere other than its captured location, a restore whose live
file is over the size cap, and a path with no recorded row. Every skipped path is listed
with its reason, and every failed file is listed separately. A delete is not
blocked by the cap.

The comparison uses a `(size, mtime)` fast path before reading bytes. A tool that
sets a file's mtime backwards while keeping its size can therefore hide one
change from the comparison — the same trade-off Claude Code makes.

## 4. Boundary 1: history before a file ever entered tracking

**Being handled by a write-class tool is the prerequisite for a file to join the
tracked list.** Before that, every external edit it went through has no row, and
no later source writes one for it. Two cases:

**Nothing in the session ever handled it.** Rewinding to any message can only
report no restorable changes for that file.

**Something handled it later (the more common case).** Recording starts at the
first touch, so earlier history cannot be restored. In the example below `v0` is
history the plugin never saw:

| Msg | In the turn | File content | Row: what that message began with |
| :---: | --- | :---: | --- |
| 1 | — | `v0` | (none: the file is not tracked) |
| 2 | a manual edit | `v0` → `v1` | (none: as above) |
| 3 | a manual edit | `v1` → `v2` | (none: as above) |
| 4 | `edit`, the first touch | `v2` → `v3` | `v2` (the pre-touch state; the file joins the tracked list now) |
| 5 | — | `v3` | `v3` (the boundary sees the changed content) |

Rewinding to msg 5 → `v3`; to msg 4 → `v2`; and **rewinding to msg 1, 2 or 3
also gives `v2`** — the earliest later row is msg 4's pre-touch row. `v2` really
is the content at the moment the file was first touched, but what those three
messages began from was `v0`, `v0` and `v1`; the plugin never saw them and
cannot restore them.

## 5. Boundary 2: remaining gaps in the record

Every message-boundary manifest is dense: the target message has its own row for
every path tracked at that point. A path first tracked later gets its pre-touch
row (Boundary 1's first-touch state). The gaps that remain are these.

### Over the size cap

A tracked file above the cap (8 MiB by default, adjustable with `maxFileBytes`,
`0` disables it) produces no new version. At each message boundary the plugin
keeps the **previous row**. While the live file is over the cap, a restore skips
it and reports it. If it returns under the cap, a rewind to a message inside
the over-cap stretch restores the **last recorded state**, which may predate
that stretch — those bytes were never
recorded and are unrecoverable.

| Msg | In the turn | File content | Row |
| :---: | --- | :---: | --- |
| 1 | `write` creates it | `—` → `A` | `null` |
| 2 | grows past the cap | `A` → `G1` | `A` (over the cap: the previous row is kept) |
| 3 | another edit | `G1` → `G2` | `A` (over the cap) |
| 4 | shrinks | `G2` → `B` | `A` (over the cap when the message arrived) |
| 5 | `edit` | `B` → `X` | `B` (under the cap again: the boundary records it) |

Rewinding to msg 5 → `B`. Rewinding to msg 2, 3 or 4 → `A`, the last recorded
state; the `G1`/`G2` stretch is not in the record. While the file is over the
cap at rewind time, any target skips it and reports the cap.

A file **first seen** over the cap is not added to tracking at all, so it has no
row and does not appear in the preview's over-cap list.

### Checkpointing switched off

While `fileCheckpointingEnabled` is off (the configuration card labels this
"snapshot backups"), no new checkpoints or first-touch rows are written. Messages sent in that period have no checkpoint, so rewinding to
one performs only the conversation rewind and reports no file checkpoint. A file
first touched while off is not tracked; after re-enabling, the next message
boundary starts recording tracked files again. When a step or tool observes the
switch off, the current checkpoint reference is dropped; if it is turned back on
before any such observation, the off period is an unrecorded gap and a first
touch can only capture its post-off pre-touch state.

### Mounted mid-turn, or into a session with no checkpoint

After the plugin mounts, there is no current checkpoint until the next admitted
step. First touches in the rest of that turn
are skipped, so new files touched then do not enter tracking. Messages from
before the plugin's checkpoints existed — an old session, an old-format store,
or a fresh mount — have no checkpoint and restore no files.

### Mode-only changes

A permission-only change refreshes the `mode` stored in the row but does not
create a new version and does not trigger a restore. `mode` is reapplied only
when content is restored.

## 6. Other limits

| Limit | Effect |
| --- | --- |
| Outside the retention window | Only the newest 100 checkpoints are kept; older targets have no checkpoint and restore no files |
| Old history | Messages from before this store existed have no checkpoint |
| Subagents | A subagent runs its own session; its edits are not tracked by the parent, and there is no rewind inside it |
| Fork / new session id | A new session id gets an empty store and does not inherit file history |
| Symlinks and hard links | Not captured when first seen; a tracked path that later becomes a symlink, hard link or other non-regular file is skipped and reported on restore |
| Repointed parent | A parent directory that resolves somewhere other than its captured location is skipped and reported |
| Crash during restore | Each file is replaced atomically, but the pass is not one cross-file transaction; a crash can leave some files restored and others not. Running the same rewind again converges |
| Power loss | No fsync; the last checkpoint write can be lost, and the next boundary rebuilds it |

## 7. Why the boundary sits here

Checkpoints cover the agent's `write`/`edit` edits plus external changes to those
tracked files; workspace history beyond that belongs to Git. Why the split works
this way, and what a whole-tree store would cost, is in
[design boundaries](../boundaries.md).

The plugin writes back only recorded state and reports every path it leaves
alone; it does not guess unrecorded content. For permanent
workspace history, use Git.

## See also

[Design boundaries](../boundaries.md) · [Security model](../security-model.md) ·
[Snapshot auto-cleanup](../snapshot-auto-cleanup.md)
