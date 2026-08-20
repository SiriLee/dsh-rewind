# Troubleshooting

[简体中文](troubleshooting.zh.md)

## History load failure: `…turn-tail… received an update before its start Match`

Versions `≤ 0.2.4` corrupted client replay when a rewind was **followed by further
conversation**: the marker's turn number collided with the next real turn's
`turn/start`, so reopening the session showed

```
Failed to load history: conversation Context …:turn-tail… received an update before its start Match (internal)
```

and the history vanished. Rewinds created from `0.2.5` on no longer produce the
collision, but **already-corrupted sessions need an offline repair** (the log is
append-only — it cannot be rewritten in memory).

The repair tool ships **inside the npm package** (`dsh-rewind-repair`) — no
source checkout needed:

```sh
# 1. Fully quit dsh web / host first (while a session is resident in memory,
#    a disk repair is overwritten by the next checkpoint)
# 2. Run the offline repair (scans every session under ~/.dsh/sessions,
#    rewriting each marker's turn back to the last started turn)
npm exec --yes --package=dsh-rewind-plugin -- dsh-rewind-repair
npm exec --yes --package=dsh-rewind-plugin -- dsh-rewind-repair -- --dry-run  # preview only
# 3. Restart dsh web — the repaired sessions load their history again
```

Or install it globally once (`npm i -g dsh-rewind-plugin`) and run
`dsh-rewind-repair` directly; from a source checkout the same tool is
`node scripts/repair-markers.mjs` (identical flags).

The tool only rewrites the `data.turn` of `dsh-rewind` empty-marker events
(keeping seqs, order, and the zstd frame structure intact), backs up the original
file to `session.jsonl.zstd.bak-<timestamp>` before writing, and never touches
any other event — safe to run repeatedly.
