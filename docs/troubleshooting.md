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
