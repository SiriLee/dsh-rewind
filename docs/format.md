# Durable format

The on-disk format of the dsh-rewind checkpoint store, pinned as a spec. The
implementation is `src/snapshot-format.ts` (naming and codecs), `src/snapshot.ts`
(lifecycle) and `src/snapshot-fs.ts` (byte-level guarantees); this document is
the reference for what readers may rely on and what a future incompatible change
must do. If the code and this spec disagree, the code wins and this spec is a
bug.

## State root

The store root defaults to `<dsh home>/rewind-snapshots/` — the dsh data
directory (`~/.dsh/rewind-snapshots/` when `$DSH_HOME` is unset, resolved via
`resolveDshHome`) — and is overridden by the `snapshotDir` plugin config. The
plugin reads no environment variable of its own. It is a sibling of the
workspace, never a subtree of it. Deleting the root only removes file
checkpoints and their versions; the store rebuilds from scratch.

```
<root>/
└── <sessionId>/                        # safeSessionId(sessionId)
    ├── meta.json                       # store format + DSH session format
    ├── checkpoints/
    │   ├── <safe(messageId)>-<hash8>.json
    │   └── …
    └── versions/
        ├── 3f2a1b2c3d4e5f60@v1
        ├── 3f2a1b2c3d4e5f60@v2
        └── 9c1e8d7f6a5b4c3d@v1
```

There is no `.pending/`, journal, rescue directory or persistent temp marker.
Old snapshot members may exist in the same session directory; this build never
reads them (see [Old data](#old-data)).

- `sessionId` is sanitized to `[a-zA-Z0-9._-]`; the bare values `.` and `..`
  are replaced (`safeSessionId`) so a hostile id cannot traverse out of the
  root.
- A checkpoint file is named from its message id:
  `safeFileId(messageId)` plus an 8-hex digest of the unsanitized id. The digest
  keeps two ids that sanitize to the same name (e.g. `a:b` / `a_b`) from
  colliding. Readers do not infer a message id from a file name.
- Version file names are restricted to `[0-9a-f]{16}@v[1-9][0-9]*`; every store
  path is joined inside the session directory and nowhere else.
- `hash8` is the first eight hex digits of SHA-256; `pathHash` in a version name
  is the first sixteen hex digits.

## `meta.json`

```jsonc
{ "store": 3, "sessionFormat": 4 }
```

- `store` is this plugin's store format. A value **above** the supported version
  makes the whole file store fail closed: nothing is read, written or restored,
  while conversation rewind keeps working.
- `sessionFormat` is the DSH session format (`session.header.version`) the
  manifests were anchored under. When it does not match the current session, the
  new storage is discarded.
- The file is written atomically (temp + rename) and is created at the first
  checkpoint, not for an empty session.

Load decision:

| On disk | Result |
| --- | --- |
| no session directory | empty store; nothing to do |
| no `meta.json`, but `checkpoints/` or `versions/` exists | discard the new storage and warn |
| unreadable `meta.json` (an IO/permission error, not absence) | load fails closed; nothing is discarded |
| corrupt or structurally invalid `meta.json` | warn; discard the new storage members (`meta.json` and any `checkpoints/` / `versions/`) |
| `store > 3` | mark the session unavailable (fail-closed); new storage is kept untouched |
| `store !== 3`, or `sessionFormat` mismatch | discard the new storage and warn; old members are untouched |
| valid and matching | load `checkpoints/`, prune orphans, retain 100, GC |

"Discard the new storage" removes exactly `meta.json`, `checkpoints/` and
`versions/`; it never touches old snapshot members.

## Checkpoint file

One JSON file per user message, named
`<safe(messageId)>-<hash8>.json`:

```ts
interface CheckpointJson {
  store: 3                    // must equal this store version
  messageId: string           // the DSH UserMessage.id; the lookup key
  time: number                // monotonic epoch-ms order key
  files: Record<string, FileState>
}

interface FileState {
  v: number                   // per-path version, positive, monotonic, never reused
  blob: string | null         // version file name; null = the file did not exist
  size?: number               // present exactly when blob is non-null
  mode?: number               // captured permission bits (0..0o7777)
  parent?: string             // parent-directory realpath at capture (location pin)
}
```

Semantics:

- **Dense manifest.** Every path tracked at that message boundary has a row.
  `files` is the tracked set at that moment, not a delta against the previous
  message.
- **What the manifest means.** It is the state at the moment the step that
  claimed the message was admitted — before the step appended the message and
  before any model call or tool ran. A path first touched later in that step is
  appended to the current checkpoint (the batch's last message) with its
  **pre-touch** state and `v: 1`; `blob: null` records a creation. An earlier
  message in the same batch recovers it through the v1 fallback. The manifest is
  rewritten atomically.
- **The key is the message id.** `agent/pre-step` runs before `user/message` is
  appended, so no seq exists at capture time. A reader maps a target seq to its
  `user/message` event, then to `data.id`, then to the checkpoint file.
- **`time`** is strictly increasing within a session and within one admitted
  batch. It orders the retention window and the v1 fallback; a reader sorts by
  `time`, then by file name for ties.
- **`files` keys are absolute paths** as resolved by the session's own
  write-class tool calls.
- **`blob`** names a version file; `null` means the file did not exist at that
  point, so a restore deletes it. `size` is present exactly when `blob` is
  non-null. `v` advances only when the recorded state really changes, and is
  retained across `null` rows so a delete-then-recreate never reuses an earlier
  version number.
- **`parent`** is the location pin: where `dirname(path)` resolved at capture,
  or where a missing directory would resolve (the nearest surviving ancestor's
  realpath plus the missing segments). This build writes it on every row. A row
  without a pin is structurally readable but not actionable: restore planning
  skips it with reason `parent`, and never follows it.
- `mode` never decides an action; a permission-only difference is a no-op. It is
  applied, best-effort, only when content is restored.

Restore semantics — the target row, the v1 fallback for a path first tracked
later, the traversal set, and the skip reasons — are specified in the
[file-rewind tracking boundary](compat/tracking-boundary.md).

### Validation

A checkpoint is parsed **all-or-nothing**: any malformed row drops the whole
checkpoint (a partially trusted manifest could plan a wrong action for a path it
does not describe). A checkpoint that fails parsing, or whose `messageId` is not
present in the session log (an orphan left by a crash between the checkpoint
write and the message append), is deleted on load.

Fields are validated as follows:

- `store` must equal `3`; `messageId` is a non-empty string; `time` is a finite,
  non-negative number; `files` is a plain object whose keys are absolute paths.
- `v` is a positive safe integer.
- `blob` is `null` or a string matching the version-name pattern. `size` must be
  absent when `blob` is `null`, and a non-negative safe integer otherwise.
- `mode`, when present, is an integer in `0..0o7777`.
- `parent`, when present, is a non-empty string.

Unknown JSON fields are ignored. A version file that is missing, not a regular
file, or whose `stat().size` differs from `size` is a per-file failure at
restore time — never a reason to write or delete.

## Version file

A version file holds the raw bytes of one path at one version:

- content is the file's bytes, stored verbatim (never through a JS string, so
  binary and non-UTF-8 content round-trips);
- the name is `<pathHash>@v<N>`, where
  `pathHash = sha256(absolutePath).hex().slice(0, 16)` and `N` is the `v` from
  the row;
- a version may be referenced by any number of checkpoints. The store writes it
  once and the manifests only hold the name;
- writing is a raw copy to `<name>.tmp` in `versions/`, followed by `rename`;
- the copy's size is recorded as `FileState.size`. A reader refuses a version
  whose size no longer matches.

Because content is shared, a checkpoint row that did not change reuses the same
`blob` from the previous checkpoint (refreshing only `mode` / `parent`); a new
version is written only when the content differs.

## Write guarantees

- **Atomic JSON.** Every checkpoint and `meta.json` write goes to a sibling
  `<target>.tmp` and is renamed over the target. A crash between the steps
  leaves only an inert temp — never a readable half-written target — and readers
  never select a `.tmp` file. A leftover temp is overwritten by the next write
  and collected by GC.
- **Atomic versions.** A version is copied to a temp file and renamed; a crash
  leaves an unreferenced temp or version, never a manifest pointing at bytes
  that were never written. A version is complete before a manifest references
  it.
- **Atomic restore.** A restore copies the version to `<target>.rewind-tmp` in
  the target's own directory, verifies the copied size, then renames over the
  target; the recorded `mode` is reapplied best-effort afterwards. The target is
  therefore either its old self or the complete new content, never half-written.
  A delete is an `unlink` after the location and target checks. Per-file
  failures are collected and the pass continues.
- **No fsync.** A power loss may lose the last rename. The next message boundary
  rebuilds the checkpoint and an unreferenced version becomes GC garbage; a
  target file is still never left half-written.

## Retention and GC

The store keeps the newest **100** checkpoints per session, measured by `time`.

After each new checkpoint, and on load:

1. retain the newest 100 manifests;
2. compute `keep` = the union of every non-null `blob` referenced by a retained
   manifest;
3. delete every version not in `keep`;
4. delete checkpoint files not in the retained set, and leftover `*.tmp` files
   in `checkpoints/`, `versions/` and `meta.json.tmp`.

This is pure reference counting: a version shared by several checkpoints lives
until the last retained manifest that references it is gone. There is no
first-version retention (the v1 fallback row always lies in the window) and no
journal pin — there is no journal. A crash during GC can only leave garbage; it
never deletes a referenced version.

Load drops malformed and orphan checkpoints, retains the newest 100, runs one
GC, sets the tracked set from the newest manifest, and leaves the current
checkpoint undefined until the next admitted step creates a new one.

Whole-session cleanup (`clearSession` / `pruneStale`) is a separate whole-directory
operation that does not read references, versions or the store marker; see
[snapshot auto-cleanup](snapshot-auto-cleanup.md).

## Old data

This build reads only `meta.json`, `checkpoints/` and `versions/`. Old snapshot
members — numeric anchor directories, `store`, `format`, `journal-*`, `rescue/`,
`.pending/` — are never parsed, modified or deleted. They may coexist with the
new storage in the same session directory and still count toward its size and
activity; only [whole-session cleanup](snapshot-auto-cleanup.md) removes them. A
one-time `legacy snapshot data ignored` warning is logged on load.

## Versioning policy

`meta.store` and `meta.sessionFormat` are independent. A `store` above 3 fails
the file store closed while the conversation rewind still works; a lower store,
or a `sessionFormat` mismatch, discards the new storage only. A future
incompatible format raises `store` or moves the state root and ships an explicit
migration tool; this build performs no migration.
