# Troubleshooting

[简体中文](troubleshooting.zh.md)

## History load failure: `…turn-tail… received an update before its start Match`

Rewinds from `≤ 0.2.4` collided with the next real turn's `turn/start`, so reopening the session showed

```
Failed to load history: conversation Context …:turn-tail… received an update before its start Match (internal)
```

and the history vanished. Rewinds from `0.2.5` on no longer collide; already-corrupted sessions need an offline repair (the log is append-only). The repair tool (`dsh-rewind-repair`) is no longer shipped from v0.4.0 — install a pre-v0.4.0 release to get it (fully quit dsh web / host first, then):

```sh
npm exec --yes --package=dsh-rewind-plugin@0.3.3 -- dsh-rewind-repair
npm exec --yes --package=dsh-rewind-plugin@0.3.3 -- dsh-rewind-repair -- --dry-run  # preview only
```

It only rewrites the marker events' `data.turn` (seqs, order, and zstd frame structure intact) and backs up the original file before writing — safe to run repeatedly. From a source checkout of a pre-v0.4.0 tag: `node scripts/repair-markers.mjs` (identical flags).

## Known compatibility boundaries

Behavioral notes — none of these is a crash — verified by the compatibility
probe suites; the audit [audit.md](audit.md) is the source of truth and lists
the probes that pin each one:

- Session stats / telemetry do **not** roll back with a rewind.
- Withdrawn messages stay **searchable and exported** (`/export` and full-text
  search read the raw log).
- Session titles may **regenerate** (title derives from the current surface).
- Files written by a **cancelled tool call** (write happened, no snapshot
  commit) cannot be restored by "conversation and code".

**R-OPENSTEP** (harness-side, plugin does not guard): a session log carrying an
*unclosed* `step/start` (a crash before the agent loop's `finally` closed the
step) makes later step activity break token-meter replay, so `/compact` can
fail after a rewind. Harness `0.1.1-rc.2` fixes the crash path on load
(`interruptedTurnClosers`); a plugin-side up-front rejection was tried and
**reverted** (`177ec14`, false positives on real logs). Deep analysis:
[audit.md](audit.md) → R-OPENSTEP.
