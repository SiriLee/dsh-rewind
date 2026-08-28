# Durable format

The on-disk format of the dsh-rewind checkpoint store, pinned as a spec. The
implementation is `src/snapshot.ts`; this document is the reference for what
readers may rely on and what a future incompatible change must do. If the code
and this spec disagree, the code wins and this spec is a bug.

## State root

The store root defaults to `~/.dsh/rewind-snapshots/` (the dsh data
directory), overridable via the `DSH_REWIND_SNAPSHOT_DIR` environment
variable. It is a sibling of the workspace, never a subtree of it. Deleting
the root only removes file backups; the store rebuilds from scratch.

```
<root>/
└── <sessionId>/                        # safeSessionId(sessionId)
    ├── <anchorSeq>/                    # decimal seq of the anchoring user/message
    │   └── <callId>.json               # one committed before-backup
    └── restore-journal-<opId>.json     # one restore-op journal
```

- `sessionId` is sanitized to `[a-zA-Z0-9._-]`; the bare values `.` and `..`
  are replaced (`safeSessionId`) so a hostile id cannot traverse out of the
  root.
- `callId` is sanitized to `[a-zA-Z0-9._-]` (`safeFileId`).
- `<anchorSeq>` is a decimal integer; directories with non-integer names are
  ignored by readers.
- Journal files are recognized by the `restore-journal-` prefix; everything
  else ending in `.json` under the session dir is treated as a checkpoint
  entry.

## Checkpoint entry

One JSON file per before-backup, named `<callId>.json`:

```ts
interface CheckpointEntry {
  callId: string      // the tool call that mutated the file
  anchorSeq: number   // seq of the user message anchoring the turn of the change
  path: string        // resolved display path (absolute)
  before: string | null // full content before the change; null = file was created
  time: number        // epoch ms, strictly increasing within a store instance
}
```

Semantics:

- **`before` is the pre-edit state**: `null` means the call created the file.
- **`anchorSeq` ties the backup to a user message**: rewinding to message N
  applies every entry anchored at or after N (the boundary is inclusive).
- **`time` is the ordering key within an anchor group**: it is monotonic per
  store instance (bumped past the previous commit), so same-millisecond
  commits stay capture-ordered and a re-read always picks the same "earliest"
  entry per path.
- Synthetic re-check entries (external edits/deletions seen at a user-message
  boundary) use `callId = recheck-<anchorSeq>-<sha256(path) first 8 hex>`.

### Dedup link entry

A tracked file that records the same `before` content as its immediately-prior
entry for that path is stored as a **link** instead of a full copy: the entry
carries a `ref` (the `<anchorSeq>/<callId>.json` of that prior entry) and omits
`before`, so identical content is never duplicated across entries. A reader
resolves the `ref` back to the terminal real snapshot; `before: null` still
means "the file was created". A `ref` is validated as a single-level,
`<digits>/<callId>.json` relative reference (no traversal) so a corrupt or
hostile ref cannot escape the store root when followed. Because links reference
prior entries, `prune` materializes a surviving link whose `ref` lands on a
group it is about to drop before deleting that group, so no kept link is left
dangling.

Real entries (with `before`) are unchanged and read identically before and
after this addition; a link entry is a distinct kind that lacks `before`.

## Restore journal

One JSON file per restore operation, written **before any mutation** and
updated as the pass applies:

```ts
interface RestoreJournal {
  version: 1
  id: string                    // `op-<base36 ms>-<random>`; file name suffix
  sessionId: string
  targetSeq: number             // rewind target the restore belongs to
  startedAt: number             // epoch ms
  finishedAt?: number           // set on a terminal state
  state: 'running' | 'rollback-running' | 'completed' | 'rolled-back' | 'recovery-required'
  actions: RestoreJournalAction[]
  rollbackError?: string        // set when a rollback pass failed partway
}

interface RestoreJournalAction {
  path: string
  action: 'restore' | 'delete'  // restore = write `before` back; delete = unlink
  before: string | null         // target content for restore; null for delete
  rescue: string | null         // pre-restore disk state; null = file was absent
  rescueError?: string          // set when the rescue capture failed (rollback skips it)
  done: boolean                 // true once the action's fs op completed and was marked
  failed?: string               // per-action failure message (the pass never aborts)
}
```

States: `running` and `rollback-running` are non-terminal; a host restart turns
them into `interrupted` (or `recovery-required` when the journal is corrupt or
a rollback could not complete). `completed` / `rolled-back` are terminal.

## Write guarantees

- **Atomicity**: every JSON write serializes to a sibling `<target>.tmp` and
  renames over the target. A crash between the two steps leaves only the temp
  file — never a readable half-written target — and readers ignore temp files
  (they do not end in `.json`). The next write of the same target overwrites
  a leftover temp.
- **Journal before mutation**: the rescue state of every planned path is
  captured and the intent journal persisted atomically BEFORE the first fs
  mutation; each action is marked `done` as it is applied.
- **Disk is truth**: after a restart, reconciliation compares the real disk
  against each action's goal (the restore target for `running` journals, the
  rescue state for `rollback-running` / `recovery-required` ones). A path
  whose disk already matches is marked done without being touched.
- **Bounded storage**: `prune` keeps the newest 100 anchor groups per session
  (`MAX_ANCHOR_GROUPS`), materializing any surviving dedup link that references
  a group being dropped before deleting whole anchor directories; it also
  recycles terminal journals (`completed` / `rolled-back`). Non-terminal and
  corrupt journals are always kept. Across sessions, `pruneStale` removes whole
  finished-session directories whose newest member stamp is older than a
  configurable idle cutoff (default off), so the store root does not grow
  without bound either.

## Validation and failure policy

- **Entries**: a missing or malformed entry is read as `undefined` (silently
  skipped) — losing one backup, never the recovery path.
- **Journals**: a corrupt or schema-invalid journal **fails loud** —
  `reconcileRestores` reports it as `recovery-required` and never drops it,
  because dropping it would silently erase the interrupted restore's recovery
  record.
- **Journal IO**: best-effort by design — if a journal cannot be written, the
  restore proceeds with pre-journal semantics (crash safety degrades,
  behavior does not).

## Versioning policy

The journal schema is `version: 1`. Checkpoint entries currently carry no
version field. A future incompatible format must either bump the journal
`version` (readers reject unknown values — there is no best-effort fallback or
legacy coercion) or move the state root (e.g. `rewind-snapshots/v2`) and ship
an explicit migration tool. Old-format data is never silently re-interpreted.
