# Durable format

The on-disk format of the dsh-rewind checkpoint store, pinned as a spec. The
implementation is `src/snapshot.ts`; this document is the reference for what
readers may rely on and what a future incompatible change must do. If the code
and this spec disagree, the code wins and this spec is a bug.

## State root

The store root defaults to `<harness home>/rewind-snapshots/` — the dsh data
directory (`~/.dsh/rewind-snapshots/` when `DSH_HOME` is unset) — overridable in
order by the `snapshotDir` plugin config, then the `DSH_REWIND_SNAPSHOT_DIR`
environment variable. It is a sibling of the workspace, never a subtree of it.
Deleting the root only removes file backups; the store rebuilds from scratch.

```
<root>/
└── <sessionId>/                        # safeSessionId(sessionId)
    ├── store                           # store-format marker ("2")
    ├── <anchorSeq>/                    # decimal seq of the anchoring user/message
    │   ├── <base>.json                 # one committed before-backup (metadata)
    │   └── <base>.before               # its raw byte sidecar (the before content)
    ├── .pending/                       # captures staged but not yet committed
    │   └── <base>.before
    ├── rescue/<opId>/<n>.before        # one pre-restore ("rescue") copy per op
    └── journal-<opId>.json             # one restore-op journal
```

- `sessionId` is sanitized to `[a-zA-Z0-9._-]`; the bare values `.` and `..`
  are replaced (`safeSessionId`) so a hostile id cannot traverse out of the
  root.
- `callId` is sanitized to `[a-zA-Z0-9._-]` (`safeFileId`) and extended with an
  8-hex digest of the unsanitized id — `<base>` is
  `<safeFileId(callId)>-<sha256(callId)[0..8]>`, so two call ids that sanitize
  to the same name (e.g. `a:b` / `a_b`) cannot collide. Readers never infer a
  name: every reference names its file, so pre-digest (released v1) names keep
  resolving.
- `<anchorSeq>` is a decimal integer; directories with non-integer names are
  ignored by readers.
- Journal files are recognized by the `journal-` prefix (current format) or the
  released `restore-journal-` prefix (read-only compatibility); every other
  `.json` file directly under the session dir is treated as a checkpoint entry.
- `store` is the session's store-format marker (a decimal version, written
  atomically); a missing marker means the released v1 string format.

## Checkpoint entry

One JSON file per before-backup, named `<base>.json` next to its `<base>.before`
sidecar:

```ts
interface CheckpointEntryJson {   // one `<base>.json`
  store: 2              // on-disk store format (absent/1 = the released v1 string format)
  callId: string        // the tool call that mutated the file
  file: string          // resolved display path (absolute)
  blob: string | null   // sibling sidecar file name; null = the file was created
  size: number          // byte length of the sidecar (0 when `blob` is null)
  mode?: number         // permission bits, applied when content is restored
  lossy?: true          // recorded from v1 content that had already lost bytes
  time: number          // epoch ms, strictly increasing within a store instance
}
```

A dedup link (see below) carries `callId`, `file`, `ref` and `time` instead of
`blob` and `size`.

Semantics:

- **`blob` is the pre-edit state**: a string names the sidecar holding the exact
  before bytes (copied raw, never through a JS string, so binary and non-UTF-8
  files round-trip byte-exactly); `null` means the call created the file — valid
  only with `size: 0` and never with `lossy`. The name is an invariant: it must
  equal the entry's own file name minus `.json` plus `.before`.
- **`anchorSeq` is the parent directory**, deliberately not a field of the
  entry: rewinding to message N applies every entry anchored at or after N (the
  boundary is inclusive).
- **`time` is the ordering key within an anchor group**: it is monotonic per
  store instance (bumped past the previous commit), so same-millisecond
  commits stay capture-ordered and a re-read always picks the same "earliest"
  entry per path.
- **`mode` never decides an action** (a mode-only difference is a no-op); it is
  applied, best-effort, only when content is written back.
- **`lossy` marks a record that had already lost bytes** (v1 content that was
  decoded lossily, or a materialized link to one): it is comparable but never
  written back, so a lossy record can never overwrite a live file.
- Synthetic re-check entries (external edits/deletions seen at a user-message
  boundary) use `callId = recheck-<anchorSeq>-<sha256(path) first 8 hex>`.

### Dedup link entry

A tracked file that records the same `before` content as its immediately-prior
entry for that path is stored as a **link** instead of a second byte copy: the
entry carries a `ref` (the `<anchorSeq>/<base>.json` of that prior entry) and
omits `blob`/`size`, so identical content is never duplicated across entries. A
reader resolves the `ref` back to the terminal real snapshot; `blob: null` (i.e.
a recorded creation) still means "the file was created". A `ref` is validated as
a single-level, `<digits>/<file>.json` relative reference (no traversal) so a
corrupt or hostile ref cannot escape the store root when followed; because refs
name the actual file, a link may point at a released-v1 entry. Because links
reference prior entries, `prune` materializes a surviving link whose `ref` lands
on a group it is about to drop before deleting that group, so no kept link is
left dangling; the materialized entry keeps the bytes but not the referent's
`mode` (a link carries no metadata of its own).

## Restore journal

One JSON file per restore operation, written **before any mutation** and
updated as the pass applies:

```ts
type ByteRef = { blob: string } | { text: string }   // session-relative byte file, or inline text

interface RestoreJournal {
  version: 2
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
  action: 'restore' | 'delete'  // restore = write the content back; delete = unlink
  before: ByteRef | null        // target content for restore; null for delete
  rescue: ByteRef | null        // pre-restore disk state; null = file was absent
  mode?: number                 // recorded target permissions
  rescueMode?: number           // recorded pre-restore permissions
  rescueError?: string          // set when the rescue capture failed (rollback skips it)
  done: boolean                 // true once the action's fs op completed and was marked
  failed?: string               // per-action failure message (the pass never aborts)
}
```

A `{blob}` reference is safe and session-relative: `<anchorSeq>/<base>.before`
(an entry sidecar) or `rescue/<opId>/<n>.before` (a rescue copy), validated on
both write and read so a corrupt or hostile journal can never point a restore or
a rollback outside the store. `{text}` refs carry content that has no sidecar:
released-v1 entry content, or a legacy journal's inline strings.

States: `running` and `rollback-running` are non-terminal; `completed` /
`rolled-back` are terminal. Reconciliation *reports* a still non-terminal op as
`interrupted` (or `recovery-required` when the journal is corrupt or a rollback
could not complete), while the journal itself stays `running` /
`rollback-running`. A journal read back from a legacy file (`restore-journal-`
prefix, `version: 1`, inline strings) is rewritten IN PLACE as `version: 2` once
a redo or rollback pass completes, so the same op never leaves two divergent
versions on disk.

## Write guarantees

- **Atomicity**: every JSON write serializes to a sibling `<target>.tmp` and
  renames over the target. A crash between the two steps leaves only the temp
  file — never a readable half-written target — and readers ignore temp files
  (they do not end in `.json`). The next write of the same target overwrites
  a leftover temp.
- **Bytes before metadata**: a checkpoint commit places the sidecar first
  (a staged capture is `rename`d out of `.pending/`; other sources are written
  temp-then-rename) and only then publishes the entry JSON, so a crash can
  leave an unreferenced sidecar but never an entry whose bytes are missing.
  A sidecar that is missing or shorter than `size` is a per-file failure, never
  a silent "the file was created".
- **Journal before mutation**: the rescue state of every planned path is
  captured as a raw byte copy and the intent journal — references only —
  persisted atomically BEFORE the first fs mutation; each action is marked
  `done` as it is applied.
- **Disk is truth**: after a restart, reconciliation compares the real disk
  against each action's goal (the restore target for `running` journals, the
  rescue state for `rollback-running` / `recovery-required` ones). A path
  whose disk already matches is marked done without being touched.
- **Bounded storage**: `prune` keeps the newest 100 anchor groups per session
  (`MAX_ANCHOR_GROUPS`), materializing any surviving dedup link that references
  a group being dropped before deleting whole anchor directories; it also
  recycles terminal journals (`completed` / `rolled-back`) together with their
  `rescue/<opId>/` bytes, and collects `.pending/` captures older than 24 h that
  no commit consumed. A group a non-terminal journal still references is pinned
  — evicting it would make "continue finishes the interrupted op" impossible —
  so the effective window may exceed `keep` until that op is resolved.
  Non-terminal and corrupt journals are always kept. Across sessions,
  `pruneStale` removes whole long-inactive session directories whose newest
  member stamp is older than a configurable idle cutoff (default off), so the
  store root does not grow without bound either.

## Validation and failure policy

- **Entries**: a missing, malformed, or self-contradictory entry is read as
  `undefined` (silently skipped) — losing one backup, never the recovery path.
  Contradictions are never guessed at: a `blob: null` with `size !== 0` or with
  `lossy`, a `blob` that is not this entry's sidecar name, and a non-string
  `before` in a v1 record are all corruption, and guessing an entry's kind is
  how a restore turns into a delete. Two cases are *not* silent skips: an entry
  whose `store` is newer than this build fails the whole operation closed (see
  Versioning), and a record whose sidecar is missing or too short is a per-file
  failure that the restore reports — never a delete of the live file.
- **Journals**: a corrupt or schema-invalid journal **fails loud** —
  `reconcileRestores` reports it as `recovery-required` and never drops it,
  because dropping it would silently erase the interrupted restore's recovery
  record. A `ref` with a traversal, absolute, or unknown-root segment counts as
  corrupt.
- **Journal IO**: best-effort by design — if a journal cannot be written, the
  restore proceeds with pre-journal semantics (crash safety degrades,
  behavior does not).

## Versioning policy

The format is versioned twice: a session-level `store` marker (the value is the
current `CURRENT_STORE_VERSION`, 2) and a self-describing field on every record
(`store` on entries, `version` on journals). A missing `store` marker (or `1`)
means the released v1 string format, which is still read but never migrated. A
`store` **above** the current version fails the whole operation closed — no file
restore, no clear, and no new entry written into a store a newer build owns —
while the conversation rewind itself keeps working (it does not depend on
snapshots); a journal whose `version` is neither 1 nor 2 is simply corrupt, and
is reported `recovery-required` (see Validation).

Because compatibility is not safe in both directions, the byte format shares no
key names with v1 and does not carry `anchorSeq` (it equals the parent
directory). A released v1 build therefore rejects each such entry instead of
reading it as "the file was created", so a downgrade cannot delete workspace
files; that field-name contract is pinned by
`tests/downgrade-safety.test.ts`. Compatibility means reading old data, not
repairing it: bytes the v1 build had already lost cannot be recovered.

A future incompatible format should raise the marker/version (readers already
fail closed above their own version) or move the state root and ship an explicit
migration tool. Old-format data is never silently re-interpreted.

## Cleanup policy persistence

The snapshot auto-cleanup policy (the `enabled` switch and the `maxAgeDays`
idle cutoff) is no longer a file: it lives in the **dsh-settings document** under
the `dsh-rewind-snapshot-cleanup` namespace (validated by a schemastery schema;
defaults are the `base` layer). The policy was previously persisted in a legacy
`<dsh home>/snapshot-cleanup.json` file; that file store and its one-time
startup migration have been removed. The last-sweep clock stays in its own
`<dsh home>/snapshot-cleanup-last-sweep.json` state file, which is unchanged.
