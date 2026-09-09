# Rewind-marker update guide

> English | [中文](rewind-fix.zh.md)

## Applies to

- **DSH**: `0.1.2-rc.1`
- **dsh-rewind**: `0.9.0-alpha.1`, `0.9.0-alpha.2`, `0.9.0`, `0.9.1`

## Background

`dsh-rewind` rewinds **within the same session** — it never forks a branch. It also follows the conservative policy of **deleting no history** (the session log is an append-only audit trail): it only **appends a marker**, telling DSH "the model-visible conversation continues from this message; everything after it is rolled back". Older plugin versions wrote that **rewind marker** as a "ghost step frame", which worked reliably on DSH v0.1.2-rc.1 and earlier.

But DSH v0.1.3 (alpha) introduces a stricter **session-format validation**. We discovered ahead of time that the **rewind markers** written by older plugin versions **cannot be validated** under those stricter checks, so **a session rewound with `/rewind` may fail to open** when that line ships.

The plugin is prepared in two parts, both shipped in the new version:

1. **New rewind markers use the new shape** (forward) — this is a **correct, low-risk**, long-term change (see the [README](../README.en.md), the "How it works" section), and the new shape is fully compatible with **both old and new** DSH.

2. **The `/dsh-rewind-fix` command** (backward) — for **already-existing** old sessions, the plugin ships a convenient update command that translates those old markers into the new shape so the sessions are usable again.

This document covers mainly the **update command**.

## Warnings

1. **It directly edits the session log** — it rewrites old rewind markers into the new format. The design already handles the common cases safely (**multiple web windows**, **exit / restart**, **switching sessions**, **power loss**): it only touches **closed** sessions, locks and **backs up** each one before writing, **rolls back** on failure, and is **idempotent** (safe to re-run). It changes the marker only — it deletes no conversation content and **loses no information**.

2. **It resets the matching snapshot backups** — the format update renumbers event seqs, so a session that was **updated** has its snapshot backups (the lightweight backups used to **restore files** for "conversation and code") no longer match, and the plugin **clears** them. This only affects **file restore** (those sessions can't use snapshots to restore files); backups start recording fresh. Sessions that weren't updated keep their snapshots.

## Steps

### Step 1 · Confirm your versions

First confirm your DSH and plugin versions are in the "Applies to" range — it's a prerequisite. If either is out of range, the tool may be unavailable or behave differently. You can just ask the AI for your current DSH and dsh-rewind plugin versions and check they're in range.

### Step 2 · Back up manually (optional)

The command rewrites session files and clears some snapshots, so a backup is a good idea. The default data directory is `~/.dsh` (if you've set `$DSH_HOME`, use its value):
```sh
cp -r ~/.dsh/sessions          ~/.dsh/sessions.backup
cp -r ~/.dsh/rewind-snapshots  ~/.dsh/rewind-snapshots.backup
```
Or copy them anywhere convenient. You can also let the AI run the backup for you.

### Step 3 · Start a new session, or pick one that was never rewound

The command only handles **closed** sessions, and it can't run on itself. So:
- **Start a new session** — ideally send any message first to initialize the window so you can see the command's progress and output.
- Or pick a session that was **never rewound** (one that needs no update).

Then run the command **in this new session**, and it will update the old sessions that need it.

> Don't run it in a session that itself needs updating and is currently open — the command skips this session, and any other currently-open/in-use session.

### Step 4 · Preview the update scope

Type `/dsh-rewind-fix` in the composer and send it. It only scans, doesn't write. The editor locks while it runs, which is normal. **Don't switch session windows midway.** When it finishes, it reports how many sessions were scanned, how many will be updated, how many skipped, and how many failed. Confirm those are what you expect before moving on.
```
/dsh-rewind-fix
```

### Step 5 · Execute

Once you're sure, re-enter the command with `--apply` to actually run it:
```
/dsh-rewind-fix --apply
```
This really rewrites the session logs and updates the old markers, and **may take a few minutes**. Please let it finish — **don't switch to another session window or close DSH** while it runs: a session you switch to is **safely skipped** (no corruption, but it won't be updated this pass and you'll need to re-run). A session that fails stays as it was, unharmed, and can be updated again later. Sessions that are updated also get their matching **snapshot backups cleared**, so file restore to earlier messages is no longer available for them.

### Step 6 · Restart DSH and preview again

After the run, restart DSH, then **preview once more**:
```
/dsh-rewind-fix
```
If it says there are no more sessions to update, the markers are all current and the old sessions will open normally.

### Step 7 · Delete the backup after confirming (optional)

Use it for a while, and once everything works, delete the backup from step 2:
```sh
rm -rf ~/.dsh/sessions.backup ~/.dsh/rewind-snapshots.backup
```

## Notes

- The session logs are still v0 format; when DSH's later `v0 → v1 → v2` migration (in `v0.1.3`) arrives, if you've completed the `rewind` marker update, the markers themselves won't block it.
- Some sessions may still be blocked by an **unclosed turn** (a turn that was interrupted/cancelled and never wrote `turn/end`). Per the empirical analysis these are widespread and **unrelated to rewind** — they're a DSH-side issue and this tool doesn't handle them. **So updating the markers doesn't guarantee you can upgrade to the next DSH line.**
