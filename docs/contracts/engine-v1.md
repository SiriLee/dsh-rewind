# Engine contract v1

dsh-rewind publishes one deliberately narrow contract for driving a rewound
conversation and its file effect, and for taking over the action and command
interfaces. It has three operations, one attribute and one client command-face
service. This document is the contract: it defines the wire shape, the stable
codes, the semantics and the invariants. Design rationale and rejected
alternatives are not repeated here.

This plugin still does one job: rewind a conversation in place, optionally
restoring the files that turn changed. The contract standardizes seams that
already existed (routes and commands); it adds no new capability, no permission
model and no general extension point. The native client is the first caller.

## 1. Scope

- **In scope**: `health`, `preview`, `commit`, the action takeover attribute,
  the command-face takeover service, the effect semantics, the stable code set
  and the version rules below.
- **Out of scope**: theme-specific adapters, a DSH compatibility matrix, forward
  undo, cross-session or batch rewind, permission models, MCP/tool bindings,
  host command takeover, and whether the native UI exposes a file-only action.
- **Effects**: `conversation` (cut the model-visible surface) and `files`
  (restore the workspace) are orthogonal. Callers choose the combination.

## 2. Wire format

- Paths are below `/api/dsh-rewind/v1/`. The major version lives in the path.
- `health` uses `GET`; `preview` and `commit` use `POST` with
  `content-type: application/json`.
- Success: HTTP 200 plus `{ "ok": true, "value": … }`.
- Failure: the HTTP status from §4 plus
  `{ "ok": false, "error": { "code": …, "message": … } }`.
- **Only `code` is stable.** `message` is a human-readable diagnostic and is not
  promised to stay the same.
- Callers must ignore unknown fields and unknown `value` keys. Unknown error
  codes are failures, never successes.

## 3. Operations

### 3.1 Is the engine there?

```
GET /api/dsh-rewind/v1/health
```

```json
{ "contract": 1 }
```

If the route is absent (404 or a network failure), treat the engine as absent:
render no action and show an install hint. If `contract` differs from the
caller's supported major, also render no action. Capabilities are deliberately
not declared here: whether a particular rewind can restore files is answered by
`preview` (§3.2).

### 3.2 What would happen?

```
POST /api/dsh-rewind/v1/preview
{ "sessionId": "…", "seq": 42 }
```

```json
{
  "headSeq": 137,
  "withdraw": { "text": "Take this part and…", "attachments": [] },
  "files": {
    "available": true,
    "changes": [
      { "path": "src/a.ts", "action": "restore" },
      { "path": "tmp/new.ts", "action": "delete" }
    ],
    "skipped": [{ "path": "assets/big.bin", "reason": "oversized" }]
  }
}
```

| Field | Meaning |
| --- | --- |
| `headSeq` | The last event seq in the session. The caller returns it unchanged at commit as the "this is the state I saw" binding. |
| `withdraw` | The content the rewind would withdraw. `attachments` is always an array, may be empty, and passes through the host message's non-text content blocks unchanged. |
| `files.available` | Whether the file effect can run for this target. When `false`, only `reason` is present. |
| `files.changes` | Disk changes the commit would apply, sorted by path. `restore` writes the checkpoint content back; `delete` removes a file created after the target. |
| `files.skipped` | Paths the file effect leaves alone, with a reason. A hint, not a failure. |

**Availability reasons** (`files.available: false`):

| Reason | Meaning |
| --- | --- |
| `no-checkpoint` | The target has no recorded checkpoint. |
| `checkpointing-disabled` | The target has no checkpoint and file checkpointing was off. |
| `store-unsupported` | The checkpoint store uses a newer format than this plugin understands. |

An existing checkpoint stays usable even when checkpointing is off; the native
client keeps its "snapshots off, the restore may be incomplete" note from its
own configuration read.

**Skip reasons** (`files.skipped[].reason`):

| Reason | Meaning |
| --- | --- |
| `oversized` | The current file exceeds the per-file backup cap. |
| `parent-changed` | The recorded parent directory no longer resolves to its captured location. |
| `unsafe` | The path resolves outside the workspace, or is a symlink/hard link. |
| `missing` | No recorded state exists for this path at or after the target. |

`preview` is read-only and repeatable; it produces no rewind or restore effect.
It binds the session head but not the workspace: external disk changes between
preview and commit are reconciled per path at commit time.

Callers that cannot handle attachments should warn that images will not be
brought back, or disable the edit/rerun action; refilling `text` alone still
works.

### 3.3 Do it now

```
POST /api/dsh-rewind/v1/commit
{ "sessionId": "…", "seq": 42, "headSeq": 137, "mode": "both" }
```

```json
{
  "conversation": { "rewound": true },
  "files": {
    "applied": true,
    "restored": ["src/a.ts"],
    "deleted": ["tmp/new.ts"],
    "skipped": [{ "path": "assets/big.bin", "reason": "oversized" }],
    "failed": []
  }
}
```

| `mode` | Result |
| --- | --- |
| `conversation` | Cut the model-visible surface only; the workspace is untouched. |
| `files` | Restore files only; the conversation stays complete. |
| `both` | The existing "rewind and restore" behavior. |

- `mode` and `headSeq` are required.
- The response contains **only the requested effects**. A `conversation`-only
  response has no `files` key; a `files`-only response has no `conversation` key.
- `headSeq` must equal the session's current last-event seq. A mismatch is
  `head-changed`, with **no write and no turn cancellation**.
- The submission order is fixed: validate the request; resolve the session and
  target; reserve the per-session commit; compare the head; cancel a running turn
  only when the mode includes `conversation`; after quiescence, plan the surface;
  then write. A head mismatch therefore cannot be caused by this commit's own
  cancellation.
- A running turn: `files` alone returns `turn-running` immediately without
  cancelling. `conversation` and `both` cancel the turn and wait up to 15 seconds;
  if it does not stop, the commit returns `turn-running` and performs no rewind
  write.
- `files` requested but unavailable: not an error. The response is
  `{ "applied": false, "reason": … }` with a §3.2 availability reason, and a
  requested `conversation` effect still happens.
- `skipped[].reason` and `failed[]`: see §3.2. `failed[].message` is the raw
  write error and is not stable.
- Refill the composer from `preview.withdraw`; the commit response does not
  repeat it.
- After any 4xx, do not reuse the old `headSeq`: preview again before committing
  (`bad-request` means the request itself must be fixed first).

**"Files only" consequence.** The model context still contains that turn's
changes, so later steps can produce them again. This is the caller's explicit
choice; the engine does not compensate.

## 4. Failure codes

The set is closed for v1. All seven are reachable and tested.

| Code | HTTP | Meaning | Caller action |
| --- | --- | --- | --- |
| `bad-request` | 400 | Missing field, non-integer `seq`/`headSeq`, invalid `mode`, or the body is not JSON. | Fix the request. |
| `session-not-found` | 404 | No live agent is attached to `sessionId`. | Open the session. |
| `target-missing` | 404 | `seq` is not a rewindable human user message (unknown, not human, or cut from the current surface). | Choose another target. |
| `head-changed` | 409 | The session head differs from `headSeq`. | Preview again. |
| `turn-running` | 409 | The turn is still running for this mode. | Stop the turn, then retry. |
| `commit-in-flight` | 409 | Another commit owns this session. | Retry later. |
| `internal` | 500 | An unexpected failure; details are in the host log. | Report it. |

Callers align versions through the path major and `health.contract`; there is no
request-side version to mismatch.

## 5. Taking over the action interface

```html
<html data-dsh-rewind-claim="my-theme">
```

The attribute means "the action interface is owned by the plugin named by this
value". While it is present, the engine hides its own:

- inline rewind button and its mode popover (an open popover closes);
- retract button on an unsent steering bubble.

The engine does **not** hide: the withdrawn-span visibility computation, the
client `/rewind` and `/undo` commands, or its own settings form when its
installation has a plugin page. Commands remain usable; a command-triggered
rewind still works.

A settings page belongs to a direct installation. An engine mounted as another
plugin's component has none, with or without a claim; the plugin that inserted
the row owns the configuration surface.

The value is diagnostic and display data only. The engine does not validate that
the claimant renders anything, and it does not arbitrate between multiple
claimants; any claim present makes the native trigger yield. The claimant owns
the interface while the claim is up (it sets the attribute only after health
passes and it will actually render, and removes it on unload).

- Plugin config item `uiOwner` (file-level, not a user-visible setting):
  `auto` (default, respect the claim) or `self` (ignore the claim and always
  show the native controls; a page may then show two action surfaces by the
  user's choice).
- **Visibility is an effect, not a trigger.** Withdrawing content and hiding it
  belong to the engine and are independent of how the rewind was triggered:
  native button, command, or this contract. The hidden span survives a page
  reload (I9). The takeover attribute only changes the trigger surface.

## 6. Taking over the command surface

The client half exposes `ctx.dshRewind.commands.takeover()`. It resolves with a
permission whose `dispose()` restores the engine's commands, or `null` when the
takeover was refused: another claimant already holds the face, `uiOwner` is
`self`, the client half has unloaded, or an engine command could not be
unregistered. The refusal reason is logged and is not part of the API. The
claimant registers its own commands with `ctx.commandUi.register`; registering
none is hide-only.

- A refusal is a `null` result, not an exception; callers register nothing.
- `dispose()` is idempotent and a no-op after the client half unloads. A name
  still owned by another party is skipped, never overwritten. Open command
  popups are dismissed with the takeover.
- It covers client commands only: host commands (a same-named host command is a
  name collision, not a takeover), the engine routes, the action interface
  (§5), visibility and settings are untouched.

## 7. Semantics

### 7.1 Target

`seq` must identify a human `user/message` currently on the model-visible
surface. Messages cut by an earlier rewind or compaction are `target-missing`.
Checkpoints are located by that message's id; no checkpoint makes the file
effect unavailable while the conversation effect still runs. The last message
is a valid target: the operation withdraws the message itself.

### 7.2 Conversation effect

- Appends one marker (`user/message` carrying `surfaceOp: replace` and
  `sourceEventSeqs`); the model-visible surface moves to before the target. The
  log stays append-only.
- Pending steering (next-step) messages are dropped; queued next-turn messages
  are kept. Withdrawn messages stay in the log and are not restored by this
  contract.

### 7.3 Files effect

- Uses the target's checkpoint as the baseline, reconciles every path against the
  current disk, and writes only the differences. Each write is a per-file atomic
  replacement; deletes remove files only.
- Whole-effect unavailability and path-level refusals are reported as in §3.2
  and §3.3; they never abort an unrelated effect of the same commit.
- A file over the per-file cap is not restored and enters
  `skipped: oversized`; `preview` already shows it.
- After a restore the host's filesystem-observation cache is re-synced, because
  the restore writes through plain host filesystem calls.

### 7.4 Binding and concurrency

- The server stores no plan state. `headSeq` is the only binding value.
- The order and the zero-write rule are in §3.3. A replayed conversation commit
  reports `head-changed` (its head moved), while the same now-cut target with a
  current head is `target-missing`.
- One commit per session at a time; different sessions do not block each other.
- `files` commits are repeatable (the target checkpoint stays authoritative; a
  second pass finds an empty diff). `conversation` commits cannot be replayed:
  the marker moves the head, so the second commit is `head-changed`.
- The workspace is not bound: external changes after preview are reconciled per
  path and appear as `skipped`, not as a whole-commit refusal.

### 7.5 Side effects and what is not undone

This contract undoes workspace content and the model-visible surface only. Git
commits, external services, process effects and checkpoint-store writes are not
undone.

## 8. Invariants

| # | Invariant |
| --- | --- |
| I1 | `preview` produces no rewind/restore effect; repeated calls are stable except for concurrent external changes. |
| I2 | Repeating a `files` commit succeeds, appends no event and leaves the workspace unchanged (its path lists may be empty); a second `conversation` commit is `head-changed`. |
| I3 | A `files` commit appends no event (the log length is unchanged). |
| I4 | A `conversation` commit does not touch the workspace (file bytes are unchanged). |
| I5 | `head-changed` performs zero writes and zero cancellation. |
| I6 | With a claim present and `uiOwner: auto`, the inline action is not in the document; removing the claim restores it. |
| I7 | The action takeover yields only the action trigger: the command surface, visibility computation and configuration are unaffected. |
| I8 | Under the same disk state, `preview.files` and the following `commit.files` describe the same change set. |
| I9 | Withdrawn content stays hidden after a reload and is independent of the trigger (command, native button or contract). |
| I10 | A command takeover unregisters every engine client command; `permission.dispose()` restores them, skipping names still registered by another party. |

## 9. Integrating

This document is the contract. A step-by-step guide with worked examples lives
in [integration.md](integration.md); it is not normative and adds no
requirements.

## 10. Responsibility

| Surface | Owner |
| --- | --- |
| Engine, checkpoints, restore, client commands, visibility, native UI | dsh-rewind |
| The command-face service, its permission and restore rules | dsh-rewind |
| The trigger or command interface rendered after a takeover, its copy and its calls into this contract | the claimant |
| This contract (fields, codes, semantics, version) | dsh-rewind |

A claimant accepts responsibility for the interface it renders; §5 and §6
define what each takeover does and does not affect.

## 11. Versioning

- The major version is in the path (`v1`) and only breaking changes raise it.
  `health.contract` is the single version query point.
- Within a major version, fields and `skipped.reason` values may be added.
- The contract version is independent of the plugin package version and the DSH
  version.
