# Snapshot auto-cleanup

The rewind store writes one on-disk `before` backup per tracked file change,
grouped by its anchor message. Snapshots are deduped within a session and capped
at the newest 100 anchor groups, but across sessions that are no longer active
the store can
still grow without bound. `snapshot-auto-cleanup` is an OPTIONAL global policy
(off by default) that removes the whole snapshot directory of a session that has
been **long-inactive** — untouched past a configurable idle cutoff.

It only ever removes the whole snapshot **directory** of a long-inactive session.
It never touches the active session's snapshots, never touches the conversation
log, and leaves snapshot data within the idle cutoff alone.

## Commands

```
/snapshot-auto-cleanup                  show status (enabled, max-age, config path)
/snapshot-auto-cleanup on|off           enable/disable the automatic sweep
/snapshot-auto-cleanup max-age <days>   set the idle cutoff (positive integer)
/snapshot-auto-cleanup run              dry-run: list what would be removed
/snapshot-auto-cleanup run --apply      actually remove those sessions
```

`run` is a manual escape hatch and works whether or not the automatic cleanup is
`on`. `run` defaults to a dry-run; add `--apply` to execute.

## Config file

The policy is persisted to `<dsh home>/snapshot-cleanup.json`:

```json
{ "enabled": false, "maxAgeDays": 30 }
```

- `enabled` — whether the automatic sweeps run (default `false`).
- `maxAgeDays` — how many idle days before a long-inactive session's snapshot dir is
  removed (default `30`; `0`/negative are rejected, so a broken config can never
  delete everything).

Override the path with the `DSH_SNAPSHOT_CLEANUP_CONFIG` environment variable.
The file is written only by the `/snapshot-auto-cleanup` command. A missing file
reads as the safe default (off); a missing or corrupt file makes a sweep
**fail-closed** (delete nothing) and log a warning, and is surfaced when you run
the command again.

## When it runs

The 24h window is anchored on a **persisted** last-sweep time
(`<dsh home>/snapshot-cleanup-last-sweep.json`), so a host restart does not reset
it: the auto-sweep checks **once per process run**, on the first session
activity of a window (a user message or a completed tool call), and cleans only
when enabled **and** >=24h since the last sweep. It runs in the background and
never blocks the activity that triggered it. Because the check happens once per
run, a change that takes effect immediately is best applied with
`/snapshot-auto-cleanup run`; editing the config file by hand (or enabling after
the run's first activity) takes effect on the next run.

## Safety and boundaries

- Removes only whole **long-inactive** session dirs; the active session and the
  conversation log are never touched.
- "Inactive" is judged by mtime: a session still being written to keeps scrolling
  its newest member stamp forward, so it is never old enough to be pruned.
- Dedup `ref` links are session-relative, so removing a whole dir cannot dangle a
  link elsewhere.
- Trade-off: enabling auto-cleanup means a session resumed after a long idle gap
  will rewind only from its remaining (newest 100) anchors; its old snapshots are
  gone. The conversation log is never affected.
- Deleting the whole store dir manually stays safe (it is recreated on the next
  capture); auto-cleanup just scopes that removal to long-inactive sessions.
