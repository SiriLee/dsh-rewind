# Browser diagnostics and the verbose switch

[简体中文](diagnostics.zh.md)

Every browser-side diagnostic this plugin emits goes through one small
channel, so a report can be captured with a single console filter and a
verbose mode can be switched on without a plugin rebuild.

## Scope-prefixed output

Diagnostics are printed as `[dsh-rewind:<scope>] ...`. The scope names the
subsystem, and is also what the verbose switch filters on:

| Scope | What it reports |
| --- | --- |
| `hiding` | The row-hiding path (which rows a rewind cuts; the `rewind not hidden` anomaly) |
| `refill` | The composer refill after a rewind (target seq, mode, used channel, write result) |
| `portals` | Per-message button mount issues (e.g. no session binding) |
| `settings` | The snapshot-cleanup settings card |

## Levels

| Level | Default | Meaning |
| --- | --- | --- |
| `error` | on | Unexpected/breaking; always printed |
| `warn` | on | Recoverable anomaly guard (`rewind not hidden`, `refill skipped/refused/threw`); always printed |
| `info` | off | Event-level lifecycle (one line per rewind / refill) |
| `debug` | off | Per-batch detail (the per-refresh hiding picture) |

`error`/`warn` are always printed so an anomaly surfaces even for a user who
never touched the switch; `info`/`debug` are gated so a normal user's console
stays clean and streaming does not flood it.

## Enabling verbose output

The switch lives in the **browser's** `localStorage` under the plugin's own
key, so it can never enable another plugin/feature and nothing else can wake
this one. Set it, reload the page, reproduce, then filter the console for
`[dsh-rewind]`:

```js
// Every dsh-rewind namespace.
localStorage['dsh-rewind.debug'] = 'dsh-rewind*'

// Or just the subsystem you care about (exact scope match).
localStorage['dsh-rewind.debug'] = 'dsh-rewind:refill'

// Several at once (comma-separated).
localStorage['dsh-rewind.debug'] = 'dsh-rewind:refill,dsh-rewind:hiding'
```

Reload (`F5`) after setting it. To switch it off:

```js
delete localStorage['dsh-rewind.debug']
```

## Capturing a report

1. On the machine/browser page that reproduces the problem, enable the
   relevant namespace (see above) and reload.
2. Reproduce once.
3. In DevTools, filter the Console for `[dsh-rewind]` and copy the output
   (with the plugin version and the DSH/kernel version).

For a rewind that did not refill the composer, the `refill` scope is what
matters: its `composer write` line reports whether the draft was restored
through the harness facade (`facade`) or the DOM fallback (`dom`) and whether
the write succeeded, which tells a plugin fault apart from a harness-side
render desync.

## Notes

- The switch is an aid for maintainers and cooperating reporters, **not** a
  stable public interface; its exact keys and output may change without notice.
- It is scoped to one browser origin and one browser; enable it where the
  problem actually occurs.

Related: [audit.md](audit.md) for the verified-compatibility matrix and
[troubleshooting.md](troubleshooting.md) for the legacy repair steps.
