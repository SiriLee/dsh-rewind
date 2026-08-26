# dsh-rewind

Conversation rewind for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): **rewind to any earlier user message in the same session window** (Claude Code `/rewind` semantics) — rewind the model context and session window to an earlier user message, and optionally restore workspace files from disk-persisted before-backups.

[![npm version](https://img.shields.io/npm/v/dsh-rewind-plugin.svg)](https://www.npmjs.com/package/dsh-rewind-plugin)
[![npm license](https://img.shields.io/npm/l/dsh-rewind-plugin.svg)](https://github.com/SiriLee/dsh-rewind/blob/main/LICENSE)
[![npm downloads](https://img.shields.io/npm/dm/dsh-rewind-plugin.svg)](https://www.npmjs.com/package/dsh-rewind-plugin)

> English | [中文](README.md)

A deliberately focused plugin with one job: **rewind to any earlier user message, in place**.

| Mode | Conversation | Workspace files |
| --- | --- | --- |
| **Rewind conversation only** | Cut back to the target message | Untouched |
| **Rewind conversation and code** | Cut back to the target message | Restored to their state before it (modified files written back, later-created files deleted) |

Rewinding is time-travel: the target message and everything after it (agent replies, tool calls) are withdrawn from the model context *and* the rendered transcript — no new session, no window switch — and the target's text is offered back in the composer so you can edit and re-send it.

The plugin never rewrites the session log (append-only) and never touches your git repository; the before-backups are **persisted on disk**, so you can keep rewinding after restarting dsh.

## Preview

Each user message gains a compact **↶ rewind** action in its action row. Clicking it opens a mode-selection popover; "conversation and code" first shows the exact restore / delete list for confirmation (the option is hidden when there are no tracked changes — like Claude Code's code-restore visibility).

<table>
  <tr>
    <td align="center"><img src="assets/screenshots/rewind-button.png" width="440" alt="Per-message ↶ rewind button"><br><sub>Per-message ↶ rewind button</sub></td>
    <td align="center"><img src="assets/screenshots/mode-popover.png" width="440" alt="Mode-selection popover"><br><sub>Mode-selection popover</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="assets/screenshots/impact-list.png" width="440" alt="Impact list"><br><sub>"Conversation and code" impact list</sub></td>
    <td align="center"><img src="assets/screenshots/rewind-candidates.png" width="440" alt="/rewind candidate picker"><br><sub>/rewind candidate picker</sub></td>
  </tr>
</table>

## Install

```sh
dsh plugin --profile web add dsh-rewind-plugin
```

Restart `dsh web` (`--profile web`) after installing.

> ⚠️ The npm name `dsh-rewind` belongs to another author's package — install with `dsh-rewind-plugin`.

<details>
<summary><b>For contributors: local / pinned-commit install</b></summary>

Install from a local checkout or a pinned commit — `dsh plugin --profile web add /path/to/dsh-rewind` or `dsh plugin --profile web add github:SiriLee/dsh-rewind#<sha>`. A git install fails on first run until you add an `allowBuilds` key to the profile's `pnpm-workspace.yaml` (pnpm blocks git dependencies from running build scripts); after that it runs the plugin's `prepare` (a full build) and installs it.

</details>

## Usage

1. **Hover** any user message you sent — a **↶ rewind** button appears in its action row.
2. **Click it.** The target is that message; a small popover offers the two modes ("conversation and code" is only shown when there are restorable changes after the target).
3. The rewind takes effect immediately: the conversation returns to how it looked at the target message, a confirmation result message appears in the conversation, and the withdrawn message's text is filled back into the composer — edit and re-send.

**Command-line entry**: type `/rewind` and press Enter to open the candidate picker; selecting a target continues the same flow as the button.

**Keyboard**: both the candidate picker and the mode popover support ↑↓ to move, Enter to confirm, Esc to cancel/back.

Rewinds can be repeated — step back to earlier messages one at a time; but a rewind itself **cannot be undone**. The withdrawn content stays in the session log and can be recovered by manually editing the log.

<details>
<summary><b>Edge notes</b></summary>

- The file-restore action of "conversation and code" is not re-backed up.
- Every rewind appends one marker event to the log (see [How it works](#how-it-works)).

</details>

## How it works

The mechanism is the same lineage as Claude Code's checkpointing (Claude Code's file history is also per-file records plus a re-scan of tracked files at each message — not a whole-tree snapshot). This plugin implements the same semantics on dsh:

### 1. Conversation rewind: in place, without losing the log

The session log is **append-only** — the plugin never rewrites history. A rewind appends an **empty-content marker** that "shadows out" everything after the target message, so both the model and the UI only see the part before it:

- The marker is **empty** — it never enters the model context and never renders as conversation content; what you and the agent see is exactly how the conversation looked at the target;
- Because this is "shadowing" rather than "deleting", **every withdrawn event stays in the log**, fully auditable;
- The marker reuses the number of the last-started turn and carries its own step frame — so dsh's own machinery (log replay, `/compact`, resume preflight) recognizes it correctly and never mistakes it for a real message (these compatibility details are pinned by dedicated probe tests, see [Development](#development)).

<details>
<summary><b>Implementation details (for maintainers)</b></summary>

The plugin appends an **empty-content marker** `assistant/message` into the session log whose `surfaceOp: { op: 'replace', start, end }` replaces every surface node after the target message with the marker:

- The marker carries `sourceEventSeqs` covering every shadowed node, and `Session.append`'s surface rules validate the cut (a contiguous range on the current surface).
- Because the marker is **empty**, the harness derives it to `null` — it never enters the model context and never renders as conversation content.
- The marker's **turn number reuses the last started turn** (`markerTurnOf`), never `lastTurn + 1`: the harness numbers its next real turn exactly `last turn/start + 1`, so a `maxTurn + 1` marker would sit *before* that `turn/start` — the client conversation builder rejects the ordering (`…turn-tail… received an update before its start Match`) and history load fails. Reusing an already-consumed turn makes the marker a harmless trailing update on the previous completed turn's tail — it can never collide with a future turn.
- The marker rides a **ghost step frame** — its own `step/start` … `step/end` with a fresh step number (`markerStepOf`) — because the harness token-meter requires every `assistant/message` to sit inside an open step of the same turn/step; a bare idle-time marker would fail its replay and break `/compact` for the session.

</details>

A running turn (LLM thinking / streaming) is force-stopped first and the rewind waits for quiescence; if it can't stop, the rewind is aborted with an error.

### 2. File restore: before-backup + external-change tracking + disk reconciliation

The plugin tracks the write-class tools — `write`, `edit`, `str_replace_editor`:

1. **Before-backup**: the original content of every file is stored **before** it is written (captured after any approval gate lets the call through — an approval short-circuit cannot skip the backup, and a denied call never records; a read failure only warns, never blocks the write). Backups are grouped by conversation turn and **persist across restarts** (100 most recent groups per session).
2. **External changes are tracked too**: at every user-message boundary the plugin re-checks all tracked files — edits or deletions made outside the write tools are recorded as well and restored by a later rewind.
3. **Real disk reconciliation before restoring**: at rewind time the plugin reads each file's current content and compares it with the target state — **only files that actually differ are touched**: modified files are written back to their earliest backup, files created after the target are deleted, files already matching are skipped (repeated rewinds have zero side effects). Symlinks / hard links are skipped to avoid collateral damage.

<details>
<summary><b>Implementation details (for maintainers)</b></summary>

1. **Before-capture** at `tools/execute` (the around-dispatch stage): the target file is read; the resolved path + content are held in a pending map. This stage runs only after any pre-execute approval gate let the call through — an `ask` short-circuit (dsh-edit-approval) **cannot skip** the backup, and a denied call never records. If the read fails (e.g. a permission error), the change is simply not backed up — the plugin warns in the log but **does not block the write**.
2. **Disk commit** at `tools/post-execute`: the before-backup is written under the turn's anchor message seq (`~/.dsh/rewind-snapshots/<session>/<anchor seq>/<callId>.json`).
3. **External-change tracking** (`reconcileTracked`): at each message boundary the plugin re-scans tracked files and records a `recheck-<anchor>-<hash>` entry anchored to the boundary message whenever the on-disk state differs from the last seen state; the first sighting of a path always records (the first boundary after a restart unconditionally records the current state — redundant but correct, mirroring Claude Code's resume-then-re-stat behavior).
4. **Restore** (`/rewind @<seq> both`): `planRestore` probes the disk per record — `before === null` (the file did not exist at the target) plans a delete only when the file currently exists (an absent file already matches); `before === 'X'` plans a restore only when the current content differs from X (identical content is a no-op, idempotent); a probe failure is treated conservatively as differing (never silently skipped). Execution: restore = create parent dir + write back content; delete = remove the file (an already-absent file is tolerated as a no-op); symlinks / hard links are skipped (they share an inode with another name; restoring through one would clobber both); failures are recorded per file and never abort the pass.
5. A tool body that **throws** skips `tools/post-execute`; a `tools/result` safety net clears the pending capture so nothing leaks in memory. Backups persist across host restarts; `prune` keeps the newest 100 anchor groups per session.

</details>

## What it deliberately does NOT do

This plugin deliberately stays lightweight and focused on one thing — "conversation rewind". The following are **out of its scope**:

- **Whole-tree / Git-level snapshots** — only write-class tool edits plus external changes to already-tracked files are backed up; files never touched by a tool are not restored. For whole-worktree snapshot rollback, use a dedicated snapshot tool (or your git).
- **Fork / branch rewind** — the harness already provides this ("branch in new chat"); no need to reinvent it.

## Why it stands out

Compared with the common approaches, here is the trade-off this plugin makes on "rewind":

| Dimension | Common approach | This plugin |
| --- | --- | --- |
| Conversation rewind | Fork / branch a new conversation | **In-place rewind** — no new session, no window switch |
| File restore | None / git-managed / whole-tree snapshot | **Lightweight before-backups** — auto-captured before writes, one-click restore (aligned with Claude Code) |
| Dependencies | Often needs a Git repo or a full snapshot engine | **None** — no git required, works on any directory |
| Storage footprint | Whole-tree snapshots take space | **Lightweight** — only files touched by write tools are stored, persisted on disk |

## Compatibility

- Node.js `^22.19.0 || >=24.0.0`.
- DeepSeek Harness web profile (`dsh --profile web`); peer `@deepseek-ai/*` packages are resolved by the harness at runtime.

> [!WARNING]
> This project and DeepSeek Harness are both in developer preview. Pin exact
> versions in reproducible environments and review the behavior notes above.

## Client contract

Third-party DOM plugins that need to know which transcript rows a rewind
withdrew should consume the stable, locale-independent helpers exported from
`dsh-rewind-plugin/client` (`hiddenSeqsOf`, `targetSeqOfArgs`) — never parse
`outcome.text`. The `data-dsh-rewind-hidden` attribute marks withdrawn rows
(observational only). Details: [docs/client-contract.md](docs/client-contract.md).

## Known issues

1. **Exported logs are complete** — a rewind only removes messages from the model context and the view; the exported session log (`/export`) still contains **withdrawn messages**. This plugin cannot alter exports.
2. **Rewinds from `≤ v0.2.4`** — sessions rewound with these versions may **fail to load history** after more conversation. Install a pre-v0.4.0 release and use its bundled repair tool ([docs/troubleshooting.md](docs/troubleshooting.md)).
3. **Rewinds from `≤ v0.3.3`** — compaction (`/compact`) may be unavailable for those sessions. Newer versions are compatible; for affected old sessions, start a new session.

## Security

This plugin only appends rewind-marker events to the session log; it never deletes or rewrites logged history. Workspace files are written only when you choose "conversation and code"; backups and restores stay under `~/.dsh/rewind-snapshots/`. It never touches your git repository, makes no network requests, and accesses no credentials.

## Development

```sh
npm install            # devDeps from the npm registry
npm run typecheck      # tsc on all three surfaces (host + client + client-test)
npm test               # vitest: all unit and compatibility suites
npm run build          # esbuild: lib/index.js (host ESM) + lib/client.js (loader closure) + .d.ts
node scripts/verify-host.mjs   # boot the BUILT host artifact end-to-end (incl. real /compact after rewind)
```

`npm test` and `verify-host` include the **compatibility probe suites**
([docs/compat-audit.md](docs/compat-audit.md)): scenario-generated logs drive the
real harness packages (token-meter, compaction, session-stats/title/goal folds,
resume preflight) through rewind markers and assert the compatibility
invariants. A failing probe is a discovered incompatibility, not a mock
artifact. One finding is recorded: **R-OPENSTEP** — a log carrying an
unclosed `step/start` (crash leftover) makes any later step activity,
including a rewind's ghost-step frame, break token-meter replay (and
/compact). Harness `0.1.1-rc.2` fixes the crash path (`interruptedTurnClosers`
closes leftover step/turn boundaries on load). A plugin-side guard was tried
and reverted: it produced false positives on real session logs (rewind
feature broken), so the plugin deliberately ships no guard — the residual
risk (runtime-produced unclosed steps) is accepted.

`prepare` runs the full build, so git installs and `npm pack` / `npm publish` always produce a complete `lib/` and the `LICENSE`.

Maintainers: the module map and harness interface reference live in [docs/harness-reference.md](docs/harness-reference.md); publishing steps in [docs/release.md](docs/release.md).

## Release

Releases go out through GitHub Actions Trusted Publishing (OIDC, no stored `NPM_TOKEN`): push a `v<version>` tag and CI publishes with Sigstore provenance.

```sh
npm version patch && git push origin main --tags
```

One-time npm-side setup and the full workflow details: [docs/release.md](docs/release.md).

## License

[MIT](LICENSE)
