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

Behavioral notes verified by the compatibility probe suites
([compat-audit.md](compat-audit.md)) — none of these is a crash:

- **Session stats / telemetry do not roll back**: whole-log folds count the
  withdrawn turns, and telemetry records the rewind's marker and ghost-step
  frame under the reused turn. Expected whole-log semantics.
- **Withdrawn messages stay searchable and exported**: rewind cuts only the
  model-visible surface; full-text search and `/export` still see the raw log.
- **Session titles may regenerate** after a rewind (title derives from the
  current surface).
- **Files written by a cancelled tool call** (write happened, no result, no
  snapshot commit) cannot be restored by "conversation and code".

**Defended — R-OPENSTEP**: a session log carrying an *unclosed* `step/start`
(abnormal log: a crash before the agent loop's `finally` closed the step, a
manual log edit, or a buggy third-party plugin). Since v0.4.1 the plugin
detects this in `planRewind` and refuses the rewind with a typed
`open-step` error (with repair guidance) instead of silently breaking
token-meter replay (and `/compact`) for the session. The refusal is live
detection — it never writes to the log — so **repairing the log restores
rewinds**: append the missing `step/end` (and `turn/end` if the turn is also
open) to the session file, or start a new session. Root cause is harness
crash recovery (resume opens the next turn without closing the leftover
step); tracked in the compat-audit.
