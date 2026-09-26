# File-rewind tracking boundary

> This document describes the **tracking scope** and the **precision boundary** of
> file rewind: which files and which changes are recorded, which point in time a
> restore can reproduce, and why these boundaries are not extended further.
>
> In short: **a file changed by a write-class tool (`write`,
> `edit`) can always be restored exactly**, because the plugin captures the
> original content before the change lands. **A command-line or manual edit**
> enters tracking only after the file has been handled by a write-class tool once,
> and its entry lags one message behind, so such a change does not always align
> exactly with the message you rewind to. Every boundary here is a **deliberate
> trade-off** (matching Claude Code's checkpoint semantics), not a defect.

## Tracking scope: how the plugin learns that a file changed

A file in DSH can change in exactly two ways, and the plugin observes them very
differently.

**A write-class tool call (`write`, `edit`)**: the call itself hands over the exact
path, so the plugin can copy the file's current content into its backup directory
**before** the write lands. This path is deterministic — once handled, the file is
restorable, byte for byte, for text, binary, non-UTF-8 and CRLF alike, with the
original permission bits recorded as well.

**A command-line or manual edit** (`sed -i` in bash, a PowerShell write, a build
script, saving from an editor): nothing declares the modified path to the plugin,
so **there is no object to capture before the change**. The plugin can only
discover it after the fact, through two mechanisms: the **tracked list** (a file
joins it as soon as a write-class tool handles it), and the **message-boundary
re-check** (when a new user message arrives, every tracked file's current on-disk
content is compared with the latest entry; if they differ, the current content is
recorded).

## Entry semantics: one entry is the state at the start of one message

The plugin does not store the workspace's current state; it stores **state
transitions**. Every entry answers the same question:

> **What was this file when that message began?**

An entry is anchored to the user message that triggered it, and its content has
two forms: `null` means the file **did not exist** at that moment (a restore then
deletes it), otherwise it is a byte copy. Both sources match that semantics:

- **Before-write capture**: the content is taken **before** the `edit` lands — the
  state at the start of that message, before the change;
- **Boundary re-check**: the content is taken when the new message arrives — the
  state at the start of that message.

Several changes to one file within a single message's turn produce several
entries; a restore takes the **earliest** of them, i.e. the state at the start of
that message.

## Restore semantics: the earliest entry at or after the target

Rewinding to message *M* takes, per file, the **earliest** entry anchored at or
after **M** (the earliest anchoring message, and the earliest record time within
that message) and writes its content back to disk. The write is preceded by a
comparison against the disk: an already-matching file is left alone. Only files
that genuinely differ are touched, and repeated rewinds never overwrite again and
again.

Why not take the *nearest entry before* *M*? Because it may predate a stretch with
**no entries at all** — typically a file that exceeded the size cap, where the
plugin refused to back it up. Writing it back would overwrite the current file
with an older version. The trade-off here is: **restore less rather than write
something wrong.**

A "create → chat → chat → edit → command rewrite" conversation:

| Msg | In the turn | File content | Entry (the state when that message began) |
| :---: | --- | :---: | --- |
| 1 | `write` creates it | `—` → `A` | `null` (the file did not exist before the write) |
| 2 | — | `A` | `A` (the disk differs from the previous entry `null`) |
| 3 | — | `A` | (none: it matches the previous entry) |
| 4 | `edit` `A` → `B` | `B` | `A` (the content before that edit) |
| 5 | `bash` `B` → `C` | `C` | `B` (the content before the command ran) |

The disk now holds `C`. Rewinding to msg 5 yields `B`, to msg 4 yields `A`; msg 3
has no entry of its own, so the search moves forward to the earliest entry, msg 4's
`A` — exactly the state msg 3 began from; msg 1's entry is `null`, so the file is
deleted.

## Boundaries

### A file never handled by a write-class tool

Being handled by a write-class tool (`write`, `edit`) once is the prerequisite for
entering tracking. Before that, every command-line or manual change the file went
through has no entry, and rewinding to any message reports "no restorable changes"
for it.

A related case: when the model first handles a file that **already
exists**, that entry holds the content from **that moment**. A rewind can reach
that moment but nothing earlier — the plugin never observed that earlier history.

### External edits are recorded one message late

A write-class tool hands over the path before the change; a command-line edit has
no such step. It is discovered by the boundary re-check only when **the next user
message after the change** arrives, and that re-check records the content **at
discovery time** — the state **after** the change. The "state before the change"
therefore is not recorded under the message whose turn made it, but under **the
earlier message that already had an entry**.

Consequently, when the target message *M* has **no** entry of its own for the file
(its state at the start of *M* matched the previous entry, so no new entry was
written), the plugin takes "the state at the start of the earliest recorded
message at or after *M*". If every change within that interval was made by a
write-class tool, that state equals the state at the start of *M*; if one of them
was a command-line edit, that entry holds the state **after** the change, and the
restore lands on that later state instead. For example:

> Msg 2 records `A`; msgs 3 and 4 have no entry; during msg 5's turn a command
> changes the file to `B`, and msg 6's boundary re-check records `B`. Rewinding to
> msg 3, 4 or 5 all yield `B` (the state after the change), although each of them
> began with `A`; rewinding to msg 2 recovers `A`.

What you see then depends on later changes: when the disk already matches that
entry, the plugin does nothing; when the file changed again afterwards, it writes
that intermediate state; and when the change was a deletion while the file still
existed at the start of *M*, it **deletes the current file** — the same mechanism,
with `null` as the recorded content. To get the content from before the change,
rewind to the earlier message that records it: the content is always kept in the
backup, it is just that "rewind to *M*" does not necessarily land on it.

### Per-file size cap

If a file already exceeds the size cap before a write (8 MiB by default,
adjustable via `DSH_REWIND_MAX_FILE_BYTES`, `0` disables it), the plugin records
nothing and copies nothing: its state changes enter the record again only after
the file is back under the cap and the next message-boundary re-check sees it, and
a file never handled by a write-class tool does not enter tracking merely because
it is large. A restore has a second gate: a file currently over the cap is left
untouched — an older entry is never written over it.

## Design trade-offs

To cover a file that was never handled by a write-class tool, the plugin would have
to know which files an arbitrary command modified, which means whole-workspace
tracking and repeated whole-tree snapshots: enormous in volume, and exactly the job
of dedicated snapshot tools such as Git.

To make every message line up exactly with its own state, either every message
boundary would have to record **every** tracked file (changed or not), or every
command-line change would have to announce itself beforehand. Messages that change
no file are the overwhelming majority, so the cost is storage growing linearly
with the conversation.

The plugin accepts these boundaries in exchange for staying lightweight,
predictable, and **never writing wrong content**. For precise workspace-level
history, use Git.

## Background

Written for issue [#5](https://github.com/SiriLee/dsh-rewind/issues/5). See also:
[SECURITY.md](../../SECURITY.md) · [Snapshot auto-cleanup](../snapshot-auto-cleanup.md)
