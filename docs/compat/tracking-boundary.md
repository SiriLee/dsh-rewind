# File-rewind tracking boundary

> When it rewinds files, the plugin **writes back only content it actually backed
> up**: a file changed by a write-class tool (`write`, `edit`) can always be restored
> exactly, while a stretch of state that **was not backed up** makes the restore
> **incomplete** — it prefers to do nothing rather than guess.
>
> This document describes how it works, the two known limitations that follow, and
> why they are accepted. All of it is a **deliberate trade-off** (matching Claude
> Code's checkpoint semantics), not a defect.

## 1. The two modes of file change

A file in DSH can change in exactly two ways, and the plugin observes them very
differently.

**The model calls a write-class tool** (`write`, `edit`): the call's arguments carry
the exact path, so the plugin can capture the file's current content **before** the
write lands. This path is deterministic — once handled, the file is certainly
restorable.

**An external edit** (a command-line Bash, a PowerShell write, a build script
rewriting files, or saving by hand in an editor): nothing declares the modified path
to the plugin, so **there is no object to capture in advance**; the plugin can only
discover it after the fact.

## 2. How it works

### One backup = the state when one message began

The plugin does not store the workspace's current state; it stores **state
transitions**. Every backup answers one question:

> **What was this file when that message began?**

Its content has two forms: `null` means the file **did not exist** (a restore then
deletes it), otherwise it is a full copy. Together these backups are the session's
**snapshot** (grouped by message). A backup belongs to **the user message that
triggered it**; within a single message's turn, every write-class tool call leaves a
backup of its own, and a restore takes the **earliest** of them.

### Where backups come from: the tracked list

The plugin does not scan the workspace; it follows one **tracked list**: a file joins
it as soon as a write-class tool handles it **once**; from then on, every new user
message makes the plugin re-check the files **on that list**; a file that never joins
it has no backup at all.

Backups come from two sources:

- **Before-write backup**: when the model calls a write-class tool, the plugin takes
  the current content **before** the change lands and stores it under **the user
  message that started this turn**;
- **Message-boundary re-check**: when a new message arrives, if a file on the list
  now differs from its **latest backup**, the current content is recorded as **that
  message's** backup. This is the only way an external edit gets backed up.

### Two cases where no backup is produced

- **Unchanged, not stored**: when the boundary re-check finds the disk identical to
  the latest backup, this re-check writes nothing; if a write-class tool edits that
  file later in the same turn, that before-write backup is still recorded. A message
  that changed no file therefore produces no backup of its own.
- **Over the cap, not stored**: before writing a backup, if a single file is found to
  exceed the size cap (8 MiB by default, adjustable via `DSH_REWIND_MAX_FILE_BYTES`,
  `0` disables it), the plugin **refuses the backup**; until that file is back under
  the cap, no new backup is written for it (the earlier backups remain).

### Restore: backups are the only standard

A restore reads nothing else in the workspace and infers nothing:

1. **Find the backup**: per file, take the **earliest** backup at or after the
   **target message**; when the target message has no backup of its own, look toward
   the later messages for the earliest one.
2. **Compare with the disk**: if it matches the current disk content, nothing is
   done; otherwise the backup's content is written back (a `null` backup deletes the
   file).

Looking toward later messages works because "unchanged, not stored" means the target
message began from the same state as its latest backup — so the earliest later backup
holds exactly that state (the premise being that nothing between the target message
and that backup went unrecorded; see limitation 2). Conversely, the nearest backup
*before* the target is not used because it may predate a **coverage gap** (limitation
2, case 3): writing it back would overwrite the current file with an older version.
**Restore less rather than write something wrong.**

### An example

| Msg | In the turn | File content | Backup: what it was when that message began |
| :---: | --- | :---: | --- |
| 1 | `write` creates it | `—` → `A` | `null` (the file did not exist before the write; backed up before the write and added to tracking) |
| 2 | — | `A` | `A` (the disk differs from the previous backup `null`) |
| 3 | — | `A` | (none: identical to the latest backup, and nothing was edited in this turn, unchanged, not stored) |
| 4 | `edit` | `A` → `B` | `A` (the content before that edit, a before-write backup) |
| 5 | `bash` rewrite | `B` → `C` | `B` (msg 4's edit had already taken effect, so the disk held `B` when msg 5 arrived) |

The disk now holds `C`. Rewinding gives: target 1 → the backup is `null`, the file is
deleted; target 2 → `A`; target 3 → no backup of its own, so looking toward later
messages finds msg 4's `A`, exactly the state msg 3 began from; target 4 → `A`;
target 5 → `B`.

## 3. Known limitations

Both limitations share one root cause: **a stretch of state was not backed up**.
Limitation 1 results in **no restore at all**, limitation 2 in an **incomplete
restore**.

### Limitation 1: history that never entered tracking — no restore

**Being handled by a write-class tool is the prerequisite for a file to join the
tracked list and produce backups.** Before that, every external edit it went through
has no backup, and neither source will write one for it. Two cases:

**Nothing in the session ever handled it.** Rewinding to any message can only report
"no restorable changes" for that file.

**Something handled it later (the more common case).** Backups exist only from that
moment on, so earlier history cannot be restored — in the example below, `v0` is
history the plugin has never seen:

| Msg | In the turn | File content | Backup: what it was when that message began |
| :---: | --- | :---: | --- |
| 1 | — | `v0` | (none: the file has not joined the tracked list) |
| 2 | a manual edit | `v0` → `v1` | (none: as above) |
| 3 | a manual edit | `v1` → `v2` | (none: as above) |
| 4 | `edit`, the first time it is handled | `v2` → `v3` | `v2` (before-write backup: the file joins the tracked list at this moment) |
| 5 | — | `v3` | `v3` (the disk differs from the previous backup `v2`) |

Rewinding to msg 5 → `v3`; to msg 4 → `v2`; and **rewinding to msg 1, 2 or 3 also
gives `v2`** — the earliest backup after them is msg 4's `v2`. `v2` really is the
content at the moment the file was first handled, but what those three messages began
from was `v0`, `v0` and `v1`; the plugin never saw them and cannot restore them.

### Limitation 2: a stretch of state that was not backed up — an incomplete restore

Both "unchanged, not stored" and "over the cap, not stored" leave a stretch of state
without a backup. When the target message has no backup of its own, the plugin looks
toward later messages for the backup; as soon as an **unrecorded change** happened
between the target and that backup, what it takes is no longer the state the target
message began from. The three cases below stack one more scenario each.

**Case 1: the change does not belong to any message yet**

| Msg | In the turn | File content | Backup |
| :---: | --- | :---: | --- |
| 1 | `write` creates it | `—` → `A` | `null` |
| 2 | — | `A` | `A` (differs from the previous backup `null`) |
| 3 | — | `A` | (none: identical to the previous backup, and nothing was edited in this turn) |
| (after) | a manual edit | `A` → `X` | (none: no new message has claimed it yet) |

Rewinding to msg 3: neither it nor anything later has a backup, the plugin does not
know the file changed, so it **does nothing and the file stays at `X`** (msg 3
actually began with `A`). To recover `A`, rewind to msg 2 — the backup under it is
`A`. A later message only makes the state **at that time** (`X`) rewindable; the `A`
msg 3 began from still cannot come back.

**Case 2: what is backed up is the state after the change**

| Msg | In the turn | File content | Backup |
| :---: | --- | :---: | --- |
| 1 | `write` creates it | `—` → `A` | `null` |
| 2 | — | `A` | `A` (differs from the previous backup `null`) |
| 3 | — | `A` | (none: identical to the latest backup) |
| 4 | a command changes it to `B` | `A` → `B` | (none: the disk was still `A` when msg 4 arrived) |
| 5 | — | `B` | `B` (differs from the previous backup `A`) |

Rewinding to msg 3 or 4: neither has a backup of its own, so looking toward later
messages finds msg 5's `B` — the state **after** the change, while they began with
`A`. The disk matches that backup, so the plugin does nothing and the file stays at
`B`; if the file changed again afterwards, the plugin writes `B` (overwriting
whatever is newer); and if the change in msg 4's turn had been a command **deleting**
the file, msg 5's backup would be `null` and rewinding to 3 or 4 would **delete the
current file**. The difference from case 1 is that a message followed this change and
recorded the state after it — in case 1 nothing was recorded at all.

**Case 3: the file exceeded the cap while it changed**

| Msg | In the turn | File content | Backup |
| :---: | --- | :---: | --- |
| 1 | `write` creates it | `—` → `A` | `null` |
| 2 | `edit` | `A` → `G1` | `A` (a before-write backup) |
| 3 | a write-class tool or an external edit | `G1` → `G2` | (none: over the cap, not backed up) |
| 4 | shrinks back to `B` | `G2` → `B` | (none: still over the cap on arrival, so the re-check skipped it) |
| 5 | `edit` | `B` → `X` | `B` (a before-write backup; tracking resumes) |

In the "small → big → small" scenario the stretch over the cap has no backup at all —
a **coverage gap**. Rewinding to msg 3 or 4 finds msg 5's `B`, so the plugin writes
`B`; the "big" state they began from falls inside the gap and can never be restored.
And if the file is currently over the cap, **no** target touches it: it prefers to do
nothing rather than write back an older backup.

## 4. Why these limitations are accepted

Removing **limitation 1** would require the plugin to know which files an arbitrary
command or external edit modified. Neither route works: having every external writer
declare itself (neither `sed`, nor build scripts, nor editors will), or tracking the
whole workspace and taking a whole-tree snapshot before every change — enormous in
volume, and precise workspace-level history is exactly the job of dedicated snapshot
tools such as Git. The plugin only does lightweight rewinding aimed at Agent tooling,
so this limitation stays.

Removing **limitation 2** would mean giving up "unchanged, not stored" and "over the
cap, not stored": every message boundary would have to record **every** tracked file
(changed or not), and large files would be backed up in full again and again. That
cost has two layers: storage grows linearly with the conversation, and messages that
change no file are the overwhelming majority; and every backup reads and writes a
whole file, so a very large one saturates disk IO (which is exactly why the per-file
cap exists).

What the two limitations buy is: lightweight, predictable, and **only ever writing
back content it actually backed up, never a guess**. For precise workspace-level
history, use Git.

## Background

This document was originally written for issue
[#5](https://github.com/SiriLee/dsh-rewind/issues/5) and completed for issue
[#39](https://github.com/SiriLee/dsh-rewind/issues/39). See also:
[SECURITY.md](../../SECURITY.md) · [Snapshot auto-cleanup](../snapshot-auto-cleanup.md)
