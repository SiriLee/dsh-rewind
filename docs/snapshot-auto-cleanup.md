# Snapshot cleanup

The plugin saves a backup of each file before it's edited, so you can rewind your
code to an earlier point. These backups are called **snapshots**, and they're
grouped by message and stored per session.

`/snapshot-auto-cleanup` helps you manage those snapshots — whether you want to
reclaim disk space from old sessions or clear the **current** session so its
rewind history starts fresh.

## What it does

**Automatic cleanup** (off by default): the plugin can remember which sessions
you've stopped using, and now and then remove their snapshots to keep disk usage
down. It never touches your active session, and it never touches your
conversation.

**Manual**: even with automatic cleanup off, you can run the cleanup yourself:

- `/snapshot-auto-cleanup run [--apply]` — preview, then actually remove the
  snapshots of sessions you haven't used for a while.
- `/snapshot-auto-cleanup run --current [--apply]` — preview, then actually
  clear the **current** session's snapshots. This resets its rewind history to
  "from now on" (your conversation is unaffected). If a turn is currently
  running, the plugin pauses it first, then clears.

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

The auto-cleanup switch and the idle-day cutoff live in the **dsh-settings configuration document**. View and edit them in the **Settings &gt; Plugins &gt; Plugin configuration &gt; Snapshot cleanup** panel (the auto-cleanup switch and the idle days), or view and set them with the `/snapshot-auto-cleanup` command:

<img src="../assets/screenshots/cleanup-setting.png" alt="Snapshot cleanup settings: auto-cleanup and idle days" width="600">

- `enabled` — whether automatic cleanup runs (default `false`).
- `maxAgeDays` — how many idle days before a session's snapshots are removed (default `30`). Only positive integers are accepted, so a broken setting can never delete everything.

## When automatic cleanup runs

When it's enabled, automatic cleanup runs in the background at most **once a
day** — and only after 24 hours have passed since the last cleanup. The clock is
saved to `<dsh home>/snapshot-cleanup-last-sweep.json`, so restarting the host
can't make it run early. To clean up right now instead of waiting, use
`/snapshot-auto-cleanup run`.

## Safety

- Only rewind **snapshots** are ever removed: a session's snapshot directory
  holds the before-write file backups plus their bookkeeping (staged captures,
  rescue copies, restore journals), and that is all the cleanup touches. Your
  conversation is never touched, and the plugin never rewrites or deletes your
  session history.
- Automatic cleanup never removes your **active** session's snapshots — only
  sessions that have been idle past the cutoff.
- `run --current` clears the current session's snapshots. This is one-way for
  that session's file-rewind history: you can't rewind code to before the clear,
  but your conversation stays intact, and the session starts recording fresh
  snapshots from now on.

## Known limitation

The plugin keeps the most recent **100 messages'** snapshots per session. If you
rewind or compact a lot in one long session, those 100 slots can be taken up by
messages that are no longer reachable, so you may find you can't rewind as far
back as you'd like. (Claude Code behaves the same way.) To get back to a clean
state, run `/snapshot-auto-cleanup run --current --apply` to clear the current
session and start fresh.
