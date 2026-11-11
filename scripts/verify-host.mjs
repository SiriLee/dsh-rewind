#!/usr/bin/env node
/**
 * Host-half verification: boots the built plugin (`lib/index.js`) on a real
 * cordis context with a real dsh-session, drives the checkpoint pipeline
 * (pre-step manifests + tools/execute first touches), the read-only API routes
 * and the `/rewind` command end to end — no model, no UI. Files are real files
 * under a temporary directory, so restores are checked against real content.
 *
 * Run: `npm run build && node scripts/verify-host.mjs`
 *
 * What it proves:
 *  1. the plugin registers `/rewind`, `/undo`, the engine channel and the
 *     cleanup command;
 *  2. one dense checkpoint per user message is written at `agent/pre-step`;
 *  3. a `write` first touch records the pre-touch state before the body;
 *  4. preview and both-mode restore agree on the target manifest;
 *  5. a file created after the target is deleted;
 *  5b. a running turn is cancelled and quiesced before the cut;
 *  6. a target without a checkpoint performs only the conversation rewind and
 *     reports it;
 *  7. a newer store fails the file operation closed while the conversation
 *     rewind still works;
 *  8. an over-cap tracked file is skipped and reported, never overwritten;
 *  9. a path that becomes a symlink is skipped, never written through;
 * 10. `/snapshot-auto-cleanup run --current` clears the session directory.
 */
import { Context } from '@deepseek-ai/cordis'
import { CommandId } from '@deepseek-ai/dsh-commands'
import { FileSystem, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { apply, Config } from '../lib/index.js'

const aborted = () => new AbortController().signal
const tmpRoot = await mkdtemp(join(tmpdir(), 'dsh-rewind-verify-'))
const wsDir = join(tmpRoot, 'ws')
const snapRoot = join(tmpRoot, 'snapshots')
const CAP_BYTES = 1024
await mkdir(wsDir, { recursive: true })

class FakeFs extends FileSystem {
  async resolve(path, opts = {}) {
    const displayPath = opts.cwd !== undefined && !isAbsolute(path) ? join(opts.cwd, path) : path
    return { targetKey: FsTargetKey(displayPath), displayPath }
  }
  processPath(target) { return target.displayPath }
  processPathFromHostPath(hostPath) { return isAbsolute(hostPath) ? hostPath : undefined }
  async stat(target) {
    try {
      const info = await stat(target.displayPath)
      if (info.isFile()) return { version: FsVersion('v'), type: 'file', size: info.size }
      if (info.isDirectory()) return { version: FsVersion('v'), type: 'directory' }
      return { version: FsVersion('v'), type: 'other' }
    } catch {
      return undefined
    }
  }
}

const commands = new Map()
const agents = new Map()
const routes = new Map()
const fakeSettings = {
  configure() { return () => {} },
  describe() { return [] },
  update: async () => {},
  mutate: async () => {},
}

const ctx = new Context()
ctx.fiber.entry = { id: 'include:dsh-rewind-plugin' }
ctx.provide('commands', {
  register: definition => {
    commands.set(definition.name, definition)
    return () => { commands.delete(definition.name) }
  },
})
ctx.provide('fs', new FakeFs(new Context()))
ctx.provide('workingDirectory', { ensure: async () => wsDir })
ctx.provide('agents', { get: id => agents.get(id) })
ctx.provide('settings', fakeSettings)
ctx.provide('connection', {
  fetch: {
    register: route => {
      routes.set(route.path, route)
      return async () => { routes.delete(route.path) }
    },
  },
})

const resolvedConfig = Config({ snapshotDir: snapRoot, dshHome: tmpRoot, maxFileBytes: CAP_BYTES })
apply(ctx, resolvedConfig)
// Let the injected fs/workingDirectory scope install its listeners before the
// first synthesized step, as the loader does by awaiting the mount effect.
await new Promise(resolve => setTimeout(resolve, 10))

const call = (agent, rawInput) => commands.get('rewind').handler({
  commandId: CommandId('cid'), agent, rawInput, signal: aborted(),
})

/** One fake agent around a real session (the fields executeRewind reads). */
function agentFor(session) {
  let agent = agents.get(session.id)
  if (agent === undefined) {
    agent = {
      id: session.id,
      session,
      status: 'idle',
      inbox: { nextStep: [], remove: () => true },
      whenIdle: async () => {},
      cancel: () => {},
    }
    agents.set(session.id, agent)
  }
  return agent
}

let turn = 0
/** Drive one admitted step exactly like the agent loop: pre-step, then append. */
async function runUserStep(session, text) {
  const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
  const agent = agentFor(session)
  const decision = await ctx.waterfall('agent/pre-step', {
    agent,
    messages: [message],
    turn: ++turn,
    step: 1,
    signal: aborted(),
    modelSelection: { provider: 'test', model: 'test-model' },
  }, async () => ({ kind: 'enter', messages: [message] }))
  if (decision.kind !== 'enter') throw new Error('pre-step rejected the verification message')
  session.append('user/message', message, { surfaceOp: 'append' })
  return { message, seq: session.snapshotEvents().at(-1).seq }
}

/** Dispatch one write through the real `tools/execute` waterfall. */
async function runTool(session, path, content) {
  await ctx.waterfall('tools/execute', {
    callId: `call-${++turn}-${Date.now()}`,
    name: 'write',
    arguments: { file_path: path },
    agent: agentFor(session),
    signal: aborted(),
  }, async () => {
    await writeFile(path, content)
    return { isError: false, content: [] }
  })
}

/** POST one flat route payload and decode its JSON envelope. */
async function apiPost(path, payload) {
  const route = routes.get(path)
  if (route === undefined) throw new Error(`route ${path} is not registered`)
  const response = await route.fetch(new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }))
  return { status: response.status, result: await response.json() }
}

const previewOf = async (session, seq) => {
  const { status, result } = await apiPost('/api/dsh-rewind/preview', { sessionId: session.id, seq })
  if (status !== 200) throw new Error(`preview route returned HTTP ${status}`)
  return result
}

const filesOf = preview => preview.ok === true ? preview.value.files : []
const hasFile = (preview, path, action) => filesOf(preview)
  .some(file => file.path === path && (action === undefined || file.action === action))

let failures = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — ${detail}`}`)
  if (!ok) failures += 1
}

// 1. commands
check('rewind registered', typeof commands.get('rewind')?.handler === 'function' && commands.get('rewind').name === 'rewind', JSON.stringify(commands.get('rewind')))
check('undo alias shares the handler', commands.get('undo')?.handler === commands.get('rewind')?.handler, JSON.stringify(commands.get('undo')))
check('engine channel registered', typeof commands.get('rewind-plugin')?.handler === 'function', JSON.stringify(commands.get('rewind-plugin')))
check('cleanup command registered', typeof commands.get('snapshot-auto-cleanup')?.handler === 'function', JSON.stringify(commands.get('snapshot-auto-cleanup')))

// 2-4. pre-step manifests, first-touch capture, preview and both-mode restore
{
  const session = Session.create(SessionId('verify-main'))
  const first = await runUserStep(session, 'first')
  const file = join(wsDir, 'a.txt')
  await writeFile(file, 'original', 'utf8')
  await runTool(session, file, 'rewritten')
  const second = await runUserStep(session, 'second')
  check('second user message was admitted', session.snapshotEvents().filter(event => event.type === 'user/message').length === 2, 'missing second message')
  await writeFile(file, 'external', 'utf8')

  const checkpoints = await (await import('node:fs/promises')).readdir(join(snapRoot, session.id, 'checkpoints'))
  check('one checkpoint per user message', checkpoints.filter(name => name.endsWith('.json')).length === 2, checkpoints.join(','))
  const preview = await previewOf(session, first.seq)
  check('preview reports the tracked restore', preview.ok === true && hasFile(preview, file, 'restore'), JSON.stringify(preview))
  check('preview sees the current over-cap state as uncovered only when over cap',
    preview.ok === true && preview.value.uncovered.length === 0, JSON.stringify(preview))
  check('preview is a pure query', session.snapshotEvents().at(-1).seq === second.seq, `last=${session.snapshotEvents().at(-1).seq} second=${second.seq}`)

  const both = await call(agentFor(session), `@${first.seq} both`)
  check('both rewind succeeds', both.kind === 'success' && /restored 1 file/.test(both.text), both.text)
  check('target content restored', await readFile(file, 'utf8') === 'original', await readFile(file, 'utf8'))
}

// 4b. a running turn is cancelled and quiesced before the surface is cut
{
  const session = Session.create(SessionId('verify-running'))
  const first = await runUserStep(session, 'first')
  const running = {
    id: session.id,
    session,
    status: 'running',
    inbox: { nextStep: [], remove: () => true },
    cancel() { this.status = 'idle' },
    whenIdle: async () => {},
  }
  agents.set(session.id, running)
  const result = await call(running, `@${first.seq} chat`)
  check('running agent is cancelled before rewind', result.kind === 'success' && session.snapshotEvents().at(-1).data.source.kind === 'dsh-rewind', result.text)
}

// 5. a file created after the target is deleted
{
  const session = Session.create(SessionId('verify-create'))
  const first = await runUserStep(session, 'first')
  const file = join(wsDir, 'created.txt')
  await runTool(session, file, 'new')
  const both = await call(agentFor(session), `@${first.seq} both`)
  check('created file deleted', both.kind === 'success' && /deleted 1 file/.test(both.text), both.text)
  let gone = false
  try { await readFile(file) } catch { gone = true }
  check('created file is absent after rewind', gone, 'file still exists')
}

// 6. a target without a checkpoint: conversation only, reported explicitly
{
  const session = Session.create(SessionId('verify-no-checkpoint'))
  const message = createUserMessage({ content: [{ type: 'text', text: 'old' }], source: { kind: 'user' } })
  session.append('user/message', message, { surfaceOp: 'append' })
  const seq = session.snapshotEvents().at(-1).seq
  const both = await call(agentFor(session), `@${seq} both`)
  check('no-checkpoint rewind succeeds', both.kind === 'success' && /no file checkpoint/.test(both.text), both.text)
  check('no-checkpoint result uses one clause separator', /; no file checkpoint exists for the target message/.test(both.text) && !/;;/.test(both.text), both.text)
  check('no-checkpoint rewind appends the marker', session.snapshotEvents().at(-1).data.source.kind === 'dsh-rewind', JSON.stringify(session.snapshotEvents().at(-1).data))
}

// 7. a newer store fails the file operation closed
{
  const session = Session.create(SessionId('verify-newer-store'))
  const dir = join(snapRoot, session.id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'meta.json'), JSON.stringify({ store: 9, sessionFormat: 4 }), 'utf8')
  const first = await runUserStep(session, 'first')
  const file = join(wsDir, 'newer.txt')
  await writeFile(file, 'keep', 'utf8')
  const preview = await previewOf(session, first.seq)
  check('newer store preview fails closed', preview.ok === false && /newer store format|file restore unavailable/.test(preview.error.message), JSON.stringify(preview))
  const both = await call(agentFor(session), `@${first.seq} both`)
  check('newer store keeps the conversation rewind', both.kind === 'success' && /file restore unavailable/.test(both.text), both.text)
  check('newer store leaves the file alone', await readFile(file, 'utf8') === 'keep', await readFile(file, 'utf8'))
}

// 8. over-cap tracked files are skipped and reported
{
  const session = Session.create(SessionId('verify-cap'))
  const first = await runUserStep(session, 'first')
  const file = join(wsDir, 'cap.txt')
  await writeFile(file, 'ok', 'utf8')
  await runTool(session, file, 'ok')
  await runUserStep(session, 'second')
  await writeFile(file, 'x'.repeat(CAP_BYTES + 1), 'utf8')
  const preview = await previewOf(session, first.seq)
  check('preview lists the over-cap path', preview.ok === true && preview.value.uncovered.some(item => item.path === file), JSON.stringify(preview))
  const both = await call(agentFor(session), `@${first.seq} both`)
  check('over-cap restore is reported', both.kind === 'success' && /skipped 1 path/.test(both.text) && /backup limit/.test(both.text), both.text)
  check('over-cap file is untouched', (await readFile(file, 'utf8')).length === CAP_BYTES + 1, `${(await readFile(file, 'utf8')).length} bytes`)
}

// 9. a path that becomes a symlink is skipped (POSIX: Windows may refuse symlink creation)
if (process.platform !== 'win32') {
  const session = Session.create(SessionId('verify-link'))
  const first = await runUserStep(session, 'first')
  const file = join(wsDir, 'link.txt')
  await writeFile(file, 'original', 'utf8')
  await runTool(session, file, 'edited')
  const victim = join(wsDir, 'victim.txt')
  await writeFile(victim, 'victim', 'utf8')
  await rm(file)
  await symlink(victim, file)
  const both = await call(agentFor(session), `@${first.seq} both`)
  check('symlink path is reported as skipped with a reason', both.kind === 'success' && /skipped 1 path/.test(both.text) && /symlink|hard link/.test(both.text), both.text)
  check('symlink target is untouched', await readFile(victim, 'utf8') === 'victim', await readFile(victim, 'utf8'))
}

// 10. current-session clear removes the whole directory
{
  const session = Session.create(SessionId('verify-clear'))
  await runUserStep(session, 'first')
  const agent = agentFor(session)
  const dry = await commands.get('snapshot-auto-cleanup').handler({ commandId: CommandId('cid'), agent, rawInput: 'run --current', signal: aborted() })
  check('clear dry-run reports a checkpoint', dry.kind === 'success' && /would clear/.test(dry.text), dry.text)
  const applied = await commands.get('snapshot-auto-cleanup').handler({ commandId: CommandId('cid'), agent, rawInput: 'run --current --apply', signal: aborted() })
  check('clear apply succeeds', applied.kind === 'success' && /Cleared/.test(applied.text), applied.text)
  let gone = false
  try { await (await import('node:fs/promises')).stat(join(snapRoot, session.id)) } catch { gone = true }
  check('clear removed the session directory', gone, 'directory still exists')
}

console.log(failures === 0 ? 'verify-host: ok' : `verify-host: ${failures} failure(s)`)
await rm(tmpRoot, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
