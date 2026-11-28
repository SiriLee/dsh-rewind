/**
 * v1 engine-contract probes: real `dsh-session` + real `SnapshotStore` on a
 * temporary directory, driven through the three exact routes and the real
 * checkpoint pipeline (`agent/pre-step`, `tools/execute`). The fake parts are
 * only the host services outside this plugin's ownership (agent registry,
 * connection registry, fs/working-directory) and the controlled Agent face the
 * engine's cancel/wait path needs.
 *
 * @module tests/engine-contract
 */
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createVolatile, updateVolatile } from '@deepseek-ai/cosmokit'
import { Context } from '@deepseek-ai/cordis'
import { FileSystem, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, type SessionSeq } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { apply } from '../src/index.ts'
import { REWIND_MARKER_SOURCE } from '../src/rewind.ts'
import { rewindMarkerDefinition } from '../src/client/marker-node.ts'
import { testConfig } from './helpers.ts'

const CAP_BYTES = 1024
const V1 = '/api/dsh-rewind/v1'

/** One exact route as the fake Connection registry stores it. */
interface Route {
  readonly path: string
  readonly methods: readonly string[]
  readonly fetch: (request: Request) => Promise<Response>
}

/** The event host methods the pipeline probes call. */
interface EventHost {
  waterfall(name: string, payload: unknown, next: () => Promise<unknown>): Promise<unknown>
}

/** The controlled Agent face the engine's cancel/wait path needs. */
interface AgentControl {
  readonly agent: Agent
  readonly cancel: ReturnType<typeof vi.fn>
  readonly remove: ReturnType<typeof vi.fn>
}

/** Real fs service stand-in: maps host paths and stats them. */
function fakeFs(): FileSystem {
  return {
    async resolve(path: string, opts: { cwd?: string } = {}) {
      const displayPath = opts.cwd !== undefined && !isAbsolute(path) ? join(opts.cwd, path) : path
      return { targetKey: FsTargetKey(displayPath), displayPath }
    },
    processPath(target: { displayPath: string }): string { return target.displayPath },
    processPathFromHostPath(hostPath: string): string | undefined {
      return isAbsolute(hostPath) ? hostPath : undefined
    },
    async stat(target: { displayPath: string }) {
      try {
        const info = await (await import('node:fs/promises')).stat(target.displayPath)
        if (info.isFile()) return { version: FsVersion('v'), type: 'file' as const, size: info.size }
        if (info.isDirectory()) return { version: FsVersion('v'), type: 'directory' as const }
        return { version: FsVersion('v'), type: 'other' as const }
      } catch {
        return undefined
      }
    },
  } as unknown as FileSystem
}

/** One mounted plugin plus the seams the cases drive. */
interface Harness {
  readonly ctx: Context
  readonly root: string
  readonly ws: string
  readonly snap: string
  readonly config: ReturnType<typeof testConfig>
  readonly routes: Map<string, Route>
  readonly agents: Map<string, Agent>
  readonly commands: Map<string, { readonly name: string; readonly handler: (invocation: unknown) => Promise<unknown> }>
  /** Make the next agent-registry lookup throw (the `internal` path). */
  faultRegistry(message: string): void
  appendUser(session: Session, text?: string): { message: UserMessage; seq: number }
  session(id: string): Session
  agentFor(session: Session): Agent
  runUserStep(session: Session, text: string | readonly ContentBlock[]): Promise<{ message: UserMessage; seq: number }>
  runTool(session: Session, path: string, content: string): Promise<void>
  runPatch(session: Session, input: string, mutate: () => Promise<void>): Promise<void>
  api(path: string, init: RequestInit): Promise<{ status: number; result: Record<string, unknown> }>
  preview(session: Session, seq: number): Promise<{ status: number; result: Record<string, unknown> }>
  commit(session: Session, body: Record<string, unknown>): Promise<{ status: number; result: Record<string, unknown> }>
  dispose(): Promise<void>
}

let cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  const pending = cleanups
  cleanups = []
  for (const cleanup of pending) await cleanup()
})

/** Build one isolated mount with real session/store and fake host services. */
async function createHarness(options: {
  readonly checkpointingEnabled?: boolean
  readonly maxFileBytes?: number
} = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-rewind-contract-'))
  const ws = join(root, 'ws')
  const snap = join(root, 'snapshots')
  await mkdir(ws, { recursive: true })

  const routes = new Map<string, Route>()
  const agents = new Map<string, Agent>()
  let registryFault: Error | undefined
  const commands = new Map<string, { name: string; handler: (invocation: unknown) => Promise<unknown> }>()
  const ctx = new Context()
  ctx.provide('commands', {
    register: (definition: { name: string; handler: (invocation: unknown) => Promise<unknown> }) => {
      commands.set(definition.name, definition)
      return async () => { commands.delete(definition.name) }
    },
  })
  ctx.provide('fs', fakeFs())
  ctx.provide('workingDirectory', { ensure: async () => ws })
  ctx.provide('agents', {
    get: (id: string) => {
      if (registryFault !== undefined) throw registryFault
      return agents.get(id)
    },
  })
  ctx.provide('settings', {
    configure: () => () => {},
    describe: () => [],
    update: async () => {},
    mutate: async () => {},
  })
  ctx.provide('connection', {
    fetch: {
      register: (route: Route) => {
        routes.set(route.path, route)
        return async () => { routes.delete(route.path) }
      },
    },
  })

  const config = testConfig({
    snapshotDir: snap,
    dshHome: root,
    maxFileBytes: options.maxFileBytes ?? CAP_BYTES,
    fileCheckpointingEnabled: options.checkpointingEnabled ?? true,
    autoCleanupEnabled: false,
  })
  apply(ctx, config)
  // Let the injected fs/workingDirectory and connection scopes install.
  await new Promise(resolve => setTimeout(resolve, 10))

  let turn = 0
  const defaultControl = makeControl({} as Session, 'idle')


  const agentFor = (session: Session): Agent => {
    const existing = agents.get(session.id)
    if (existing !== undefined) return existing
    const agent = {
      id: session.id,
      session,
      status: 'idle' as const,
      inbox: { nextStep: [], remove: defaultControl.remove },
      cancel: defaultControl.cancel,
      whenIdle: async () => {},
    } as unknown as Agent
    agents.set(session.id, agent)
    return agent
  }

  const harness: Harness = {
    ctx,
    root,
    ws,
    snap,
    config,
    routes,
    agents,
    commands,
    faultRegistry(message) { registryFault = new Error(message) },
    appendUser(session, text = 'hello') {
      agentFor(session)
      const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
      session.append('user/message', message, { surfaceOp: 'append' })
      return { message, seq: session.snapshotEvents().at(-1)!.seq }
    },
    session: id => Session.create(SessionId(id)),
    agentFor,
    async runUserStep(session, content) {
      const message = createUserMessage({
        content: typeof content === 'string' ? [{ type: 'text', text: content }] : content,
        source: { kind: 'user' },
      })
      const agent = agentFor(session)
      const decision = await (ctx as unknown as EventHost).waterfall('agent/pre-step', {
        agent,
        messages: [message],
        turn: ++turn,
        step: 1,
        signal: new AbortController().signal,
        modelSelection: { provider: 'test', model: 'test-model' },
      }, async () => ({ kind: 'enter', messages: [message] })) as { kind: string }
      if (decision.kind !== 'enter') throw new Error('pre-step rejected the test message')
      session.append('user/message', message, { surfaceOp: 'append' })
      return { message, seq: session.snapshotEvents().at(-1)!.seq }
    },
    async runTool(session, path, content) {
      await (ctx as unknown as EventHost).waterfall('tools/execute', {
        callId: `call-${++turn}-${Date.now()}`,
        name: 'write',
        arguments: { file_path: path },
        agent: agentFor(session),
        signal: new AbortController().signal,
      }, async () => {
        await writeFile(path, content)
        return { isError: false, content: [] }
      })
    },
    async runPatch(session, input, mutate) {
      await (ctx as unknown as EventHost).waterfall('tools/execute', {
        callId: `patch-${++turn}-${Date.now()}`,
        name: 'apply_patch',
        arguments: { input },
        agent: agentFor(session),
        signal: new AbortController().signal,
      }, async () => {
        await mutate()
        return { isError: false, content: [] }
      })
    },
    async api(path, init) {
      const route = routes.get(path)
      if (route === undefined) throw new Error(`route ${path} is not registered`)
      const response = await route.fetch(new Request(`http://localhost${path}`, init))
      return { status: response.status, result: await response.json() as Record<string, unknown> }
    },
    async preview(session, seq) {
      return harness.api(`${V1}/preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: session.id, seq }),
      })
    },
    async commit(session, body) {
      return harness.api(`${V1}/commit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: session.id, ...body }),
      })
    },
    async dispose() {
      await rm(root, { recursive: true, force: true })
    },
  }

  cleanups.push(() => harness.dispose())
  return harness
}

/** A fresh harness with an idle default agent. */
async function harness(options: { checkpointingEnabled?: boolean; maxFileBytes?: number } = {}): Promise<Harness> {
  return createHarness(options)
}

/** Build one controlled Agent bound to a session. */
function makeControl(
  session: Session,
  status: 'idle' | 'running',
  options: { whenIdle?: () => Promise<void>; steering?: UserMessage[]; onCancel?: () => void } = {},
): AgentControl {
  const state = {
    status,
    cancel: vi.fn(() => {
      options.onCancel?.()
      state.status = 'idle' as const
    }),
    remove: vi.fn(() => true),
    whenIdle: options.whenIdle ?? (async () => {}),
  }
  const agent = {
    id: session.id,
    session,
    get status() { return state.status },
    inbox: { nextStep: options.steering ?? [], remove: state.remove },
    cancel: state.cancel,
    whenIdle: () => state.whenIdle(),
  } as unknown as Agent
  return { agent, cancel: state.cancel, remove: state.remove }
}

/** The last session event must be this plugin's rewind marker. */
function hasMarker(session: Session): boolean {
  const last = session.snapshotEvents().at(-1)
  return last?.type === 'user/message' && last.data.source.kind === 'dsh-rewind'
}

/** Read one response's contract error code. */
function errorCode(result: Record<string, unknown>): unknown {
  const error = result['error']
  return typeof error === 'object' && error !== null ? (error as Record<string, unknown>)['code'] : undefined
}

/** Read one response's success value. */
function valueOf(result: Record<string, unknown>): Record<string, unknown> {
  return result['value'] as Record<string, unknown>
}

describe('v1 health', () => {
  it('reports the contract major over GET', async () => {
    const h = await harness()
    const { status, result } = await h.api(`${V1}/health`, { method: 'GET' })
    expect(status).toBe(200)
    expect(result).toEqual({ ok: true, value: { contract: 1 } })
    expect(h.routes.get(`${V1}/health`)?.methods).toEqual(['GET'])
  })
})

describe('v1 preview', () => {
  it('returns headSeq, withdraw (text + attachments), and a sorted file diff', async () => {
    const h = await harness()
    const session = h.session('preview-basic')
    const first = await h.runUserStep(session, 'first')
    const b = join(h.ws, 'b.txt')
    const a = join(h.ws, 'a.txt')
    await writeFile(a, 'a0'); await writeFile(b, 'b0')
    await h.runTool(session, a, 'a1')
    await h.runTool(session, b, 'b1')
    await h.runUserStep(session, 'second')
    await writeFile(a, 'a2'); await writeFile(b, 'b2')

    const { status, result } = await h.preview(session, first.seq)
    expect(status).toBe(200)
    const value = valueOf(result)
    expect(value['headSeq']).toBe(session.seq - 1)
    expect(value['withdraw']).toEqual({ text: 'first', attachments: [] })
    const files = value['files'] as Record<string, unknown>
    expect(files['available']).toBe(true)
    expect(files['changes']).toEqual([
      { path: a, action: 'restore' },
      { path: b, action: 'restore' },
    ])
    expect(files['skipped']).toEqual([])
  })

  it('passes the target message non-text blocks through as attachments', async () => {
    const h = await harness()
    const session = h.session('preview-attachments')
    const attachment = { attachmentId: 'sha256:abc', mediaType: 'image/png', bytes: 10, width: 2, height: 3 }
    const content = [
      { type: 'image', attachment },
      { type: 'text', text: 'look' },
    ] as unknown as ContentBlock[]
    const first = await h.runUserStep(session, content)
    const { result } = await h.preview(session, first.seq)
    const withdraw = valueOf(result)['withdraw'] as Record<string, unknown>
    expect(withdraw['text']).toBe('look')
    expect(withdraw['attachments']).toEqual([{ type: 'image', attachment }])
  })

  it('is read-only and repeatable', async () => {
    const h = await harness()
    const session = h.session('preview-repeat')
    const first = await h.runUserStep(session, 'first')
    const before = session.seq
    const one = await h.preview(session, first.seq)
    const two = await h.preview(session, first.seq)
    expect(two.result).toEqual(one.result)
    expect(session.seq).toBe(before)
    expect(hasMarker(session)).toBe(false)
  })

  it('reports no-checkpoint for a target the pipeline never recorded', async () => {
    const h = await harness()
    const session = h.session('preview-no-checkpoint')
    const first = h.appendUser(session)
    const { status, result } = await h.preview(session, first.seq)
    expect(status).toBe(200)
    expect(valueOf(result)['files']).toEqual({ available: false, reason: 'no-checkpoint' })
  })

  it('reports checkpointing-disabled when no checkpoint exists and recording is off', async () => {
    const h = await harness({ checkpointingEnabled: false })
    const session = h.session('preview-disabled')
    const first = h.appendUser(session)
    const { result } = await h.preview(session, first.seq)
    expect(valueOf(result)['files']).toEqual({ available: false, reason: 'checkpointing-disabled' })
  })

  it('keeps an existing checkpoint usable while recording is off', async () => {
    const h = await harness()
    const session = h.session('preview-disabled-existing')
    const first = await h.runUserStep(session, 'first')
    const file = join(h.ws, 'kept.txt')
    await writeFile(file, 'original')
    await h.runTool(session, file, 'edited')
    await h.runUserStep(session, 'second')
    await writeFile(file, 'external')
    updateVolatile(h.config.fileCheckpointingEnabled, createVolatile(false))
    const { result } = await h.preview(session, first.seq)
    const files = valueOf(result)['files'] as Record<string, unknown>
    expect(files['available']).toBe(true)
    expect(files['changes']).toEqual([{ path: file, action: 'restore' }])
  })

  it('reports store-unsupported as an availability reason', async () => {
    const h = await harness()
    const session = h.session('preview-newer-store')
    await mkdir(join(h.snap, session.id), { recursive: true })
    await writeFile(join(h.snap, session.id, 'meta.json'), JSON.stringify({ store: 9, sessionFormat: 4 }))
    const first = h.appendUser(session)
    const { result } = await h.preview(session, first.seq)
    expect(valueOf(result)['files']).toEqual({ available: false, reason: 'store-unsupported' })
  })

  it('lists oversized paths as skipped, never as changes', async () => {
    const h = await harness()
    const session = h.session('preview-oversized')
    const first = await h.runUserStep(session, 'first')
    const file = join(h.ws, 'cap.txt')
    await writeFile(file, 'ok')
    await h.runTool(session, file, 'ok')
    await h.runUserStep(session, 'second')
    await writeFile(file, 'x'.repeat(CAP_BYTES + 1))
    const { result } = await h.preview(session, first.seq)
    const files = valueOf(result)['files'] as Record<string, unknown>
    expect(files['available']).toBe(true)
    expect(files['changes']).toEqual([])
    expect(files['skipped']).toEqual([{ path: file, reason: 'oversized' }])
  })
})

describe('v1 commit', () => {
  it('conversation mode appends the marker and leaves the workspace untouched', async () => {
    const h = await harness()
    const session = h.session('commit-conversation')
    const first = await h.runUserStep(session, 'first')
    const file = join(h.ws, 'untouched.txt')
    await writeFile(file, 'original')
    await h.runTool(session, file, 'edited')
    await h.runUserStep(session, 'second')
    await writeFile(file, 'external')
    const headSeq = session.seq - 1
    const { status, result } = await h.commit(session, { seq: first.seq, headSeq, mode: 'conversation' })
    expect(status).toBe(200)
    expect(valueOf(result)).toEqual({ conversation: { rewound: true } })
    expect(hasMarker(session)).toBe(true)
    expect(await readFile(file, 'utf8')).toBe('external')
  })

  it('files mode restores the workspace and appends no event', async () => {
    const h = await harness()
    const session = h.session('commit-files')
    const first = await h.runUserStep(session, 'first')
    const file = join(h.ws, 'restore.txt')
    await writeFile(file, 'original')
    await h.runTool(session, file, 'edited')
    await h.runUserStep(session, 'second')
    await writeFile(file, 'external')
    const headSeq = session.seq - 1
    const { status, result } = await h.commit(session, { seq: first.seq, headSeq, mode: 'files' })
    expect(status).toBe(200)
    expect(valueOf(result)).toEqual({
      files: {
        applied: true,
        restored: [file],
        deleted: [],
        skipped: [],
        failed: [],
      },
    })
    expect(await readFile(file, 'utf8')).toBe('original')
    expect(session.seq - 1).toBe(headSeq)
  })

  it('both mode performs both effects and reports only the requested ones', async () => {
    const h = await harness()
    const session = h.session('commit-both')
    const first = await h.runUserStep(session, 'first')
    const file = join(h.ws, 'both.txt')
    await writeFile(file, 'original')
    await h.runTool(session, file, 'edited')
    await h.runUserStep(session, 'second')
    await writeFile(file, 'external')
    const { result } = await h.commit(session, { seq: first.seq, headSeq: session.seq - 1, mode: 'both' })
    const value = valueOf(result)
    expect(value['conversation']).toEqual({ rewound: true })
    expect((value['files'] as Record<string, unknown>)['applied']).toBe(true)
    expect(hasMarker(session)).toBe(true)
    expect(await readFile(file, 'utf8')).toBe('original')
  })

  it('files mode is repeatable from the same target checkpoint', async () => {
    const h = await harness()
    const session = h.session('commit-files-repeat')
    const first = await h.runUserStep(session, 'first')
    const file = join(h.ws, 'repeat.txt')
    await writeFile(file, 'original')
    await h.runTool(session, file, 'edited')
    await h.runUserStep(session, 'second')
    await writeFile(file, 'external')
    const headSeq = session.seq - 1
    const one = await h.commit(session, { seq: first.seq, headSeq, mode: 'files' })
    expect(one.status).toBe(200)
    const two = await h.commit(session, { seq: first.seq, headSeq, mode: 'files' })
    expect(two.status).toBe(200)
    expect((valueOf(two.result)['files'] as Record<string, unknown>)['applied']).toBe(true)
    expect((valueOf(two.result)['files'] as Record<string, unknown>)['restored']).toEqual([])
    expect(await readFile(file, 'utf8')).toBe('original')
    expect(session.seq - 1).toBe(headSeq)
  })

  it('conversation mode cannot be replayed after the marker moves the head', async () => {
    const h = await harness()
    const session = h.session('commit-conversation-repeat')
    const first = await h.runUserStep(session, 'first')
    const headSeq = session.seq - 1
    expect((await h.commit(session, { seq: first.seq, headSeq, mode: 'conversation' })).status).toBe(200)
    const again = await h.commit(session, { seq: first.seq, headSeq, mode: 'conversation' })
    expect(again.status).toBe(409)
    expect(errorCode(again.result)).toBe('head-changed')
    const markers = session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'dsh-rewind')
    expect(markers).toHaveLength(1)
  })

  it('head-changed causes no write and no cancellation', async () => {
    const h = await harness()
    const session = h.session('commit-head-changed')
    const first = await h.runUserStep(session, 'first')
    const file = join(h.ws, 'head.txt')
    await writeFile(file, 'original')
    await h.runTool(session, file, 'edited')
    await h.runUserStep(session, 'second')
    await writeFile(file, 'external')
    const control = makeControl(session, 'running', { whenIdle: async () => {} })
    h.agents.set(session.id, control.agent)
    const stale = session.seq - 5
    const { status, result } = await h.commit(session, { seq: first.seq, headSeq: stale, mode: 'both' })
    expect(status).toBe(409)
    expect(errorCode(result)).toBe('head-changed')
    expect(control.cancel).not.toHaveBeenCalled()
    expect(hasMarker(session)).toBe(false)
    expect(await readFile(file, 'utf8')).toBe('external')
  })

  it('files-only while a turn runs returns turn-running without cancelling', async () => {
    const h = await harness()
    const session = h.session('commit-files-running')
    const first = await h.runUserStep(session, 'first')
    const control = makeControl(session, 'running', { whenIdle: async () => {} })
    h.agents.set(session.id, control.agent)
    const { status, result } = await h.commit(session, { seq: first.seq, headSeq: session.seq - 1, mode: 'files' })
    expect(status).toBe(409)
    expect(errorCode(result)).toBe('turn-running')
    expect(control.cancel).not.toHaveBeenCalled()
    expect(hasMarker(session)).toBe(false)
  })

  it('conversation mode cancels a running turn, drops steering and keeps queued work', async () => {
    const h = await harness()
    const session = h.session('commit-cancel')
    const first = await h.runUserStep(session, 'first')
    const steering = createUserMessage({ content: [{ type: 'text', text: 'steer' }], source: { kind: 'user' } })
    const control = makeControl(session, 'running', { steering: [steering] })
    h.agents.set(session.id, control.agent)
    const { status } = await h.commit(session, { seq: first.seq, headSeq: session.seq - 1, mode: 'conversation' })
    expect(status).toBe(200)
    expect(control.cancel).toHaveBeenCalledTimes(1)
    expect(control.remove).toHaveBeenCalledWith(steering.id)
    expect(hasMarker(session)).toBe(true)
  })

  it('plans after cancellation so a late surface event is inside the marker', async () => {
    const h = await harness()
    const session = h.session('commit-cancel-plan')
    const first = await h.runUserStep(session, 'first')
    const late = createAssistantMessage({
      content: [{ type: 'text', text: 'late tool result' }],
      source: { provider: 'test', model: 'test-model' },
    })
    let lateSeq: number | undefined
    const control = makeControl(session, 'running', {
      onCancel: () => {
        session.append('assistant/message', { turn: 1, step: 1, message: late, stream: [] }, { surfaceOp: 'append' })
        lateSeq = session.snapshotEvents().at(-1)!.seq
      },
    })
    h.agents.set(session.id, control.agent)
    const { status } = await h.commit(session, { seq: first.seq, headSeq: session.seq - 1, mode: 'conversation' })
    expect(status).toBe(200)
    expect(lateSeq).toBeDefined()
    const marker = session.snapshotEvents().at(-1)!
    expect(marker.type).toBe('user/message')
    if (marker.type !== 'user/message' || typeof marker.surfaceOp !== 'object') throw new Error('not a marker')
    expect(marker.surfaceOp.endSeq).toBe(lateSeq)
    expect(marker.sourceEventSeqs).toContain(lateSeq)
    expect(session.surface.nodes).not.toContain(lateSeq)
  })

  it('conversation mode returns turn-running when the turn cannot stop', async () => {
    const h = await harness()
    const session = h.session('commit-turn-running')
    const first = await h.runUserStep(session, 'first')
    const control = makeControl(session, 'running', {
      whenIdle: async () => { throw new Error('the turn is stuck') },
    })
    h.agents.set(session.id, control.agent)
    const { status, result } = await h.commit(session, { seq: first.seq, headSeq: session.seq - 1, mode: 'conversation' })
    expect(status).toBe(409)
    expect(errorCode(result)).toBe('turn-running')
    expect(control.cancel).toHaveBeenCalledTimes(1)
    expect(hasMarker(session)).toBe(false)
  })

  it('rejects a concurrent commit on the same session and isolates other sessions', async () => {
    const h = await harness()
    const session = h.session('commit-in-flight')
    const first = await h.runUserStep(session, 'first')
    let release!: () => void
    const idle = new Promise<void>((resolve) => { release = resolve })
    const control = makeControl(session, 'running', { whenIdle: () => idle })
    h.agents.set(session.id, control.agent)
    const headSeq = session.seq - 1
    const slow = h.commit(session, { seq: first.seq, headSeq, mode: 'conversation' })
    // Let the first commit acquire the session and reach its cancel/wait.
    await vi.waitFor(() => expect(control.cancel).toHaveBeenCalled())
    const second = await h.commit(session, { seq: first.seq, headSeq, mode: 'conversation' })
    expect(second.status).toBe(409)
    expect(errorCode(second.result)).toBe('commit-in-flight')

    const other = h.session('commit-other-session')
    const otherFirst = await h.runUserStep(other, 'first')
    const otherAgent = makeControl(other, 'idle')
    h.agents.set(other.id, otherAgent.agent)
    const otherCommit = await h.commit(other, { seq: otherFirst.seq, headSeq: other.seq - 1, mode: 'conversation' })
    expect(otherCommit.status).toBe(200)

    release()
    expect((await slow).status).toBe(200)
  })

  it('keeps the conversation effect when a newer store makes files unavailable', async () => {
    const h = await harness()
    const session = h.session('commit-newer-store')
    await mkdir(join(h.snap, session.id), { recursive: true })
    await writeFile(join(h.snap, session.id, 'meta.json'), JSON.stringify({ store: 9, sessionFormat: 4 }))
    const first = h.appendUser(session)
    const file = join(h.ws, 'newer.txt')
    await writeFile(file, 'keep')
    const { status, result } = await h.commit(session, { seq: first.seq, headSeq: session.seq - 1, mode: 'both' })
    expect(status).toBe(200)
    const value = valueOf(result)
    expect(value['conversation']).toEqual({ rewound: true })
    expect(value['files']).toEqual({ applied: false, reason: 'store-unsupported' })
    expect(hasMarker(session)).toBe(true)
    expect(await readFile(file, 'utf8')).toBe('keep')
  })

  it('reports missing checkpoints as unavailable instead of failing the commit', async () => {
    const h = await harness()
    const session = h.session('commit-no-checkpoint')
    const first = h.appendUser(session)
    const { status, result } = await h.commit(session, { seq: first.seq, headSeq: session.seq - 1, mode: 'both' })
    expect(status).toBe(200)
    const value = valueOf(result)
    expect(value['conversation']).toEqual({ rewound: true })
    expect(value['files']).toEqual({ applied: false, reason: 'no-checkpoint' })
  })

  it.skipIf(process.platform === 'win32')('reports a replaced parent as parent-changed', async () => {
    const h = await harness()
    const session = h.session('commit-skipped-parent')
    const first = await h.runUserStep(session, 'first')
    const dir = join(h.ws, 'moving')
    await mkdir(dir, { recursive: true })
    const file = join(dir, 'a.txt')
    await writeFile(file, 'original')
    await h.runTool(session, file, 'edited')
    await h.runUserStep(session, 'second')
    await rename(dir, join(h.ws, 'moved'))
    // The display path now resolves through a symlink to another real directory.
    await symlink(join(h.ws, 'moved'), dir)
    const { result } = await h.commit(session, { seq: first.seq, headSeq: session.seq - 1, mode: 'files' })
    const files = valueOf(result)['files'] as Record<string, unknown>
    expect(files['applied']).toBe(true)
    expect(files['skipped']).toEqual([{ path: file, reason: 'parent-changed' }])
  })

  it.skipIf(process.platform === 'win32')('reports an unsafe target path as skipped', async () => {
    const h = await harness()
    const session = h.session('commit-skipped-unsafe')
    const first = await h.runUserStep(session, 'first')
    const file = join(h.ws, 'link.txt')
    const victim = join(h.ws, 'victim.txt')
    await writeFile(file, 'original')
    await h.runTool(session, file, 'edited')
    await h.runUserStep(session, 'second')
    await writeFile(victim, 'victim')
    await rm(file)
    await symlink(victim, file)
    const { result } = await h.commit(session, { seq: first.seq, headSeq: session.seq - 1, mode: 'files' })
    const files = valueOf(result)['files'] as Record<string, unknown>
    expect(files['applied']).toBe(true)
    expect(files['skipped']).toEqual([{ path: file, reason: 'unsafe' }])
    expect(await readFile(victim, 'utf8')).toBe('victim')
  })

  it('preview and a following commit describe the same file diff', async () => {
    const h = await harness()
    const session = h.session('commit-parity')
    const first = await h.runUserStep(session, 'first')
    const file = join(h.ws, 'parity.txt')
    await writeFile(file, 'original')
    await h.runTool(session, file, 'edited')
    await h.runUserStep(session, 'second')
    await writeFile(file, 'external')
    const preview = await h.preview(session, first.seq)
    const previewFiles = valueOf(preview.result)['files'] as Record<string, unknown>
    const { result } = await h.commit(session, { seq: first.seq, headSeq: valueOf(preview.result)['headSeq'] as number, mode: 'files' })
    const commitFiles = valueOf(result)['files'] as Record<string, unknown>
    expect(commitFiles['restored']).toEqual((previewFiles['changes'] as Array<Record<string, unknown>>)
      .filter(change => change['action'] === 'restore')
      .map(change => change['path']))
    expect(commitFiles['deleted']).toEqual((previewFiles['changes'] as Array<Record<string, unknown>>)
      .filter(change => change['action'] === 'delete')
      .map(change => change['path']))
  })
})

describe('apply_patch checkpoint coverage', () => {
  /** Add a later message, then commit a files-only rewind to `seq`. */
  const rewindTo = async (h: Harness, session: Session, seq: number) => {
    await h.runUserStep(session, 'second')
    return h.commit(session, { seq, headSeq: session.seq - 1, mode: 'files' })
  }

  it('restores an update of a file the target checkpoint did not track', async () => {
    const h = await harness()
    const session = h.session('patch-update')
    const file = join(h.ws, 'update.txt')
    await writeFile(file, 'original')
    const first = await h.runUserStep(session, 'first')
    await h.runPatch(session, '*** Begin Patch\n*** Update File: update.txt\n@@\n-original\n+patched\n*** End Patch', async () => {
      await writeFile(file, 'patched')
    })
    const { status, result } = await rewindTo(h, session, first.seq)
    expect(status).toBe(200)
    const files = valueOf(result)['files'] as Record<string, unknown>
    expect(files['restored']).toEqual([file])
    expect(await readFile(file, 'utf8')).toBe('original')
  })

  it('deletes a file an apply_patch added after the target', async () => {
    const h = await harness()
    const session = h.session('patch-add')
    const first = await h.runUserStep(session, 'first')
    const file = join(h.ws, 'created.txt')
    await h.runPatch(session, '*** Begin Patch\n*** Add File: created.txt\n+new\n*** End Patch', async () => {
      await writeFile(file, 'new')
    })
    const { status, result } = await rewindTo(h, session, first.seq)
    expect(status).toBe(200)
    const files = valueOf(result)['files'] as Record<string, unknown>
    expect(files['deleted']).toEqual([file])
    await expect(readFile(file, 'utf8')).rejects.toThrow()
  })

  it('restores a file an apply_patch deleted after the target', async () => {
    const h = await harness()
    const session = h.session('patch-delete')
    const file = join(h.ws, 'deleted.txt')
    await writeFile(file, 'keep')
    const first = await h.runUserStep(session, 'first')
    await h.runPatch(session, '*** Begin Patch\n*** Delete File: deleted.txt\n*** End Patch', async () => {
      await rm(file)
    })
    const { status, result } = await rewindTo(h, session, first.seq)
    expect(status).toBe(200)
    const files = valueOf(result)['files'] as Record<string, unknown>
    expect(files['restored']).toEqual([file])
    expect(await readFile(file, 'utf8')).toBe('keep')
  })

  it('restores a move source and deletes its destination', async () => {
    const h = await harness()
    const session = h.session('patch-move')
    const from = join(h.ws, 'from.txt')
    const to = join(h.ws, 'to.txt')
    await writeFile(from, 'content')
    const first = await h.runUserStep(session, 'first')
    await h.runPatch(session, '*** Begin Patch\n*** Update File: from.txt\n*** Move to: to.txt\n@@\n-content\n+content\n*** End Patch', async () => {
      await rename(from, to)
    })
    const { status, result } = await rewindTo(h, session, first.seq)
    expect(status).toBe(200)
    const files = valueOf(result)['files'] as Record<string, unknown>
    expect(files['restored']).toEqual([from])
    expect(files['deleted']).toEqual([to])
    expect(await readFile(from, 'utf8')).toBe('content')
    await expect(readFile(to, 'utf8')).rejects.toThrow()
  })
})

describe('engine idle wait', () => {
  it('gives up when the running turn does not reach idle', async () => {
    const { waitForAgentIdle } = await import('../src/engine.ts')
    const agent = {
      whenIdle: () => new Promise<void>(() => {}),
    } as unknown as Agent
    await expect(waitForAgentIdle(agent, undefined, 5)).resolves.toBe(false)
  })
})

describe('v1 error codes', () => {
  it('rejects malformed requests with bad-request', async () => {
    const h = await harness()
    const session = h.session('errors-bad-request')
    const first = h.appendUser(session)
    const cases: Array<[string, RequestInit]> = [
      [`${V1}/preview`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' }],
      [`${V1}/preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' }],
      [`${V1}/preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ seq: first.seq }) }],
      [`${V1}/preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: session.id }) }],
      [`${V1}/preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: session.id, seq: 1.5 }) }],
      [`${V1}/commit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: session.id, seq: first.seq, headSeq: 0 }) }],
      [`${V1}/commit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: session.id, seq: first.seq, headSeq: 0, mode: 'chat' }) }],
    ]
    for (const [path, init] of cases) {
      const { status, result } = await h.api(path, init)
      expect(status).toBe(400)
      expect(errorCode(result)).toBe('bad-request')
    }
  })

  it('returns session-not-found for an unattached session', async () => {
    const h = await harness()
    const session = h.session('errors-unknown')
    const first = h.appendUser(session)
    h.agents.delete(session.id)
    const { status, result } = await h.preview(session, first.seq)
    expect(status).toBe(404)
    expect(errorCode(result)).toBe('session-not-found')
  })

  it('the real marker event matches the client Definition', async () => {
    const h = await harness()
    const session = h.session('marker-shape')
    const target = await h.runUserStep(session, 'rewind me')
    const { status } = await h.commit(session, {
      seq: target.seq,
      headSeq: session.seq - 1,
      mode: 'conversation',
    })
    expect(status).toBe(200)
    const marker = session.snapshotEvents().at(-1)!
    if (marker.type !== 'user/message') throw new Error('expected a marker event')
    const definition = rewindMarkerDefinition()
    expect(definition.match['user/message'](marker)).toEqual({ id: marker.data.id, role: 'start' })
    const view = definition.buildViewNode({
      start: { event: marker },
      state: { target: target.seq, marker: marker.seq },
    })
    expect(view?.data.rewind).toEqual({ target: target.seq, marker: marker.seq })
  })

  it('internal candidates route lists the full surface', async () => {
    const h = await harness()
    const session = h.session('candidates')
    const first = await h.runUserStep(session, 'first')
    const second = await h.runUserStep(session, 'second')
    const { status, result } = await h.api('/api/dsh-rewind/candidates', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: session.id }),
    })
    expect(status).toBe(200)
    const value = result.value as { candidates: { seq: number }[] }
    expect(value.candidates.map(candidate => candidate.seq)).toEqual([second.seq, first.seq])
  })

  it('returns target-missing for unknown, non-user and shadowed seqs', async () => {
    const h = await harness()
    const session = h.session('errors-target')
    const first = await h.runUserStep(session, 'first')
    const second = await h.runUserStep(session, 'second')
    const assistant = createAssistantMessage({
      content: [{ type: 'text', text: 'not-human' }],
      source: { provider: 'test', model: 'test-model' },
    })
    session.append('assistant/message', { turn: 1, step: 1, message: assistant, stream: [] }, { surfaceOp: 'append' })
    const assistantSeq = session.snapshotEvents().at(-1)!.seq
    // A rewind marker replaces the surface from `first` onward; `first` becomes shadowed.
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: '(empty message)' }], source: REWIND_MARKER_SOURCE }), {
      surfaceOp: { op: 'replace', startSeq: first.seq as SessionSeq, endSeq: assistantSeq as SessionSeq },
      sourceEventSeqs: [first.seq, second.seq, assistantSeq] as SessionSeq[],
    })
    for (const seq of [999_999, assistantSeq, first.seq]) {
      const { status, result } = await h.preview(session, seq)
      expect(status).toBe(404)
      expect(errorCode(result)).toBe('target-missing')
    }
  })

  it('returns internal for an unexpected registry fault', async () => {
    const h = await harness()
    const session = h.session('errors-internal')
    const first = h.appendUser(session)
    h.faultRegistry('registry down')
    const { status, result } = await h.preview(session, first.seq)
    expect(status).toBe(500)
    expect(errorCode(result)).toBe('internal')
  })
})
