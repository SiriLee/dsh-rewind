/**
 * Live-unload lifecycle probes for the host half: each one mounts the REAL
 * `apply` on a minimal fake context (the service surface the harness provides),
 * drives one listener, then runs every registered disposer — the host half must
 * leave nothing behind, because a live disable is the only teardown it gets.
 *
 * The fake exists because `verify-host.mjs` drives commands, not unloads; a
 * mount that needs another service fails loudly.
 *
 * @module tests/lifecycle-roundtrip
 */
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createVolatile, updateVolatile } from '@deepseek-ai/cosmokit'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { en as enLocale } from '../src/locales.ts'
import { apply, cleanupConfigKey, inject } from '../src/index.ts'
import { resolveCleanupStatePath } from '../src/snapshot-cleanup.ts'
import { testConfig, textMessage } from './helpers.ts'

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
  /**
   * Set the Loader entry id the host reads (`ctx.fiber.entry.id`). A real mount
   * always has one, and a bundled row's id carries the loader's `include:`
   * prefix; tests that exercise the cleanup policy set it before `apply`.
   */
  setEntryId(id: string): void
  /** Entry ids the settings double was written through, in order. */
  settingsWrites(): readonly string[]
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
 * @param options - the optional services the mount may reach (a real fs).
 * @returns the mount's recorded surface plus its disposer.
 */
function mount(options: { fs?: boolean } = {}): Mounted {
  const disposers: Disposer[] = []
  const commands = new Map<string, { name: string; description?: string; handler: (invocation: unknown) => Promise<unknown> }>()
  const handlers = new Map<string, (...args: never[]) => unknown>()
  const toolHandlers = new Map<string, (...args: never[]) => unknown>()
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  // The Loader entry id the cleanup policy is addressed by; absent until a test
  // sets it (an entry-less mount has nowhere to write).
  const fiber: { entry?: { id: string } } = {}
  // The settings entry-write port, recording which id each write addressed.
  const settingsWrites: string[] = []
  const settings = {
    update: vi.fn(async (id: string) => { settingsWrites.push(id) }),
    mutate: vi.fn(async (id: string) => { settingsWrites.push(id) }),
  }

  const ctx = {
    fiber,
    settings,
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
    settingsWrites: () => [...settingsWrites],
    setEntryId: (id: string) => { fiber.entry = { id } },
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
  it('drops staged before-captures when the plugin is unloaded mid-tool', async () => {
    const mounted = mount({ fs: true })
    apply(mounted.ctx, testConfig({ snapshotDir: snapRoot }))

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
    apply(mounted.ctx, testConfig({ snapshotDir: snapRoot }))
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
  it('declares every service the mount reaches, so cordis can inject it', () => {
    // The cleanup policy writes through the settings service, and cordis refuses
    // an undeclared service access ("cannot get property … without inject") — a
    // runtime-only failure a direct `apply(ctx)` probe cannot see, because the
    // fake context hands over every service. The declared list is the pin.
    expect([...inject].sort()).toEqual(['commands', 'settings', 'tools'])
  })

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

  it('reads the live config on every call instead of a stale snapshot', async () => {
    const mounted = mount()
    mounted.setEntryId('include:dsh-rewind-plugin')
    const enabled = createVolatile(false)
    apply(mounted.ctx, { ...testConfig({ snapshotDir: snapRoot }), enabled })
    const cleanup = mounted.commands.get('snapshot-auto-cleanup')!
    const [session] = userMessage()
    const status = { rawInput: 'status', agent: { session } } as never
    expect(((await cleanup.handler(status)) as { text: string }).text)
      .toContain(enLocale['cleanup.status'].replace('{state}', enLocale['cleanup.disabled']).replace('{days}', '30'))

    // A settings write updates the reference in place; the next call must see
    // the new value without a remount.
    updateVolatile(enabled, createVolatile(true))
    expect(((await cleanup.handler(status)) as { text: string }).text)
      .toContain(enLocale['cleanup.status'].replace('{state}', enLocale['cleanup.enabled']).replace('{days}', '30'))
    await mounted.dispose()
  })

  it('re-arms the one-shot auto-cleanup check on every mount', async () => {
    // The gate reads the policy once per mount and, only when enabled, sweeps
    // and re-anchors the 24h window — the state file is the observable proof
    // that the policy was read. A fresh mount must check again.
    const stateFile = resolveCleanupStatePath(root)
    await rm(stateFile, { force: true })
    const first = mount()
    first.setEntryId('include:dsh-rewind-plugin')
    apply(first.ctx, testConfig({ snapshotDir: snapRoot, dshHome: root, enabled: true }))
    const [firstSession] = userMessage()
    first.handlers.get('session/event')!(firstSession as never, { type: 'user/message', seq: 2 } as never)
    expect(await waitUntil(() => existsSync(stateFile))).toBe(true)
    await first.dispose()

    // The previous mount consumed the one-shot gate; a fresh mount must check
    // again (the flag is per mount, the 24h throttle itself is on disk).
    await rm(stateFile, { force: true })
    const second = mount()
    second.setEntryId('include:dsh-rewind-plugin')
    apply(second.ctx, testConfig({ snapshotDir: snapRoot, dshHome: root, enabled: true }))
    const [secondSession] = userMessage()
    second.handlers.get('session/event')!(secondSession as never, { type: 'user/message', seq: 2 } as never)
    expect(await waitUntil(() => existsSync(stateFile))).toBe(true)
    await second.dispose()
  })

  it('fails the cleanup command closed without a resolved config', async () => {
    // A mount without the Loader resolves no config, so the policy has nowhere
    // to read or write; every path must fail closed instead of guessing.
    const mounted = mount()
    apply(mounted.ctx)
    const cleanup = mounted.commands.get('snapshot-auto-cleanup')!
    const [session] = userMessage()
    const invocation = { rawInput: 'status', agent: { session } } as never
    const result = await cleanup.handler(invocation) as { kind: string; text: string }
    expect(result.kind).toBe('error')
    expect(result.text).toContain('cleanup policy unavailable')
  })

  it('addresses the PROFILE ROW id, not the fiber\'s nested include id', () => {
    // The loader mounts a bundle's rows under an `include:` scope, while the
    // settings service keys entries and profile patches by the bare row id; a
    // write addressed by the fiber id is refused at runtime.
    expect(cleanupConfigKey('include:dsh-rewind-plugin')).toBe('dsh-rewind-plugin')
    expect(cleanupConfigKey('dsh-rewind-plugin')).toBe('dsh-rewind-plugin')
    expect(cleanupConfigKey(undefined)).toBeUndefined()
  })

  it('writes the policy through the bare row id a real command resolves', async () => {
    const mounted = mount()
    mounted.setEntryId('include:dsh-rewind-plugin')
    apply(mounted.ctx, testConfig({ snapshotDir: snapRoot }))
    const cleanup = mounted.commands.get('snapshot-auto-cleanup')!
    const [session] = userMessage()
    const on = { rawInput: 'on', agent: { session } } as never
    expect((await cleanup.handler(on) as { kind: string }).kind).toBe('success')
    // Both writes (the defaulted cutoff is cleared, `enabled` is set) address the
    // bare row id.
    const writes = mounted.settingsWrites()
    expect(writes.length).toBeGreaterThan(0)
    expect(writes.every(id => id === 'dsh-rewind-plugin')).toBe(true)
  })

  it('fails closed when a config resolved but the Loader entry did not', async () => {
    // A mount without the Loader has a config to read but no entry id to write
    // back to, so mounting the store would report values it can never persist.
    // It must stay unmounted.
    const mounted = mount()
    apply(mounted.ctx, testConfig({ snapshotDir: snapRoot }))
    const cleanup = mounted.commands.get('snapshot-auto-cleanup')!
    const [session] = userMessage()
    const status = { rawInput: 'status', agent: { session } } as never
    expect((await cleanup.handler(status) as { kind: string }).kind).toBe('error')
    const on = { rawInput: 'on', agent: { session } } as never
    expect((await cleanup.handler(on) as { kind: string }).kind).toBe('error')
  })
})
