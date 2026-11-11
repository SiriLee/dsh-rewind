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
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createVolatile, updateVolatile } from '@deepseek-ai/cosmokit'
import { SESSION_FORMAT_VERSION, Session, SessionId, type UserMessage } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { en as enLocale, zh as zhLocale } from '../src/locales.ts'
import { apply, Config, profileEntryKey, ENGINE_COMMAND, inject } from '../src/index.ts'
import { resolveCleanupStatePath } from '../src/snapshot-cleanup.ts'
import { testConfig, textMessage } from './helpers.ts'

/** A function a mount yielded; its return value is awaited on dispose. */
type Disposer = () => unknown

/** The recorded surface of one mounted plugin. */
interface Mounted {
  readonly ctx: Context
  readonly logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> }
  /** Registered engine commands, by command name. */
  readonly commands: ReadonlyMap<string, { readonly name: string; readonly description?: string; readonly input?: { readonly hint: string }; readonly handler: (invocation: unknown) => Promise<unknown> }>
  /** Occupy one command name before `apply`, standing in for a third-party plugin. */
  occupyCommand(name: string): void
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
  /**
   * Replace the descriptors the settings double answers `describe()` with. The
   * real service describes every active entry; the host read filters for the
   * `locale` row, and an empty list is the English default.
   */
  setLocaleRows(rows: readonly { readonly ns: string; readonly value: unknown }[]): void
  /** Every `describe()` argument the mount passed, in order. */
  describeCalls(): readonly unknown[]
  /** Break the settings read: `absent` removes `describe`, `throws` faults it. */
  breakDescribe(mode: 'absent' | 'throws'): void
  /** Entry ids the settings double was written through, in order. */
  settingsWrites(): readonly string[]
  /** Run every disposer (depth-first) and await the async ones. */
  dispose(): Promise<void>
}

/** One fake fs service, only the members `captureBefore` reads. */
const fakeFs = () => ({
  resolve: async (path: string) => ({ displayPath: path }),
  // Every path this double names is a host path (the local backend).
  processPathFromHostPath: (hostPath: string) => hostPath,
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
  // The descriptors `describe()` answers with — the settings read the host uses
  // for the user's language. Empty until a test stages a `locale` row.
  const localeRows: { ns: string; value: unknown }[] = []
  const describeCalls: unknown[] = []
  const settings: Record<string, unknown> = {
    update: vi.fn(async (id: string) => { settingsWrites.push(id) }),
    mutate: vi.fn(async (id: string) => { settingsWrites.push(id) }),
    describe: (options?: unknown) => { describeCalls.push(options); return localeRows },
  }

  const ctx = {
    fiber,
    settings,
    effect: (fn: unknown) => { collect(fn, disposers); return () => {} },
    on: (event: string, handler: (...args: never[]) => unknown) => { handlers.set(event, handler); return () => {} },
    logger,
    commands: {
      register: (definition: { name: string; description?: string; input?: { hint: string }; handler: (invocation: unknown) => Promise<unknown> }) => {
        // Like the real registry: one name is unique per layer.
        if (commands.has(definition.name)) throw new Error(`command "${definition.name}" is already registered`)
        commands.set(definition.name, definition)
        return () => {}
      },
    },
    inject: (services: readonly string[], callback: (scoped: unknown) => void) => {
      if (services.includes('fs') && options.fs === true) {
        callback({
          fs: fakeFs(),
          // Absolute file_paths here: the base value only has to exist.
          workingDirectory: { ensure: async () => root },
          // The injected scope is a real Context: it carries `effect` for the
          // registrations the plugin owns on it.
          effect: (fn: unknown) => { collect(fn, disposers); return () => {} },
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
    occupyCommand: (name: string) => {
      commands.set(name, { name, description: 'third-party', handler: async () => ({ kind: 'success' }) })
    },
    setLocaleRows: (rows) => { localeRows.splice(0, localeRows.length, ...rows) },
    describeCalls: () => [...describeCalls],
    breakDescribe: (mode) => {
      if (mode === 'absent') delete settings.describe
      else settings.describe = () => { throw new Error('settings service unavailable') }
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

/** Read one session's checkpoint manifests. */
async function readCheckpoints(session: Session): Promise<Record<string, unknown>[]> {
  const dir = join(snapRoot, session.id, 'checkpoints')
  const names = (await readdir(dir).catch(() => [] as string[])).filter(name => name.endsWith('.json')).sort()
  return await Promise.all(names.map(async name => JSON.parse(await readFile(join(dir, name), 'utf8')) as Record<string, unknown>))
}

/** Drive the plugin's pre-step listener as the agent loop would. */
async function preStep(mounted: Mounted, session: Session, messages: readonly UserMessage[], decision: 'enter' | 'reject' = 'enter'): Promise<unknown> {
  const handler = mounted.handlers.get('agent/pre-step') as unknown as (
    payload: unknown,
    next: () => Promise<unknown>,
  ) => Promise<unknown>
  return await handler(
    { agent: { id: 'agent-1', session }, messages },
    async () => decision === 'enter' ? { kind: 'enter', messages } : { kind: 'reject' },
  )
}

/** One write/edit dispatch: the plugin captures before, then the fake body writes. */
async function dispatchWrite(mounted: Mounted, session: Session, path: string, content: string | Buffer): Promise<void> {
  await mounted.toolHandlers.get('tools/execute')!(
    { name: 'write', callId: `call-${Date.now()}-${Math.random()}`, arguments: { file_path: path }, agent: { id: 'agent-1', session }, signal: undefined } as never,
    (async () => { await writeFile(path, content); return { isError: false, content: [] } }) as never,
  )
}

describe('host mount lifecycle', () => {
  it('registers the pre-step boundary and the first-touch hook, not the old post-execute pipeline', async () => {
    const mounted = mount({ fs: true })
    apply(mounted.ctx, testConfig({ snapshotDir: snapRoot }))
    expect(typeof mounted.handlers.get('agent/pre-step')).toBe('function')
    expect(typeof mounted.toolHandlers.get('tools/execute')).toBe('function')
    expect(mounted.toolHandlers.get('tools/post-execute')).toBeUndefined()
    expect(mounted.toolHandlers.get('tools/result')).toBeUndefined()
    await mounted.dispose()
  })

  it('creates checkpoints without the fs service', async () => {
    const mounted = mount()
    apply(mounted.ctx, testConfig({ snapshotDir: snapRoot }))
    const session = Session.create(SessionId('no-fs-session'))
    const message = textMessage('first')
    expect(await preStep(mounted, session, [message])).toMatchObject({ kind: 'enter' })
    session.append('user/message', message, { surfaceOp: 'append' })
    expect(await readCheckpoints(session)).toHaveLength(1)
    await mounted.dispose()
  })

  it('reports a missing checkpoint with one clause separator', async () => {
    const mounted = mount()
    apply(mounted.ctx, testConfig({ snapshotDir: snapRoot }))
    const session = Session.create(SessionId('no-checkpoint-result'))
    const message = textMessage('old')
    session.append('user/message', message, { surfaceOp: 'append' })
    const seq = session.snapshotEvents().at(-1)!.seq
    const agent = {
      id: session.id,
      session,
      status: 'idle',
      inbox: { nextStep: [], remove: () => true },
      whenIdle: async () => {},
      cancel: () => {},
    }
    const result = await mounted.commands.get('rewind')!.handler({
      agent, rawInput: `@${seq} both`, signal: new AbortController().signal,
    }) as { kind: string; text: string }
    expect(result.kind).toBe('success')
    expect(result.text).toContain('; no file checkpoint exists for the target message')
    expect(result.text).not.toContain(';;')
    await mounted.dispose()
  })

  it('creates one checkpoint per user message and adds the first-touch row to current', async () => {
    const mounted = mount({ fs: true })
    apply(mounted.ctx, testConfig({ snapshotDir: snapRoot }))
    const session = Session.create(SessionId('pipeline-session'))
    const target = join(root, 'a.txt')
    await writeFile(target, 'one', 'utf8')
    const message = textMessage('first')
    expect(await preStep(mounted, session, [message])).toMatchObject({ kind: 'enter' })
    session.append('user/message', message, { surfaceOp: 'append' })

    let checkpoints = await readCheckpoints(session)
    expect(checkpoints).toHaveLength(1)
    expect(checkpoints[0]!['files']).toEqual({})

    await dispatchWrite(mounted, session, target, 'two')
    checkpoints = await readCheckpoints(session)
    expect((checkpoints[0]!['files'] as Record<string, unknown>)[target]).toMatchObject({ v: 1, size: 3 })
    await mounted.dispose()
  })

  it('deduplicates repeated message ids in one batch', async () => {
    const mounted = mount({ fs: true })
    apply(mounted.ctx, testConfig({ snapshotDir: snapRoot }))
    const session = Session.create(SessionId('dedupe-session'))
    const message = textMessage('first')
    expect(await preStep(mounted, session, [message, message])).toMatchObject({ kind: 'enter' })
    session.append('user/message', message, { surfaceOp: 'append' })
    expect(await readCheckpoints(session)).toHaveLength(1)
    await mounted.dispose()
  })

  it('creates two checkpoints for a two-message batch with identical files', async () => {
    const mounted = mount({ fs: true })
    apply(mounted.ctx, testConfig({ snapshotDir: snapRoot }))
    const session = Session.create(SessionId('batch-session'))
    const first = textMessage('first')
    const second = textMessage('second')
    expect(await preStep(mounted, session, [first, second])).toMatchObject({ kind: 'enter' })
    session.append('user/message', first, { surfaceOp: 'append' })
    session.append('user/message', second, { surfaceOp: 'append' })

    const checkpoints = await readCheckpoints(session)
    expect(checkpoints).toHaveLength(2)
    expect(checkpoints[0]!['files']).toEqual(checkpoints[1]!['files'])
    await mounted.dispose()
  })

  it('ignores runtime-context and subagent messages', async () => {
    const mounted = mount({ fs: true })
    apply(mounted.ctx, testConfig({ snapshotDir: snapRoot }))

    const contextSession = Session.create(SessionId('context-session'))
    const context = createUserMessage({ content: [{ type: 'text', text: 'context' }], source: { kind: 'runtime-context' } as never })
    expect(await preStep(mounted, contextSession, [context])).toMatchObject({ kind: 'enter' })
    contextSession.append('user/message', context, { surfaceOp: 'append' })
    expect(await readCheckpoints(contextSession)).toEqual([])

    const sub = Session.create(SessionId('subagent-session'), undefined, {
      version: SESSION_FORMAT_VERSION,
      id: SessionId('subagent-session'),
      createdAt: Date.now(),
      isSeeded: false,
      origin: 'subagent',
    })
    const message = textMessage('delegated')
    expect(await preStep(mounted, sub, [message])).toMatchObject({ kind: 'enter' })
    sub.append('user/message', message, { surfaceOp: 'append' })
    expect(await readCheckpoints(sub)).toEqual([])
    await mounted.dispose()
  })

  it('creates no checkpoint when another listener rejects the step', async () => {
    const mounted = mount({ fs: true })
    apply(mounted.ctx, testConfig({ snapshotDir: snapRoot }))
    const session = Session.create(SessionId('reject-session'))
    const message = textMessage('first')
    expect(await preStep(mounted, session, [message], 'reject')).toMatchObject({ kind: 'reject' })
    expect(await readCheckpoints(session)).toEqual([])
    await mounted.dispose()
  })

  it('does not carry a current checkpoint across a switch-off gap', async () => {
    const mounted = mount({ fs: true })
    const enabled = createVolatile(true)
    apply(mounted.ctx, { ...testConfig({ snapshotDir: snapRoot }), fileCheckpointingEnabled: enabled })
    const session = Session.create(SessionId('switch-session'))
    const first = textMessage('first')
    await preStep(mounted, session, [first])
    session.append('user/message', first, { surfaceOp: 'append' })
    const one = join(root, 'one.txt')
    await writeFile(one, 'one', 'utf8')
    await dispatchWrite(mounted, session, one, 'one')

    updateVolatile(enabled, createVolatile(false))
    const second = textMessage('second')
    await preStep(mounted, session, [second])
    session.append('user/message', second, { surfaceOp: 'append' })
    const two = join(root, 'two.txt')
    await writeFile(two, 'two', 'utf8')
    await dispatchWrite(mounted, session, two, 'two')

    updateVolatile(enabled, createVolatile(true))
    const third = textMessage('third')
    await preStep(mounted, session, [third])
    session.append('user/message', third, { surfaceOp: 'append' })
    await dispatchWrite(mounted, session, two, 'three')

    const checkpoints = await readCheckpoints(session)
    expect(checkpoints).toHaveLength(2)
    const thirdCheckpoint = checkpoints.find(cp => cp['messageId'] === third.id)!
    expect(Object.keys(thirdCheckpoint['files'] as Record<string, unknown>)).toContain(one)
    expect(Object.keys(thirdCheckpoint['files'] as Record<string, unknown>)).toContain(two)
    await mounted.dispose()
  })

  it('ignores legacy snapshot options without failing the mount', () => {
    const resolved = Config({ snapshotDir: snapRoot, dedup: true, maxAnchorGroups: 5 })
    expect(resolved.snapshotDir).toBe(snapRoot)
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
    const autoCleanupEnabled = createVolatile(false)
    apply(mounted.ctx, { ...testConfig({ snapshotDir: snapRoot }), autoCleanupEnabled })
    const cleanup = mounted.commands.get('snapshot-auto-cleanup')!
    const [session] = userMessage()
    const status = { rawInput: 'status', agent: { session } } as never
    expect(((await cleanup.handler(status)) as { text: string }).text)
      .toContain(enLocale['cleanup.status'].replace('{state}', enLocale['cleanup.disabled']).replace('{days}', '30'))

    // A settings write updates the reference in place; the next call must see
    // the new value without a remount.
    updateVolatile(autoCleanupEnabled, createVolatile(true))
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
    const first = mount({ fs: true })
    first.setEntryId('include:dsh-rewind-plugin')
    apply(first.ctx, testConfig({ snapshotDir: snapRoot, dshHome: root, autoCleanupEnabled: true }))
    const [firstSession] = userMessage()
    await preStep(first, firstSession, [])
    expect(await waitUntil(() => existsSync(stateFile))).toBe(true)
    await first.dispose()

    // The previous mount consumed the one-shot gate; a fresh mount must check
    // again (the flag is per mount, the 24h throttle itself is on disk).
    await rm(stateFile, { force: true })
    const second = mount({ fs: true })
    second.setEntryId('include:dsh-rewind-plugin')
    apply(second.ctx, testConfig({ snapshotDir: snapRoot, dshHome: root, autoCleanupEnabled: true }))
    const [secondSession] = userMessage()
    await preStep(second, secondSession, [])
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
    expect(profileEntryKey('include:dsh-rewind-plugin')).toBe('dsh-rewind-plugin')
    expect(profileEntryKey('dsh-rewind-plugin')).toBe('dsh-rewind-plugin')
    expect(profileEntryKey(undefined)).toBeUndefined()
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

/**
 * The host renders its own copy from the user's durable language preference,
 * which DSH 0.1.7 keeps in the `locale` entry's Config rather than in a
 * registered settings section: the mount reads it through the settings
 * service's descriptor read.
 */
describe('host language preference', () => {
  // The default policy (disabled, 30 days) as each dictionary renders it.
  const rendered = (dict: Record<string, string>): string => dict['cleanup.status']!
    .replace('{state}', dict['cleanup.disabled']!)
    .replace('{days}', '30')
  const enStatus = rendered(enLocale)
  const zhStatus = rendered(zhLocale)
  const zhRow = { ns: 'locale', value: { preference: 'zh' } }

  /** Run the status path of `/snapshot-auto-cleanup` on a mounted plugin. */
  async function cleanupStatus(mounted: Mounted): Promise<{ kind: string; text: string }> {
    const session = Session.create(SessionId('locale-session'))
    const cleanup = mounted.commands.get('snapshot-auto-cleanup')!
    return await cleanup.handler({ rawInput: 'status', agent: { session } } as never) as { kind: string; text: string }
  }

  it('renders command descriptions and results in the picked language', async () => {
    const mounted = mount()
    mounted.setLocaleRows([zhRow])
    mounted.setEntryId('include:dsh-rewind-plugin')
    apply(mounted.ctx, testConfig({ snapshotDir: snapRoot }))

    // The mount-time read covers the descriptions, which register once.
    expect(mounted.commands.get('rewind')!.description).toBe(zhLocale['command.description'])
    expect(mounted.commands.get('undo')!.description).toBe(zhLocale['command.undoDescription'])
    expect(mounted.commands.get(ENGINE_COMMAND)!.description).toBe(zhLocale['engine.description'])
    expect(mounted.commands.get(ENGINE_COMMAND)!.input!.hint).toBe(zhLocale['engine.inputHint'])
    expect(mounted.commands.get('snapshot-auto-cleanup')!.description).toBe(zhLocale['cleanup.description'])
    // A command result renders in the same language.
    expect((await cleanupStatus(mounted)).text).toContain(zhStatus)
    await mounted.dispose()
  })

  it('costs only the colliding name when a third-party plugin already owns it', async () => {
    const mounted = mount()
    mounted.setEntryId('include:dsh-rewind-plugin')
    mounted.occupyCommand('rewind')
    apply(mounted.ctx, testConfig({ snapshotDir: snapRoot }))

    // The occupant's row is untouched, and every other command registered.
    expect(mounted.commands.get('rewind')!.description).toBe('third-party')
    expect(mounted.commands.get('undo')).toBeDefined()
    expect(mounted.commands.get(ENGINE_COMMAND)).toBeDefined()
    expect(mounted.commands.get('snapshot-auto-cleanup')).toBeDefined()
    expect(mounted.logger.warn).toHaveBeenCalledWith(expect.stringContaining('"rewind" is already registered'))
    await mounted.dispose()
  })

  it('refuses an empty engine invocation instead of rewinding', async () => {
    const mounted = mount()
    mounted.setEntryId('include:dsh-rewind-plugin')
    apply(mounted.ctx, testConfig({ snapshotDir: snapRoot }))

    const result = await mounted.commands.get(ENGINE_COMMAND)!.handler({ rawInput: '   ' }) as { kind: string; text?: string }
    expect(result.kind).toBe('error')
    expect(result.text).toBe(enLocale['engine.rejected'])
    await mounted.dispose()
  })

  it('ignores a `preference` carried by an entry that is not the locale one', async () => {
    // `ui-theme` really does carry a `preference` field (`system`/`dark`/`light`),
    // so the read must select the `locale` entry instead of the first row that
    // happens to name the field.
    const mounted = mount()
    mounted.setLocaleRows([{ ns: 'ui-theme', value: { preference: 'system' } }])
    mounted.setEntryId('include:dsh-rewind-plugin')
    apply(mounted.ctx, testConfig({ snapshotDir: snapRoot }))

    expect(mounted.commands.get('rewind')!.description).toBe(enLocale['command.description'])
    expect((await cleanupStatus(mounted)).text).toContain(enStatus)
    await mounted.dispose()
  })

  it('re-reads the preference before every command, so a switch needs no remount', async () => {
    const mounted = mount()
    mounted.setEntryId('include:dsh-rewind-plugin')
    apply(mounted.ctx, testConfig({ snapshotDir: snapRoot }))
    // No preference staged: the neutral default.
    expect((await cleanupStatus(mounted)).text).toContain(enStatus)

    mounted.setLocaleRows([zhRow])
    expect((await cleanupStatus(mounted)).text).toContain(zhStatus)
    await mounted.dispose()
  })

  it('reads descriptors with secrets redacted, like every other wire reader', async () => {
    const mounted = mount()
    mounted.setEntryId('include:dsh-rewind-plugin')
    apply(mounted.ctx, testConfig({ snapshotDir: snapRoot }))
    await cleanupStatus(mounted)

    const calls = mounted.describeCalls()
    expect(calls.length).toBeGreaterThan(0)
    // The descriptors span every plugin entry, so the read never asks for
    // secret values it does not need.
    expect(calls.every(call => (call as { redactSecrets?: boolean }).redactSecrets === true)).toBe(true)
    await mounted.dispose()
  })

  it.each(['absent', 'throws'] as const)(
    'degrades to the neutral default when the settings read is %s',
    async (mode) => {
      const mounted = mount()
      mounted.breakDescribe(mode)
      mounted.setEntryId('include:dsh-rewind-plugin')
      apply(mounted.ctx, testConfig({ snapshotDir: snapRoot }))

      expect(mounted.commands.get('rewind')!.description).toBe(enLocale['command.description'])
      expect((await cleanupStatus(mounted)).text).toContain(enStatus)
      await mounted.dispose()
    },
  )
})
