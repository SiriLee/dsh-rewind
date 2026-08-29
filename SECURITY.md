# Security model

This document is the security model of **dsh-rewind** — how the plugin treats
untrusted input, what it is allowed to mutate, and how it survives crashes.
It is derived from the implementation (`src/index.ts`, `src/snapshot.ts`); if
this document and the code ever disagree, the code wins and this document is
a bug.

## Trusted boundary

The plugin runs in the DSH host process and therefore holds the host user's
filesystem authority — it reads and writes files with plain `node:fs`. The
following are treated as **untrusted inputs**:

- **Model arguments** — the `file_path` / `path` / `command` fields of write,
  `edit`, and `str_replace_editor` tool calls (they name the paths the
  checkpoint store records).
- **Session log contents** — events are parsed structurally; a hostile or
  malformed id must never escape the store root.
- **Current worktree state** — restore planning reconciles against the live
  disk, which may have been changed by anything.
- **Concurrent external modifications** — a restore never assumes the disk
  still matches its records.

The DSH host (and its other plugins) is trusted; this plugin does not
re-verify the host's own authority boundaries.

## Mutation gates

The plugin **automatically captures** before-backups of tracked mutations, but
**never automatically applies** one. A workspace restore happens only through
an explicit user-invoked `/rewind @<seq> both` (the per-message ↶ button or the
command channel), and only when all of the following hold:

1. **A validated target**: `planRewind` accepts only a `user/message` seq that
   is currently on the session surface (`parseRewindTarget` → `RewindPlan`).
2. **A fresh plan**: the plan is derived from the current `events` + `surface`
   at execution time — never cached across events.
3. **Committed backups exist**: every planned action comes from a committed
   checkpoint entry anchored at or after the target.
4. **Live-disk reconciliation**: `planRestore` compares each entry against the
   current disk and plans only actions that would actually change it — an
   already-matching state is a no-op (restores are idempotent).
5. **Exclusive execution**: a per-session in-flight guard rejects concurrent
   rewinds; a running turn is force-cancelled (`keepInbox`) and quiescence is
   awaited before the surface is cut.
6. **Session binding**: the restore reads/writes only the store of the rewound
   session (paths are resolved display paths the session's own tools touched).

**Concurrency scope**: the in-flight guard above only serializes concurrent
*rewinds* of one session; it does not stop other processes from modifying the
workspace. `planRestore` reconciles against the live disk at plan time, but
there is no re-validation between planning and applying — a file changed by
another process in that window is overwritten by the restore. The rescue state
is captured at apply start, so `rollbackRestore` still returns the workspace
to exactly the apply-start state, and per-file failures are reported rather
than hidden.

A failed gate fails closed: an invalid target, a missing store, an absent
backup, or a cancelled invocation aborts the rewind with an error.

**Automatic store deletion (opt-in)**: unrelated to restores, an enabled
`snapshot-auto-cleanup` background sweep deletes whole session directories of
**long-inactive** sessions (default off — the store is otherwise only mutated by
an explicit rewind apply). It is confined to the store root, uses `lstat` (so it
never follows a symlink out of the root), skips the active session, and never
touches the conversation log. When disabled (the default), no automatic deletion
runs.

## Conversation integrity

The session log is **append-only** — the plugin never deletes or rewrites
recorded history. A rewind appends a single marker event: an **empty**
`assistant/message` whose `surfaceOp` replaces every surface node after the
target. The raw log (audit trail, search, `/export`) is untouched — only the
model-visible surface is cut, so the next request derives its context from the
target onward. The marker sits inside a ghost `step/start … step/end` frame so
the harness token-meter replay keeps accepting the log; a malformed marker
(duplicated turn/step, dangling open step) is what earlier versions produced
and is repaired offline (see `docs/compat/troubleshooting.md`).

## Filesystem containment

- **Store root**: `~/.dsh/rewind-snapshots/` by default (`DSH_REWIND_SNAPSHOT_DIR`
  overrides it). The store never overlaps the workspace; deleting it only
  removes file backups and the store rebuilds from scratch.
- **Path sanitization**: session ids and call ids are scrubbed to
  `[a-zA-Z0-9._-]` (`safeSessionId` / `safeFileId`) before joining the store
  root; `.` and `..` bare values are replaced — hostile ids cannot traverse
  out of the root.
- **Never written through links**: symlinked and hard-linked paths
  (`lstat().nlink > 1`) are skipped and reported, never restored — a symlink
  would redirect the write outside the checkpoint, and a hard link would
  clobber every other name of the same inode (e.g. pnpm-installed files).
- **Restores name only recorded paths**: the store contains resolved display
  paths of the session's own write-class tool calls (plus boundary re-checks
  over that same tracked set) — a restore can never write an arbitrary path.
- **Path resolution rule**: relative paths resolve against the session
  workspace cwd, mirroring the fs tools' own rule (`src/session-cwd.ts`).
- **Bounded backups**: `prune` keeps the newest 100 anchor groups per session
  (`MAX_ANCHOR_GROUPS`), so backup accumulation cannot grow the store without
  bound (the exact cap is pinned in `docs/format.md`). Across sessions, the
  opt-in `pruneStale` sweep removes whole **long-inactive** session directories
  (measured by the newest member being idle past `maxAgeDays`); it uses `lstat`
  (no symlink following), skips dot-prefixed temp files, and never targets the
  active session (`keepActiveId`).

## Crash safety

- **Atomic commits**: every JSON write (checkpoint entries, restore journals)
  goes to a sibling temp file and is renamed over the target. A host crash
  mid-write can leave only an inert `<target>.tmp` — never a readable
  half-written file — and readers never pick up temp files.
- **Journaled restores**: before mutating anything, the restore captures each
  planned path's pre-restore ("rescue") state and persists an intent journal,
  then marks each action done as it is applied. A crash at any point leaves
  the journal on disk.
- **Disk is truth**: after a restart, `reconcileRestores` re-derives from the
  real disk which paths already match the goal (restored) and which are
  pending; `continueRestore` finishes the interrupted op, `rollbackRestore`
  undoes it to the exact pre-restore state. A journal whose goal is already
  reached auto-heals to its terminal state.
- **Fail-loud vs fail-soft**: a corrupt **journal** is reported
  `recovery-required` — never silently dropped (dropping it would erase the
  interrupted restore's recovery record). Corrupt **checkpoint entries** are
  silently ignored (they only lose one backup, not the recovery path).
- **Journal IO never fails the restore**: if the journal cannot be written the
  restore proceeds with pre-journal semantics (crash safety degrades,
  behavior does not).

## Explicit non-goals

- This plugin does **not** sandbox other processes or stop them from changing
  files concurrently.
- It does **not** provide confidentiality or tamper resistance against the
  same operating-system user: state files are created with the process
  default permissions (no special modes are set — a standard umask applies),
  and the host user remains trusted.
- It does **not** exclude paths from the store: recording and restore mirror the
  paths the model's file tools touched, so a sensitive file (e.g. `.env`) the
  model may read or edit will be backed up and restorable. Keeping one out is
  a **DSH model-permission** concern (a per-path deny), not a rewind feature.
- It does **not** touch git (no refs, index, or worktree operations), makes
  **no network requests**, and does **not** access credentials.
- It does **not** roll back whole-log state: telemetry, search, and `/export`
  still see the withdrawn messages (documented behavior, not a bug).
- It does **not** restore files written by a cancelled tool call that never
  committed a backup.
- **Subagent session edits are not tracked** (Claude Code alignment): a
  subagent runs its own session, so the files it changes are not backed up and
  cannot be restored by a rewind of the parent session.

## Reporting

Report a vulnerability through the repository's GitHub security channel or to
a repository maintainer. Include: the plugin version/commit, the DSH
(`@deepseek-ai/*`) version, the platform, and a minimal reproduction — and
whether the failure happened before or after workspace mutation.
