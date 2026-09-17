/**
 * Live-unload lifecycle probes for the host half.
 *
 * The live plugin manager can disable the plugin at any moment, and the fiber's
 * disposer is the only teardown it gets. Each probe mounts the REAL `apply` on a
 * minimal fake context (the same service surface the harness provides: `effect`,
 * `inject`, `on`, `commands.register`, `logger`), drives one listener, and then
 * runs every registered disposer — the host half must leave nothing behind.
 *
 * The fake context exists because the repository has no host-lifecycle harness
 * (`verify-host.mjs` drives commands, not unloads): its contract is deliberately
 * narrow, and a change that needs another service shows up as a mount failure.
 *
 * @module tests/lifecycle-roundtrip
 */
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { en as enLocale, zh as zLocale } from '../src/locales.ts'
import { apply } from '../src/index.ts'
import { textMessage } from './helpers.ts'

/** A function a mount yielded; its return value is awaited on dispose. */
type Disposer = () => unknown

/** The recorded surface of one mounted plugin. */
interface Mounted {
  readonly ctx: Context
  readonly logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> }
  /** Registered `/rewind`-family commands, by command name. */
  readonly commands: ReadonlyMap<string, { readonly name: string; readonly description?: string; readonly handler: (invocation: unknown) => Promise<unknown> }>
  /** `ctx.on` handlers, by event name. */
  readonly handlers: ReadonlyMap<string, (...args: never[]) => unknown>
  /** `tools/*` handlers registered by the nested `fs` scope, by event name. */
  readonly toolHandlers: ReadonlyMap<string, (...args: never[]) => unknown>
  /** The policy reads the mounted settings scope answered (one per `load()`). */
  readonly policyReads: () => number
  /** Teardown of the injected settings scope ALONE (a live-reload service restart). */
  disposeSettingsScope(): Promise<void>
  /** Run every disposer (depth-first) and await the async ones. */
  dispose(): Promise<void>
}

/** One fake fs service, only the members `captureBefore` reads. */
const fakeFs = () => ({
  resolve: async (path: string) => ({ displayPath: path }),
  stat: async () => ({ type: 'file', size: 3, mode: 0o644 }),
})

/** Drive one `ctx.effect` callback: a disposer-returning function or a generator. */
function collect(fn: unknown, into: Disposer[]): void {
  if (typeof fn !== 'function') return
  const result = (fn as () => unknown)()
  if (typeof result === 'function') {
    into.push(result as Disposer)
    return
  }
  const iterator = (result as { next?: unknown } | null)?.next
  if (typeof iterator !== 'function') return
  const it = result as Iterator<unknown>
  for (;;) {
    const step = it.next()
    if (step.done === true) break
    if (typeof step.value === 'function') into.push(step.value as Disposer)
  }
}

/**
 * Mount the plugin on a minimal fake context.
 * @param options - the optional services the mount may reach: `settings` (with
 *   an optional persisted locale preference) and `fs`.
 * @returns the mount's recorded surface plus its disposer.
 */
function mount(options: { settings?: { locale?: string }; fs?: boolean } = {}): Mounted {
  const disposers: Disposer[] = []
  const settingsDisposers: Disposer[] = []
  const commands = new Map<string, { name: string; description?: string; handler: (invocation: unknown) => Promise<unknown> }>()
  const handlers = new Map<string, (...args: never[]) => unknown>()
  const toolHandlers = new Map<string, (...args: never[]) => unknown>()
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  // The host reads the resolved policy through `scope.get()`; one counter per
  // mount is what makes "the one-shot sweep gate re-armed on remount" observable.
  const policyRead = vi.fn(() => ({ enabled: false, maxAgeDays: 30 }))

  const ctx = {
    effect: (fn: unknown) => { collect(fn, disposers); return () => {} },
    on: (event: string, handler: (...args: never[]) => unknown) => { handlers.set(event, handler); return () => {} },
    logger,
    commands: {
      register: (definition: { name: string; description?: string; handler: (invocation: unknown) => Promise<unknown> }) => {
        commands.set(definition.name, definition)
        return () => {}
      },
    },
    inject: (services: readonly string[], callback: (scoped: unknown) => void) => {
      if (services.includes('settings') && options.settings !== undefined) {
        const preference = options.settings.locale
        callback({
          // The injected scope is a real child context: it has `effect` (the
          // plugin registers its store disposer on it) and its own services.
          effect: (fn: unknown) => { collect(fn, settingsDisposers); return () => {} },
          settings: {
            get: () => (preference === undefined ? undefined : { preference }),
            register: () => ({ get: () => policyRead(), update: async () => {} }),
          },
        })
      }
      if (services.includes('fs') && options.fs === true) {
        callback({
          fs: fakeFs(),
          on: (event: string, handler: (...args: never[]) => unknown) => { toolHandlers.set(event, handler); return () => {} },
        })
      }
    },
  } as unknown as Context

  return {
    ctx,
    logger,
    commands,
    handlers,
    toolHandlers,
    policyReads: () => policyRead.mock.calls.length,
    disposeSettingsScope: async () => {
      for (const dispose of settingsDisposers.splice(0).reverse()) await dispose()
    },
    dispose: async () => {
      // Reverse order, like a real fiber teardown; await async disposers so the
      // assertions can rely on their effects having landed.
      const pending = disposers.splice(0).reverse()
      for (const dispose of pending) await dispose()
    },
  }
}

let root: string
let snapRoot: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-rewind-lifecycle-'))
  snapRoot = join(root, 'snapshots')
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

/**
 * The files staged under the store's `.pending/` areas — discovered by walking
 * the store root, so the probe does not depend on how a session id is encoded
 * into its directory name.
 */
async function stagedFiles(): Promise<string[]> {
  const staged: string[] = []
  for (const session of await readdir(snapRoot).catch(() => [])) {
    staged.push(...await readdir(join(snapRoot, session, '.pending')).catch(() => []))
  }
  return staged
}

/**
 * Poll until nothing is staged. The `tools/result` safety net discards on a
 * voided promise (`void discardCapture(...)`) — it must never block the tool
 * result — so its unlink lands a tick later.
 * @returns the staged names seen by the last poll.
 */
async function waitForStagedDrain(): Promise<string[]> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const staged = await stagedFiles()
    if (staged.length === 0) return staged
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return stagedFiles()
}

describe('host mount lifecycle', () => {
  it('registers the rewind command family once per mount', async () => {
    const first = mount()
    apply(first.ctx, { snapshotDir: snapRoot })
    expect([...first.commands.keys()].sort()).toEqual(['rewind', 'snapshot-auto-cleanup', 'undo'])
    await first.dispose()

    const second = mount()
    apply(second.ctx, { snapshotDir: snapRoot })
    expect([...second.commands.keys()].sort()).toEqual(['rewind', 'snapshot-auto-cleanup', 'undo'])
    await second.dispose()
  })

  it('drops staged before-captures when the plugin is unloaded mid-tool', async () => {
    const mounted = mount({ fs: true })
    apply(mounted.ctx, { snapshotDir: snapRoot })

    // A real file for the capture to copy bytes from.
    const target = join(root, 'edited.txt')
    await writeFile(target, 'before', 'utf8')
    const session = Session.create(SessionId('lifecycle-session'))
    const execute = mounted.toolHandlers.get('tools/execute')
    expect(execute).toBeDefined()
    await execute!(
      { name: 'write', callId: 'call-1', arguments: { file_path: target }, agent: { id: 'agent-1', session }, signal: undefined } as never,
      (async () => ({ ok: true })) as never,
    )

    // Staged, not committed: the bytes wait for `tools/post-execute`.
    expect(await stagedFiles()).toHaveLength(1)

    // Unload between the two stages (the exact window a live disable lands in).
    await mounted.dispose()
    expect(await stagedFiles()).toEqual([])
  })

  it('a tool result drains its staged capture before the unload', async () => {
    const mounted = mount({ fs: true })
    apply(mounted.ctx, { snapshotDir: snapRoot })
    const target = join(root, 'edited.txt')
    await writeFile(target, 'before', 'utf8')
    const session = Session.create(SessionId('lifecycle-session'))
    await mounted.toolHandlers.get('tools/execute')!(
      { name: 'write', callId: 'call-1', arguments: { file_path: target }, agent: { id: 'agent-1', session }, signal: undefined } as never,
      (async () => ({ ok: true })) as never,
    )
    expect(await stagedFiles()).toHaveLength(1)
    mounted.toolHandlers.get('tools/result')!(
      { name: 'write', callId: 'call-1', arguments: { file_path: target }, agent: { id: 'agent-1', session } } as never,
    )
    // The safety net already dropped it, so the unload has nothing left to do.
    expect(await waitForStagedDrain()).toEqual([])
    await mounted.dispose()
    expect(await stagedFiles()).toEqual([])
  })
})

describe('live disable → enable round trip', () => {
  /** One `user/message` event, the practical auto-cleanup trigger. */
  const userMessage = (): [Session, { type: string; seq: number }] => {
    const session = Session.create(SessionId('lifecycle-session'))
    const event = session.append('user/message', textMessage('hello'), { surfaceOp: 'append' })
    return [session, event]
  }

  /** Poll until `check` holds; the auto-cleanup path is voided, not awaited. */
  async function waitUntil(check: () => boolean): Promise<boolean> {
    for (let attempt = 0; attempt < 50; attempt++) {
      if (check()) return true
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    return check()
  }

  it('re-reads the locale preference instead of inheriting the previous mount', async () => {
    const zh = mount({ settings: { locale: 'zh' } })
    apply(zh.ctx, { snapshotDir: snapRoot })
    const zhDescription = zh.commands.get('snapshot-auto-cleanup')!.description
    expect(zhDescription).toBe(zLocale['cleanup.description'])
    await zh.dispose()

    // No persisted preference this time: the command copy must fall back to the
    // neutral English default rather than the previous mount's Chinese.
    const en = mount({ settings: {} })
    apply(en.ctx, { snapshotDir: snapRoot })
    expect(en.commands.get('snapshot-auto-cleanup')!.description).toBe(enLocale['cleanup.description'])
    await en.dispose()
  })

  it('re-arms the one-shot auto-cleanup check on every mount', async () => {
    const first = mount({ settings: {} })
    apply(first.ctx, { snapshotDir: snapRoot })
    const [firstSession] = userMessage()
    first.handlers.get('session/event')!(firstSession as never, { type: 'user/message', seq: 2 } as never)
    expect(await waitUntil(() => first.policyReads() > 0)).toBe(true)
    await first.dispose()

    // The previous mount consumed the one-shot gate; a fresh mount must check
    // again (the flag is per mount, the 24h throttle itself is on disk).
    const second = mount({ settings: {} })
    apply(second.ctx, { snapshotDir: snapRoot })
    const [secondSession] = userMessage()
    second.handlers.get('session/event')!(secondSession as never, { type: 'user/message', seq: 2 } as never)
    expect(await waitUntil(() => second.policyReads() > 0)).toBe(true)
    await second.dispose()
  })

  it('fails the cleanup command closed after the settings scope is gone', async () => {
    const mounted = mount({ settings: {} })
    apply(mounted.ctx, { snapshotDir: snapRoot })
    const cleanup = mounted.commands.get('snapshot-auto-cleanup')!
    const [session] = userMessage()
    const invocation = { rawInput: 'status', agent: { session } } as never

    const mountedResult = await cleanup.handler(invocation) as { kind: string }
    expect(mountedResult.kind).toBe('success')

    // The settings service unmounting (a live-reload restart) disposes the
    // injected scope while the plugin stays mounted. The store handle must be
    // cleared with it, so the read fails closed instead of touching it.
    await mounted.disposeSettingsScope()
    const disposedResult = await cleanup.handler(invocation) as { kind: string; text: string }
    expect(disposedResult.kind).toBe('error')
    expect(disposedResult.text).toContain('settings service unavailable')
  })
})
