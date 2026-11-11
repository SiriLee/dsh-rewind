# Snapshot cleanup

The plugin records a **file checkpoint for each user message**, so a rewind can
restore the files a turn changed. Checkpoints live per session: one dense
manifest per message under `checkpoints/`, shared content versions under
`versions/`, and a `meta.json` marker. Together they are the session's
**snapshots**.

`/snapshot-auto-cleanup` helps you manage those snapshots — whether you want to
reclaim disk space from old sessions or clear the **current** session so its
rewind history starts fresh.

## What it does

**Automatic cleanup** (off by default): the plugin can remember which sessions
you've stopped using, and now and then remove their snapshot directories to keep
disk usage down. It never touches your active session, and it never touches your
conversation.

**Manual**: even with automatic cleanup off, you can run the cleanup yourself —
see [Commands](#commands) below.

## Commands

```
/snapshot-auto-cleanup                       show the current settings
/snapshot-auto-cleanup on|off                turn automatic cleanup on or off
/snapshot-auto-cleanup max-age <days>        how many idle days before a session's snapshots are removed
/snapshot-auto-cleanup run                   preview what the automatic cleanup would remove
/snapshot-auto-cleanup run --apply           actually remove those snapshots
/snapshot-auto-cleanup run --current         preview clearing this session's snapshots
/snapshot-auto-cleanup run --current --apply actually clear this session's snapshots
```

`run` always starts as a preview; add `--apply` to make the change. `run` works
whether or not automatic cleanup is on.

## Settings

The auto-cleanup switch and the idle-day cutoff are this plugin entry's own
configuration. View and edit them on the **Plugins** page, in this plugin's
configuration card, or with the `/snapshot-auto-cleanup` command:

<img src="../assets/screenshots/plugin-setting.png" alt="Plugin configuration card: snapshot backups and auto cleanup" width="600">

- `autoCleanupEnabled` — whether automatic cleanup runs (default `false`).
- `autoCleanupMaxAgeDays` — how many idle days before a session's snapshots are removed (default `30`). Only positive integers are accepted, so a broken setting can never delete everything.

## When automatic cleanup runs

When it's enabled, automatic cleanup runs in the background at most **once per
cadence** — one day by default (`autoSweepIntervalMs`) — and only after that gap
has passed since the last cleanup. The clock is
saved to `<dsh home>/snapshot-cleanup-last-sweep.json`, so restarting the host
can't make it run early. To clean up right now instead of waiting, use
`/snapshot-auto-cleanup run`.

## Safety

- Cleanup removes whole **session snapshot directories** — the per-message
  checkpoints, their shared versions, the `meta.json` marker, and any old-format
  snapshot members still sitting in that directory. New storage and old data are
  deleted together; nothing is parsed or migrated first. Your conversation is
  never touched, and the plugin never rewrites or deletes your session history.
- Automatic cleanup never removes your **active** session's snapshots — only
  sessions that have been idle past the cutoff.
- `run --current` clears the current session's snapshot directory; if a turn is
  currently running, the plugin pauses it first, then clears. This is one-way
  for that session's file-rewind history: you can't rewind code to before the
  clear, but your conversation stays intact, and the session starts recording
  fresh checkpoints from now on.

## Retention cap (by design)

Separately from cleanup, each session keeps only the newest **100 checkpoints**
(one per user message). Shared versions are retained while any of those
checkpoints references them and deleted once none does, so the on-disk cost
follows the changes that actually happened. If you rewind or compact a lot in one
long session, those 100 slots can be taken up by messages that are no longer
reachable, so you may find you can't rewind as far back as you'd like. (Claude
Code behaves the same way.) To get back to a clean state, run
`/snapshot-auto-cleanup run --current --apply` to clear the current session and
start fresh.
