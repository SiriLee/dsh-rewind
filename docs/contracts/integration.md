# Driving the engine from your plugin

This guide is for plugin authors who want to rewind a conversation from their
own interface. The contract is [engine-v1.md](engine-v1.md); this page shows how
to use it and is not normative.

Normal users never need any of this: the plugin's own buttons, picker and
settings cover the product.

Several examples follow the probe — a third-party client we used to verify this
contract. It has one fixed button, takes over the action interface, commits
`conversation` only and never refills the composer; its minimal choices keep the
mechanism visible.

## What you can build

| Goal | What you do |
| --- | --- |
| Replace the built-in action buttons | Render your own button and set the takeover signal. |
| Add a trigger without replacing anything | Render your own button or menu entry; never set the signal. |
| Restore files without rewinding the conversation | Call `commit` with `mode: 'files'`. |
| Your own target picker | List your own messages and pass each row's `seq`; the contract has no candidate query. |
| Replace the engine's `/rewind` and `/undo` commands | Take over `ctx.dshRewind.commands` and register your own client commands. |

## The minimum

Three calls, one attribute:

1. `GET /api/dsh-rewind/v1/health` — render nothing (or an install hint) unless
   it answers `contract: 1`.
2. `POST /api/dsh-rewind/v1/preview` — describes what would happen.
3. `POST /api/dsh-rewind/v1/commit` — performs it, bound to `preview`'s
   `headSeq`.
4. If you are replacing the buttons, set
   `data-dsh-rewind-claim="<your-id>"` on `<html>` after step 1; remove it when
   your plugin unloads.

A button, end to end — the probe's whole rewind path:

```js
const v1 = '/api/dsh-rewind/v1'
const post = (path, body) => fetch(v1 + path, {
  method: 'POST',
  credentials: 'same-origin',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
}).then(r => r.json())

async function engineContract() {
  const health = await fetch(v1 + '/health', { credentials: 'same-origin' })
    .then(r => (r.ok ? r.json() : null))
    .catch(() => null)
  return health?.ok === true && health.value.contract === 1
}

/** Rewind to one user message. Returns the withdrawn text, or an error code. */
async function rewindTo(sessionId, seq, { files = false } = {}, retry = true) {
  const preview = await post('/preview', { sessionId, seq })
  if (preview.ok !== true) return { error: preview.error.code }
  const { headSeq, withdraw, files: impact } = preview.value
  const mode = files && impact.available === true ? 'both' : 'conversation'
  const done = await post('/commit', { sessionId, seq, headSeq, mode })
  if (done.ok !== true) {
    // The conversation moved between preview and commit: preview again.
    if (done.error.code === 'head-changed' && retry) return rewindTo(sessionId, seq, { files }, false)
    return { error: done.error.code }
  }
  return { text: withdraw.text }
}
```

Where `seq` comes from: the `seq` on the chat-snapshot node of the user message
you are acting on. There is no contract operation that lists targets.

## Recipes

### Row action with a confirmation

1. `preview` and render `withdraw.text` plus `files.changes`.
2. When `files.available === false`, disable the file option and show copy for
   `files.reason` (`no-checkpoint`, `checkpointing-disabled`,
   `store-unsupported`).
3. On confirm, `commit` with `conversation` or `both`.
4. On success, write `withdraw.text` into the composer if it is empty. Skip the
   write when the user already has a draft; append `withdraw.attachments` the
   same way the harness restores images.

### One-click “rewind the last turn”

The probe is this shape: a single fixed button, no dialog.

```js
if (await engineContract()) {
  document.documentElement.dataset.dshRewindClaim = 'my-one-click'
  // latestSeq: the newest user message's seq, read from your own chat rows
  const result = await rewindTo(sessionId, latestSeq, { files: false })
}
```

It ignores `withdraw` and the file effect on purpose. The withdrawn messages
hide immediately and stay hidden after a reload.

### File-only restore

```js
const preview = await post('/preview', { sessionId, seq })
if (preview.ok === true && preview.value.files.available === true) {
  await post('/commit', { sessionId, seq, headSeq: preview.value.headSeq, mode: 'files' })
}
```

`commit` with `mode: 'files'` restores the workspace to the target message's
checkpoint without touching the conversation or the log. Two consequences worth
telling the user about:

- the model's context still contains the later turns, so a later step may
  recreate what you restored;
- while a turn is running this returns `turn-running` instead of cancelling it.

### Your own picker

List the messages you can address (for example the rows in your own UI), take
each row's `seq`, and call `preview`/`commit`. A target must be a human user
message that is currently on the model-visible surface; anything else is
`target-missing`.

## Turning failures into copy

| Code | What you do |
| --- | --- |
| `head-changed` | Preview again; the conversation moved. |
| `turn-running` | Ask the user to stop the turn. |
| `commit-in-flight` | Retry once the other rewind finishes. |
| `target-missing` | The row is stale; drop the action or ask to pick again. |
| `session-not-found` | The session is not attached (closed or archived). |
| `bad-request` | A bug in the call, not a user-facing condition. |
| `internal` | Report it; details are in the host log. |

Meanings and HTTP statuses are in the contract §4. Only `code` is stable: show
your own localized copy and put the raw code in your diagnostics.

## Taking over the action interface

The signal is an attribute on the document root;
[§5 of the contract](engine-v1.md) defines what it yields, what it leaves alone,
and when to set and remove it.

```html
<html data-dsh-rewind-claim="my-theme">
```

Taking over is more than a button: you own the control and its placement, the
conversation/file choice, the refill into an empty composer, and every message a
failure produces.

- A leftover attribute keeps the native buttons hidden until the page reloads.
- The pending-steering retract is yours too: implement it with the session's own
  queue API (`updateQueue` with `remove`).
- Users can recover the native interface with the plugin config item
  `uiOwner: self` (a file-level setting, not a settings-card toggle).

## Taking over the command surface

A client plugin can take the engine's `/rewind` and `/undo` commands as one
face; [§6 of the contract](engine-v1.md) defines the rules.

```ts
const permission = await ctx.dshRewind.commands.takeover()
ctx.commandUi.register({ name: 'rewind', label, description, icon, available, ui })
// Unregister your commands, then:
permission.dispose()
```

- Takeover with no registration is hide-only.
- A second takeover while one is held rejects with `already-taken`;
  `uiOwner: self` rejects with `native-owner`.
- The permission registers nothing; use the standard client command interface.
- A name still occupied when you dispose stays with its owner.
- The service is present only while the engine's client half is loaded.

## Packaging your plugin next to the engine

If your UI cannot work without the engine, install it as a dependency so adding
your plugin adds the engine too:

```json
{ "dependencies": { "dsh-rewind-plugin": ">=0.23.0" } }
```

and insert its loader row in your bundle patch:

```yaml
- insert:
    - id: dsh-rewind-plugin
      name: 'dsh-rewind-plugin'
```

The id is the engine's own: loader entries are keyed by id, so the row merges
with one a user already has, and the profile keeps a single engine package
however many plugins insert that row. Leave `disabled` off it, and use `config`
only for the initial policy described under Configuring.

Installed this way, the engine is a component of your plugin: it has no card of
its own, so plan to host its configuration — you enable, configure and remove
it through your card — unless someone also installs it directly. Removing your
plugin drops your row; the package goes only when nothing installed still
depends on it and it is not a direct dependency.

An injected engine gets no update entry of its own: reinstalling your plugin
re-resolves it only when your range no longer accepts the installed version.
Set the floor to the engine version you last verified — and raise it when you
need a newer engine, so the two move together. The contract reports its major
version, not the package version, so check the engine release when you build,
not at runtime.

Caveats:

- the row's `name` must be the package name; the client module and the loader
  resolve the package by that name;
- profiles install dependencies hoisted, so a transitive dependency resolves
  from the profile root;
- the dependency range only guides installation; the runtime gate is
  `health.contract`, which you already check.

## Configuring the engine

The row your patch inserts can carry `config`:

```yaml
- id: dsh-rewind-plugin
  name: 'dsh-rewind-plugin'
  config: { fileCheckpointingEnabled: false, autoCleanupEnabled: false }
```

That is an initial value, not a lock. One entry has one configuration, and more
than your row feeds it: another bundle inserting the same row, an engine
upgrade that moves a default, and the user editing the profile all compose over
it. So do not pin behavior to a default plus a hidden control, and do not
assume a field still holds the value you saw: read the form when it matters.

Where the controls live is your call:

- your own settings surface, through `ctx.configForms.get('dsh-rewind-plugin')`
  (`set`, `unset`, `subscribe`);
- the component's own config page, by registering `plugins.row.config` under
  `<your package>#dsh-rewind-plugin`.

Expose only the fields you decide to support; anything you leave out stays
editable in the profile config. Store options — `snapshotDir`, `dshHome`,
`maxFileBytes`, `autoSweepIntervalMs` — are read when the plugin mounts, so a
change needs a remount or a restart. The policy fields apply live.

If you set a value the user may not want, leave a way back: `unset(field)`
returns the field to your value, not to the engine default, so label it "restore
this plugin's default", not "factory reset". The probe does both — two switches
off in its row, a restore-default next to each.

Three details to get right. Turning `fileCheckpointingEnabled` off makes
`preview.files.reason` `checkpointing-disabled`, which you should explain
rather than report as a failure. `uiOwner` is the user's escape hatch, not a
caller switch: the action takeover is `data-dsh-rewind-claim`, the command
takeover is `ctx.dshRewind`. And when `health` is absent the form is
`unavailable`; hide the controls.

## Testing your integration

```bash
curl -s localhost:3080/api/dsh-rewind/v1/health
curl -s -X POST localhost:3080/api/dsh-rewind/v1/preview \
  -H 'content-type: application/json' -d '{"sessionId":"<id>","seq":42}'
curl -s -X POST localhost:3080/api/dsh-rewind/v1/commit \
  -H 'content-type: application/json' \
  -d '{"sessionId":"<id>","seq":42,"headSeq":137,"mode":"both"}'
```

Use your host's port and token. Check the effect after a reload, not only in the
page that performed it: the withdrawn span must stay hidden.
