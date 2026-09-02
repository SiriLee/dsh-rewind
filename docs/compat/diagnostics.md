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
| `refill` | The composer refill after a rewind (command/wait/refill throws, an outcome that never settles) |
| `portals` | Per-message button mount issues (e.g. no session binding) |
| `settings` | The snapshot-cleanup settings card |
| `hiding` | **Reserved** — no active alert at present. If a future row-hiding diagnostic is added, it belongs in this region. |

## Reserved: verbose switch

A previously-shipped `localStorage['dsh-rewind.debug']` switch gated `info`/
`debug` detail (the used write channel, an empty hide-set, per-rewind lifecycle
lines). That gated verbose output has been withdrawn: those lines re-stated
behavior the user already sees and carried no attribution, and the `hiding`
scope now has no active alert.

The switch's layered scaffold (the DEBUG key, the namespace filter, the
always-on `error`/`warn` rule) is retained as a dormant shell and may be wired
up again if a genuinely attributable diagnostic is added. Until then the switch
is inert: a stale value in `localStorage['dsh-rewind.debug']` is silently ignored.

```js
// The key is no longer read. A stale value is harmless and ignored —
// removing it is optional.
delete localStorage['dsh-rewind.debug']
```

## Capturing a report

1. Reproduce once on the affected page.
2. In DevTools, filter the Console for `[dsh-rewind]` and copy the output
   (with the plugin version and the DSH/kernel version).

No setup is required: `error`/`warn` anomalies always print.

## Notes

- This diagnostic surface is an aid for maintainers and cooperating reporters,
  **not** a stable public interface; its exact keys and output may change
  without notice.
- It is scoped to one browser origin and one browser; capture where the problem
  actually occurs.

Related: [audit.md](audit.md) for the verified-compatibility matrix and
[troubleshooting.md](troubleshooting.md) for the legacy repair steps.
