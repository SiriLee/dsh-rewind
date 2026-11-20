# Driving the engine from your plugin

This guide is for plugin authors who want to rewind a conversation from their
own interface. The contract is [engine-v1.md](engine-v1.md); this page shows how
to use it and is not normative.

Normal users never need any of this: the plugin's own buttons, picker and
settings cover the product.

## What you can build

| Goal | What you do |
| --- | --- |
| Replace the built-in action buttons | Render your own button and set the takeover signal. |
| Add a trigger without replacing anything | Render your own button or menu entry; never set the signal. |
| Restore files without rewinding the conversation | Call `commit` with `mode: 'files'`. |
| Your own target picker | List your own messages and pass each row's `seq`; the contract has no candidate query. |

## The minimum

Three calls, one attribute:

1. `GET /api/dsh-rewind/v1/health` — render nothing unless it answers
   `contract: 1`.
2. `POST /api/dsh-rewind/v1/preview` — describes what would happen.
3. `POST /api/dsh-rewind/v1/commit` — performs it, bound to `preview`'s
   `headSeq`.
4. If you are replacing the buttons, set
   `data-dsh-rewind-claim="<your-id>"` on `<html>` after step 1; remove it when
   your plugin unloads.

A row button, end to end:

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

This is what a minimal integration looks like: a single button, no dialog.

```js
if (await engineContract()) {
  document.documentElement.dataset.dshRewindClaim = 'my-one-click'
  // latestSeq: the newest user message's seq, read from your own chat rows
  const result = await rewindTo(sessionId, latestSeq, { files: false })
}
```

It deliberately ignores `withdraw` (no refill) and offers no file effect. The
withdrawn messages hide immediately and stay hidden after a reload.

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

- A leftover attribute keeps the native buttons hidden until the page reloads.
- Taking over includes the pending-steering retract; the plugin will not render
  it for you. Implement it with the session's own queue API (`updateQueue` with
  `remove`).
- Users can recover the native interface with the plugin config item
  `uiOwner: self` (a file-level setting, not a settings-card toggle).

## Packaging your plugin next to the engine

If your UI cannot work without the engine, install it as a dependency so adding
your plugin adds the engine too:

```json
{ "dependencies": { "dsh-rewind-plugin": "^1.0.0" } }
```

and insert its loader row in your bundle patch:

```yaml
- insert:
    - id: dsh-rewind-engine
      name: 'dsh-rewind-plugin'
```

Caveats:

- the row's `name` must be the package name; the client module and the loader
  resolve the package by that name;
- profiles install dependencies hoisted, so a transitive dependency resolves
  from the profile root;
- the dependency range only guides installation; the runtime gate is
  `health.contract`, which you already check;
- if a user already enabled dsh-rewind as its own bundle, inserting another row
  loads a second instance; the plugin cannot detect this today, so treat the two
  installation styles as either/or;
- updating the engine is independent of your release; stay on one contract major
  and gate on `health.contract`.

## Testing your integration

```bash
curl -s localhost:3080/api/dsh-rewind/v1/health
curl -s -X POST localhost:3080/api/dsh-rewind/v1/preview \
  -H 'content-type: application/json' -d '{"sessionId":"<id>","seq":42}'
curl -s -X POST localhost:3080/api/dsh-rewind/v1/commit \
  -H 'content-type: application/json' \
  -d '{"sessionId":"<id>","seq":42,"headSeq":137,"mode":"both"}'
```

Check the effect after a reload, not only in the page that performed it: the
withdrawn span must stay hidden.
