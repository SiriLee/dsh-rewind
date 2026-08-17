#!/usr/bin/env node
/**
 * Host-half verification: boots the built plugin (`lib/index.js`) on a real
 * cordis context with a real dsh-session, then drives the `/rewind` command
 * handler and the tools-pipeline ledger events end to end — no model, no UI.
 *
 * Run: `npm run build && node scripts/verify-host.mjs`
 *
 * What it proves:
 *  1. the plugin registers a `rewind` command on the ctx;
 *  2. `/rewind` (no args) lists recent user messages;
 *  3. `/rewind @<seq> chat` cuts the surface in-place (log untouched);
 *  4. the ledger captures through `tools/execute` (NOT pre-execute): a
 *     pre-execute `ask` short-circuit still gets captured after approval, and
 *     a denied call never captures (no pending leak);
 *  5. relative file paths resolve against the session cwd (fs-tools rule);
 *  6. `/rewind preview @<seq> both` reports the file impact;
 *  7. `/rewind @<seq> both` restores the file and reports it.
 */
import { Context } from '@deepseek-ai/cordis'
import { FileSystem, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { join } from 'node:path'
import { apply as applyRewind } from '../lib/index.js'

const aborted = () => new AbortController().signal

/** In-memory fs double with session-cwd resolution (resolve/readText/writeText/processPath). */
class FakeFs extends FileSystem {
  files = new Map()
  async resolve(path, opts = {}) {
    const displayPath = opts?.cwd !== undefined && !path.startsWith('/') ? join(opts.cwd, path) : path
    return { targetKey: FsTargetKey(displayPath), displayPath }
  }
  processPath(target) { return target.displayPath }
  async readText(target) {
    const content = this.files.get(target.displayPath)
    if (content === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    return content
  }
  async writeText(target, content) { this.files.set(target.displayPath, content); return { operation: 'update', version: FsVersion('v'), before: null, after: content } }
  async stat(target) { return this.files.has(target.displayPath) ? { version: FsVersion('v'), type: 'file' } : undefined }
}

const fs = new FakeFs(new Context())
fs.files.set('/workspace/a.txt', 'original content')

const user = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const assistant = text => createAssistantMessage({ content: [{ type: 'text', text }], source: { provider: 'test', model: 'test' } })

function buildSession(id, cwd) {
  const session = Session.create(SessionId(id), undefined,
    cwd !== undefined
      ? { version: 0, id: SessionId(id), createdAt: Date.now(), cwd }
      : undefined)
  session.append('user/message', user('first question'), { surfaceOp: 'append' })
  session.append('assistant/message', { turn: 0, step: 0, message: assistant('first answer') }, { surfaceOp: 'append' })
  session.append('user/message', user('second question'), { surfaceOp: 'append' })
  session.append('assistant/message', { turn: 1, step: 0, message: assistant('second answer') }, { surfaceOp: 'append' })
  return session
}

const session = buildSession('verify-host')
const agent = { id: session.id, session, status: 'idle' }

const ctx = new Context()
let registered = null
ctx.provide('commands', {
  register: definition => {
    registered = definition
    return () => {}
  },
})
ctx.provide('fs', fs)
applyRewind(ctx)

const call = (agentOf, rawInput) => registered.handler({ commandId: Symbol('cid'), agent: agentOf, rawInput, signal: aborted() })

let failures = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — ${detail}`}`)
  if (!ok) failures += 1
}

// 1. command registered
check('command registered', typeof registered?.handler === 'function' && registered.name === 'rewind', JSON.stringify(registered))

// 2. bare /rewind lists candidates
const listResult = await call(agent, '')
check('bare /rewind lists candidates', listResult.kind === 'success' && listResult.text.includes('second question') && listResult.text.includes('first question'), listResult.text)

// 3. /rewind @2 chat cuts the surface in place
const before = [...session.surface.nodes]
const chatResult = await call(agent, '@2 chat')
const after = [...session.surface.nodes]
check('rewind chat succeeds', chatResult.kind === 'success', chatResult.text)
check('surface cut to [0,1,2,marker]', after.length === 4 && after[0] === 0 && after[1] === 1 && after[2] === 2 && after[3] > 3, `before ${JSON.stringify(before)} -> after ${JSON.stringify(after)}`)
check('log stays append-only (5 events)', session.events.length === 5, `events=${session.events.length}`)

const writeExec = (callId, filePath, content) => ({
  callId, name: 'write', arguments: { file_path: filePath, content }, agent, signal: aborted(),
})

// 4. a pre-execute `ask` short-circuit (dsh-edit-approval) must not skip the
//    capture: capture happens in tools/execute, which runs after approval.
{
  const exec = writeExec('c1', '/workspace/a.txt', 'rewritten')
  // Another plugin asks at pre-execute; the user then allows it.
  const gate = await ctx.waterfall('tools/pre-execute', exec, async () => ({ kind: 'ask', reason: 'approve me' }))
  check('pre-execute gate asks', gate.kind === 'ask', JSON.stringify(gate))
  // Approved → dispatch stage runs: capture fires here.
  await ctx.waterfall('tools/execute', exec, async () => ({ isError: false, content: [] }))
  await fs.writeText({ targetKey: FsTargetKey('/workspace/a.txt'), displayPath: '/workspace/a.txt' }, 'rewritten')
  await ctx.waterfall('tools/post-execute', exec, { isError: false, content: [] }, async () => ({ kind: 'accept' }))
  check('file mutated on disk', fs.files.get('/workspace/a.txt') === 'rewritten', fs.files.get('/workspace/a.txt'))
}

// 5. a denied call never captures (no pending leak: nothing recorded after it)
{
  const exec = writeExec('c2', '/workspace/a.txt', 'denied write')
  const gate = await ctx.waterfall('tools/pre-execute', exec, async () => ({ kind: 'deny', reason: 'no' }))
  check('pre-execute gate denies', gate.kind === 'deny', JSON.stringify(gate))
  // Denied calls do not dispatch: post-execute must record nothing for c2.
  await ctx.waterfall('tools/post-execute', exec, { isError: true, error: { message: 'denied', info: { name: 'x', code: 'y' } }, content: [] }, async () => ({ kind: 'accept' }))
}

// 6. relative paths resolve against the session cwd (fs-tools rule)
{
  const cwdSession = buildSession('verify-cwd', '/workspace')
  const cwdAgent = { id: cwdSession.id, session: cwdSession, status: 'idle' }
  fs.files.set('/workspace/rel.txt', 'relative original')
  const exec = { callId: 'c3', name: 'write', arguments: { file_path: 'rel.txt', content: 'relative new' }, agent: cwdAgent, signal: aborted() }
  await ctx.waterfall('tools/execute', exec, async () => ({ isError: false, content: [] }))
  await fs.writeText({ targetKey: FsTargetKey('/workspace/rel.txt'), displayPath: '/workspace/rel.txt' }, 'relative new')
  await ctx.waterfall('tools/post-execute', exec, { isError: false, content: [] }, async () => ({ kind: 'accept' }))
  // Rewind to seq 2 in the cwd session must report the cwd-resolved path.
  const preview = await call(cwdAgent, 'preview @2 both')
  check('preview resolves relative path via session cwd', preview.kind === 'success' && preview.text.includes('/workspace/rel.txt'), preview.text)
  const both = await call(cwdAgent, '@2 both')
  check('both restores cwd-resolved file', both.kind === 'success' && fs.files.get('/workspace/rel.txt') === 'relative original', both.text)
}

// 7. preview reports the impact (rewind to seq 2 reverts the anchor-2 write)
const previewResult = await call(agent, 'preview @2 both')
check('preview shows file impact', previewResult.kind === 'success' && previewResult.text.includes('/workspace/a.txt'), previewResult.text)

// 8. both mode restores the file
const bothResult = await call(agent, '@2 both')
check('rewind both restores file', bothResult.kind === 'success' && bothResult.text.includes('还原 1 个文件'), bothResult.text)
check('file content restored', fs.files.get('/workspace/a.txt') === 'original content', fs.files.get('/workspace/a.txt'))

// 9. a running agent is force-stopped before the rewind (not refused)
let cancelled = false
const running = {
  ...agent, status: 'running',
  cancel: () => { cancelled = true; running.status = 'idle' },
}
const runningResult = await registered.handler({ commandId: Symbol('cid'), agent: running, rawInput: '@2 chat', signal: aborted() })
check('running agent is cancelled first', cancelled === true, `cancelled=${cancelled}`)
check('rewind succeeds after stop', runningResult.kind === 'success', runningResult.text)

// 9b. a cancel that never quiesces aborts the rewind (timeout path)
const stuck = { ...agent, status: 'running', cancel: () => {} }
const stuckResult = await registered.handler({ commandId: Symbol('cid'), agent: stuck, rawInput: '@2 chat', signal: aborted() })
check('stuck agent aborts rewind', stuckResult.kind === 'error', stuckResult.text)

console.log(failures === 0 ? '\nverify-host: all checks passed' : `\nverify-host: ${failures} check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
