# Design boundaries

[简体中文](boundaries.zh.md)

> dsh-rewind rewinds a conversation in place to an earlier user message, and
> optionally restores the files that turn changed. This page is the contract for
> what that job owns: each boundary states the decision, why it sits there, and
> which tool serves the need instead. A behavior listed here is intended or accepted.
> A defect is a different thing — behavior that contradicts this page or another
> documented contract — and defects are fixed, not catalogued here.

## Position

Conversation rewind is the product. File restore is an accessory: a rewind
usually means "undo what that turn did to the files too", and a before-write
checkpoint is enough for that. The plugin is not a workspace history system, a
session manager, or a toolkit other plugins build on, and it does not grow into
one. It is one plugin in an agent's workflow, not the workflow itself.

Two rules keep it small:

- one job per plugin, with adaptation following the upstream DSH line;
- no abstraction before a second user of it exists.

## At a glance

| Boundary | Classification | Why it sits here | The need is served by |
| --- | --- | --- | --- |
| File restore covers the agent's `write`/`edit` text edits and the tracked list, not the whole tree | By design | The before-write checkpoint model has this boundary; whole-tree history is a different product | Git, or the snapshot tool the project already uses |
| A rewind is one-way; the session log is append-only | By design | Append-only is the audit and crash-safety foundation; the cut is a replace operation | DSH "branch into a new conversation" |
| Adaptation follows upstream | By design | DSH is a developer preview; one adapted line keeps behavior stable and the gate meaningful | The release built for your DSH line |
| Upstream seams are not compensated | Upstream constraint | A private seam is not a contract; a second contract breaks silently | An upstream fix; the plugin degrades in a bounded way |
| Subagent sessions are not tracked | By design | A subagent owns its own session; the parent has no authority over its files | The subagent's session, or Git |
| No whole-tree snapshot, no git operations | By design | Workspace history already has an owner; refs and the index belong to the project's own workflows | Git |

## The file boundary

The workflow this plugin targets is an agent editing text through `write` and
`edit`. For that workflow the record is deterministic by construction: the
before-state is captured before the write lands. The plugin also re-checks the
tracked list at each user-message boundary, so an external change to an
already-tracked file enters the record at the next boundary — a low-cost
fallback, not a guarantee. A restore writes back only backups, reconciled
against the live disk. The mechanics and the exact cases are in the
[file-rewind tracking boundary](compat/tracking-boundary.md).

The boundary follows from the model: a file that no write-class tool ever handled
never enters the tracked list, and a stretch of state the plugin did not back up
cannot be written back. It prefers to write nothing over guessing:

- no history before the first write-class touch;
- no restore across a stretch that was not backed up (unchanged-not-stored, over
  the per-file cap, snapshots switched off);
- no tracking for external edits to files outside the list, or for write tools
  outside the default `write`/`edit` pair that a custom composition mounts.

This is the before-write checkpoint model Claude Code uses; the boundary is
inherent to it, not a shortcut in this implementation. Workspace history already
has a better owner: Git records it byte-exactly, with the
tooling and habits agents already have. Reproducing that inside a conversation
plugin would duplicate an authority that is already maintained, and two
authorities eventually disagree.

A whole-tree store here would cost real things:

- **scope** — a second store needs indexing, exclusions, pruning, large-repo
  behavior and binary handling; the plugin becomes a snapshot engine with a
  rewind button;
- **storage** — the project usually already has a repository where its history
  lives; a second per-message store duplicates working-tree bytes and needs its
  own GC;
- **risk** — capturing the whole tree on every message adds IO, latency and
  failure modes (permissions, links, ignored trees, huge files), and every new
  failure mode is mutation surface that containment has to grow to cover;
- **maintenance** — a snapshot engine's cost is recurring; Git's is amortized
  across its ecosystem.

None of this says the plugin could not build it. It says the job belongs
elsewhere. If you need an arbitrary file at an arbitrary earlier point, use Git;
the plugin does not take that job on. Treat it as a convenience, not as the
workspace's safety net.

## The one-way cut

A rewind appends one marker (a `user/message` with a surface `replace`) and the
log is never rewritten. The raw history stays: search, telemetry, the trajectory
panel and `/export` still see the withdrawn content, and there is no in-place
undo. Those are the same property seen from two sides — the cut is a
model-context operation on an append-only record, not a deletion.

That is deliberate:

- **auditability** — the record of what happened is the log, and a rewind does
  not edit it;
- **crash safety** — one append is the smallest mutation available, and it either
  lands or it does not;
- **a predictable surface** — an "un-rewind" would be a second set of surface
  semantics the plugin invented, and it would have to interact with compaction,
  branching and pagination. The plugin cuts once and stops.

If you want to continue with the withdrawn content, DSH's branch does that:
branch into a new conversation from the message you want to keep. Deleting or
redacting recorded content is a host data operation, not a rewind feature.

## Adaptation follows upstream

DSH is a developer preview: it iterates quickly and changes behavior between
lines. When a change requires the plugin to adapt, the new plugin version adapts
to the new DSH line and maintains that line; it does not carry a multi-channel
design or cross-version compatibility. That is a stability and maintainability
choice, and it is the standard practice for a host that moves this fast.

Prereleases follow the same rhythm. DSH usually ships an alpha internal build as
it iterates, and the plugin adapts with an alpha of its own, so behavior tracks
upstream. `latest` still serves the widest audience, on the line in broad use.

The boundary that follows is one adapted line at a time.

- an older line keeps the last plugin release built for it on its release
  branch — still maintained there, though not carried forward on the main line;
- `engines.dsh` declares the adapted line, and DSH refuses to load on a runtime
  outside it — unadapted code is never admitted. That refusal is a safety
  property, not an obstacle.

Carrying several lines in one codebase would mean several verification targets,
several sets of compatibility shims and untested cross-combinations, and the
admission gate would stop meaning much. Matching the plugin version to
`dsh --version` is the smaller and more honest trade. The cost is explicit: the
newest features need a DSH update; otherwise, stay on the older plugin release.
The mechanics are in [release & DSH version alignment](release/release.md).

## Upstream seams are not compensated

Where a needed input does not exist on the host's public surface — a per-message
action slot for user rows, a derived visibility input for the chat flow, an
in-process paged read, a supported file write-back primitive — the plugin takes
the smallest workaround and stops there. It does not build a second contract on a
private seam.

The reason is the same each time: a private seam is not a contract. A
compensation built on it is a contract the host does not know about; it breaks
silently on the next line and has to be re-verified forever. So the plugin
accepts a bounded degradation instead — no button rather than a button on the
wrong row, a manual "Load earlier" rather than pagination that accounts for the
hidden rows — and records the constraint, the ask, the stance and the
user-visible effect in the [compatibility audit](compat/audit.md).

## Subagents, and what "minimal" means

A subagent runs its own session. Its files are not backed up, and a rewind of the
parent session cannot restore them; the plugin keeps no snapshot for a subagent
session and offers no rewind inside one. That is the same scope rule the plugin
applies everywhere, and it matches Claude Code.

"Minimal" is not an aesthetic. It means no plugin framework, no adapter layer for
hypothetical hosts and no cross-line shim: every abstraction is surface that has
to be maintained, verified and secured. Keeping the plugin small keeps its
failure modes countable.

## Defect or boundary

- **By design** — inside the contract; the boundary is intentional and the need
  has an owner.
- **Upstream constraint** — the host does not offer the input; the plugin chooses
  not to compensate, and the item is recorded with an ask.
- **Defect** — behavior that contradicts this page, another documented contract,
  or the tests. It is fixed; a fixed defect is not kept as a boundary.

If this page and the code disagree, that is a defect in this page: the
implementation and the documented contract win, in that order, and the page is
corrected. A use case that wants a boundary crossed is a product request; it is
weighed against the reasons above, and it does not on its own make the boundary a
defect.

## When a boundary would move

A boundary moves when the product goal changes — if file history became the
product, or DSH shipped the missing input — not because one use case would prefer
it. Until then the division of labour stands: this plugin owns the conversation
and the narrow file slice a rewind needs; Git owns the workspace's history.

## See also

[File-rewind tracking boundary](compat/tracking-boundary.md) ·
[Compatibility audit](compat/audit.md) · [Security model](../SECURITY.md) ·
[Release & DSH version alignment](release/release.md)
