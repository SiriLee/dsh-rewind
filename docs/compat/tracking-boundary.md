# File-rewind tracking boundary

> Behavioral note — this is **not** a bug. The plugin's file rewind deliberately
> tracks only the model's dedicated editing tools, and applies an additional
> boundary (message-boundary re-check) to registered files. Written for issue
> [#5](https://github.com/SiriLee/dsh-rewind/issues/5); aligned with Claude Code's
> checkpoint semantics.

## One-line summary

Rewind **always** restores files edited with the dedicated editing tools
(`write` / `edit` / `str_replace_editor`) because the plugin snapshots them
before the edit. Command-line (or hand) edits are covered **only when the file
was previously registered** by an editing tool in the same conversation.

## How file changes are classified

**Editing tools** (create/overwrite, edit lines, insert): each call tells the
plugin *which file* it will change, so the plugin snapshots the file's current
content **before** the edit and can restore it on rewind. This path is
deterministic — using them always yields a restorable rewind.

**Command-line or manual edits**: PowerShell (`pwsh`) writes on Windows, `sed -i`
on Linux, or saving a file by hand. These do **not** tell the plugin which file
is being touched, so there is nothing to snapshot beforehand.

Command/manual edits are nevertheless covered in one case: if the file was
**previously registered** by an editing tool in this conversation, the plugin
re-checks registered files at each user-message boundary and records a change it
sees, so those files restore on rewind too.

## When a rewind is not available

Two situations limit restorability:

1. **The model edits the file with a command on its first touch, and the file
   was never registered.** No snapshot, no registration — nothing was recorded
   around the change, so there is nothing to restore from.
2. **The file was manually edited before the model's first editing-tool change.**
   The plugin's first snapshot is taken at the editing-tool call, so rewind can
   return the file only to its state *after* the manual edit, not before it.

Both stem from a deliberate **lightweight** trade-off. Supporting command edits
in every case would require scanning the whole workspace and classifying what
arbitrary commands changed — costly, error-prone, hard to maintain. Instead the
plugin registers only the editing tools that hand it an exact path, and relies
on the message-boundary re-check as its lightweight safety net. The cost is that
unregistered files' command edits are not recorded; the benefit is a simple,
reliable, maintainable plugin — the same behavior Claude Code exhibits.

## Position

Making command edits restorable in the *unregistered-first-touch* case would
mean repeatedly backing up the entire workspace, or depending on a Git working
tree — both heavy, and at odds with the plugin's lightweight-snapshot design.
Git is already the right tool for workspace-change management. The plugin's
position is to favor **fast, conversation-scoped rewinds**, so this capability
is deliberately not adopted.
