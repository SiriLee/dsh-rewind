# Browser diagnostics

[简体中文](diagnostics.zh.md)

Every browser-side diagnostic this plugin emits is routed through one small,
level-filtered channel, so an anomaly surfaces under a single console filter.
The channel is deliberately narrow: it records only genuine internal anomalies
the plugin itself detects as off-contract — **not** the normal-path facts the
user already sees on screen, which carry no attribution.

## Always-on anomaly alerts

`error` and `warn` are always printed (no switch, no configuration) so a fault
surfaces even for a user who never configured anything:

| Level | Meaning |
| --- | --- |
| `error` | Unexpected/breaking failure (e.g. the settings card fails to register) |
| `warn` | Recoverable anomaly guard (e.g. a rewind command/refill throws, a waited-on outcome never settles, an unmet session binding) |

These cases are rare, cheap, and off-contract. Normal-path detail (which
branch a refill took, whether a write matched, which rows a rewind cut) is
deliberately **not** logged: it re-states what the user already sees and adds
nothing to attribution.

## Scopes

Diagnostics are printed as `[dsh-rewind:<scope>] ...`. The scope names the
subsystem an anomaly belongs to, so a report can be captured with a single
console filter:

| Scope | What an anomaly here means |
| --- | --- |
| `boot` | Startup identity — `loaded v<version> (build <hash>)`, gated by the verbose switch (see below). Confirms the running bundle matches a fix. |
| `refill` | The composer refill after a rewind (command/wait/refill throws, an outcome that never settles) |
| `portals` | Per-message button mount issues (e.g. no session binding) |
| `settings` | The snapshot-cleanup settings card |
| `hiding` | **Reserved** — no active alert at present. If a future row-hiding diagnostic is added, it belongs in this region. |

## Verbose switch

The `info`/`debug` levels are gated by `localStorage['dsh-rewind.debug']`, read
once per call and filtered by namespace. After the withdrawal of the restating
verbose detail, exactly **one** verbose line remains: the `boot` scope's startup
identity line. It is deliberately **off** by default (a normal user's console
stays clean, and it is not an anomaly), so a reporter enables the scope to see
it:

```js
// Just the startup identity line.
localStorage['dsh-rewind.debug'] = 'dsh-rewind:boot'

// Or everything (avoids needing an exact scope).
localStorage['dsh-rewind.debug'] = 'dsh-rewind*'
```

Reload (`F5`) after setting it. To switch it off:

```js
delete localStorage['dsh-rewind.debug']
```

The `error`/`warn` anomaly alerts are **not** gated by this switch — they are
always printed. The other verbose detail (used write channel, an empty
hide-set, per-rewind lifecycle lines) has been withdrawn: it re-stated behavior
the user already sees and carried no attribution.

## Capturing a report

1. Reproduce once on the affected page.
2. In DevTools, filter the Console for `[dsh-rewind]` and copy the output
   (with the plugin version and the DSH/kernel version).

The `error`/`warn` anomaly alerts require no setup — they always print. To also
capture the startup identity line (`boot`) — useful for ruling out a stale
bundle / un-restarted host — enable the verbose switch first (see above), then
reload.

## Notes

- This diagnostic surface is an aid for maintainers and cooperating reporters,
  **not** a stable public interface; its exact keys and output may change
  without notice.
- It is scoped to one browser origin and one browser; capture where the problem
  actually occurs.
