#!/usr/bin/env node
/**
 * Host-half verification: boots the built plugin (`lib/index.js`) on a real
 * cordis context with a real dsh-session, then drives the `/rewind` command
 * handler and the checkpoint pipeline end to end — no model, no UI. Files are
 * real files under a temporary directory, so a restore is verified against
 * actual on-disk content, and the checkpoint store root is overridden to that
 * temporary directory.
 *
 * Run: `npm run build && node scripts/verify-host.mjs`
 *
 * What it proves:
 *  1. the plugin registers a `rewind` command on the ctx;
 *  2. `/rewind` (no args) withdraws the most recent user message;
 *  3. `/rewind @<seq> chat` cuts the surface in-place (log untouched);
 *  4. a successful write through the tools pipeline commits a before-backup
 *     under the turn's anchor seq;
 *  5. a denied call never commits (no phantom entry in the store);
 *  6. relative file paths resolve against the session cwd (fs-tools rule);
 *  7. `/rewind preview @<seq> both` reports the checkpoint impact;
 *  8. `/rewind @<seq> both` restores the real file to its pre-edit content
 *     and deletes files created after the target;
 *  9. a running agent is force-stopped before the rewind (not refused);
 * 10. a cancel that never quiesces aborts the rewind (timeout path);
 * 11. subagent edits are NOT tracked (Claude Code alignment).
 */
import { Context } from '@deepseek-ai/cordis'
import { FileSystem, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply as applyRewind } from '../lib/index.js'

const aborted = () => new AbortController().signal

const tmpRoot = await mkdtemp(join(tmpdir(), 'dsh-rewind-verify-'))
const wsDir = join(tmpRoot, 'ws')
const snapRoot = join(tmpRoot, 'snapshots')
await mkdir(wsDir, { recursive: true })

/** Real-filesystem fs double: resolve returns the real display path. */
class FakeFs extends FileSystem {
  async resolve(path, opts = {}) {
    const displayPath = opts?.cwd !== undefined && !path.startsWith('/') ? join(opts.cwd, path) : path
    return { targetKey: FsTargetKey(displayPath), displayPath }
  }
  processPath(target) { return target.displayPath }
  async readText(target) { return readFile(target.displayPath, 'utf8') }
  async writeText(target, content) { await writeFile(target.displayPath, content, 'utf8'); return { operation: 'update', version: FsVersion('v'), before: null, after: content } }
  async stat(target) {
    try { await readFile(target.displayPath); return { version: FsVersion('v'), type: 'file' } } catch { return undefined }
  }
}

const fs = new FakeFs(new Context())

const user = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const assistant = text => createAssistantMessage({ content: [{ type: 'text', text }], source: { provider: 'test', model: 'test' } })

function buildSession(id, cwd, extra = {}) {
  const session = Session.create(SessionId(id), undefined,
    cwd !== undefined
      ? { version: 0, id: SessionId(id), createdAt: Date.now(), cwd, ...extra }
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
applyRewind(ctx, { snapshotDir: snapRoot })

const call = (agentOf, rawInput) => registered.handler({ commandId: Symbol('cid'), agent: agentOf, rawInput, signal: aborted() })

/**
 * Simulate one tracked tool call: before-capture, dispatch writes the file,
 * post-execute commits. The dispatched write resolves the path against the
 * calling agent's session cwd first — exactly what the real fs service does —
 * so a relative `filePath` lands on the resolved file (never in the process
 * cwd), keeping the harness free of stray artifacts.
 */
async function runWrite(agentOf, callId, filePath, content) {
  const exec = { callId, name: 'write', arguments: { file_path: filePath, content }, agent: agentOf, signal: aborted() }
  await ctx.waterfall('tools/execute', exec, async () => {
    const cwd = agentOf?.session?.header?.cwd
    const resolved = cwd !== undefined && !filePath.startsWith('/') ? join(cwd, filePath) : filePath
    await fs.writeText({ targetKey: FsTargetKey(resolved), displayPath: resolved }, content)
    return { isError: false, content: [] }
  })
  await ctx.waterfall('tools/post-execute', exec, { isError: false, content: [] }, async () => ({ kind: 'accept' }))
}

let failures = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — ${detail}`}`)
  if (!ok) failures += 1
}

// 1. command registered
check('command registered', typeof registered?.handler === 'function' && registered.name === 'rewind', JSON.stringify(registered))

// 2. bare /rewind (manual, no parameters) withdraws the most recent user
//    message (seq 2 "second question") and everything after it
const bareBefore = [...session.surface.nodes]
const bareResult = await call(agent, '')
const bareAfter = [...session.surface.nodes]
check('bare /rewind succeeds', bareResult.kind === 'success', bareResult.text)
check('bare /rewind withdraws the latest message', bareAfter.length === 3 && bareAfter[0] === 0 && bareAfter[1] === 1 && bareAfter[2] > 3, `before ${JSON.stringify(bareBefore)} -> after ${JSON.stringify(bareAfter)}`)
check('log stays append-only (5 events)', session.events.length === 5, `events=${session.events.length}`)

// 3. /rewind @<seq> chat (the button's exact call form) cuts the surface on a
//    fresh session
const paramSession = buildSession('verify-param')
const paramAgent = { id: paramSession.id, session: paramSession, status: 'idle' }
const before = [...paramSession.surface.nodes]
const chatResult = await call(paramAgent, '@2 chat')
const after = [...paramSession.surface.nodes]
check('rewind chat succeeds', chatResult.kind === 'success', chatResult.text)
check('surface cut to [0,1,marker] (target withdrawn)', after.length === 3 && after[0] === 0 && after[1] === 1 && after[2] > 3, `before ${JSON.stringify(before)} -> after ${JSON.stringify(after)}`)
check('log stays append-only (5 events)', paramSession.events.length === 5, `events=${paramSession.events.length}`)

// 4. a tracked write commits a before-backup; rewinding both restores the
//    real file and deletes files created after the target
{
  const aPath = join(wsDir, 'a.txt')
  await writeFile(aPath, 'original content', 'utf8')
  // The next user message anchors the turn that will edit a.txt (seq 5).
  session.append('user/message', user('third question'), { surfaceOp: 'append' })
  const anchorSeq = 5
  await runWrite(agent, 'c1', aPath, 'rewritten') // before-capture: 'original content'
  const createdPath = join(wsDir, 'created.txt')
  await runWrite(agent, 'c2', createdPath, 'new') // file did not exist: before-capture = created
  await writeFile(aPath, 'v3', 'utf8') // later edit lands after the backups

  const preview = await call(agent, `preview @${anchorSeq} both`)
  check('preview reports the file impact', preview.kind === 'success' && preview.text.includes(aPath) && preview.text.includes('还原'), preview.text)
  check('preview carries the machine impact token', preview.kind === 'success' && /impact=2/.test(preview.text), preview.text)

  const both = await call(agent, `@${anchorSeq} both`)
  check('rewind both succeeds', both.kind === 'success' && both.text.includes('还原 1 个文件') && both.text.includes('删除 1 个文件'), both.text)
  check('modified file restored to pre-edit content', await readFile(aPath, 'utf8') === 'original content', await readFile(aPath, 'utf8'))
  let createdGone = false
  try { await readFile(createdPath, 'utf8') } catch { createdGone = true }
  check('created file deleted', createdGone, `exists=${!createdGone}`)
}

// 5. a denied call never commits (no phantom entry)
{
  const deniedPath = join(wsDir, 'denied.txt')
  await writeFile(deniedPath, 'x', 'utf8')
  const exec = { callId: 'c3', name: 'write', arguments: { file_path: deniedPath, content: 'denied write' }, agent, signal: aborted() }
  await ctx.waterfall('tools/pre-execute', exec, async () => ({ kind: 'deny', reason: 'no' }))
  await ctx.waterfall('tools/post-execute', exec, { isError: true, error: { message: 'denied', info: { name: 'x', code: 'y' } }, content: [] }, async () => ({ kind: 'accept' }))
  const preview = await call(agent, 'preview @5 both')
  check('denied call is not in the impact list', !preview.text.includes(deniedPath), preview.text)
}

// 6. relative paths resolve against the session cwd (fs-tools rule)
{
  const cwdSession = buildSession('verify-cwd', wsDir)
  const cwdAgent = { id: cwdSession.id, session: cwdSession, status: 'idle' }
  const relPath = join(wsDir, 'rel.txt')
  await writeFile(relPath, 'relative original', 'utf8')
  cwdSession.append('user/message', user('relative question'), { surfaceOp: 'append' })
  await runWrite(cwdAgent, 'c4', 'rel.txt', 'relative new') // relative path

  const preview = await call(cwdAgent, 'preview @4 both')
  check('relative path resolved via session cwd', preview.kind === 'success' && preview.text.includes(relPath), preview.text)
  const both = await call(cwdAgent, '@4 both')
  check('both restores cwd-resolved file', both.kind === 'success' && await readFile(relPath, 'utf8') === 'relative original', both.text)
}

// 7. preview on a message with no recorded changes reports none
{
  const cleanSession = buildSession('verify-norec')
  const cleanAgent = { id: cleanSession.id, session: cleanSession, status: 'idle' }
  const previewResult = await call(cleanAgent, 'preview @2 both')
  check('preview with no entries reports no changes', previewResult.kind === 'success' && previewResult.text.includes('没有需要还原的变更'), previewResult.text)
}

// 8. a running agent is force-stopped before the rewind (not refused)
{
  const runningSession = buildSession('verify-running')
  let cancelled = false
  // `whenIdle` resolves once cancel flips status back to idle (the real
  // harness loop's activity promise settles the same way).
  const running = {
    id: runningSession.id,
    session: runningSession,
    status: 'running',
    cancel: () => { cancelled = true; running.status = 'idle' },
    whenIdle: () => new Promise(resolve => {
      const poll = () => { if (running.status === 'idle') resolve(); else setTimeout(poll, 10) }
      poll()
    }),
  }
  const runningResult = await call(running, '@2 chat')
  check('running agent is cancelled first', cancelled === true, `cancelled=${cancelled}`)
  check('rewind succeeds after stop', runningResult.kind === 'success', runningResult.text)
}

// 9. a cancel that never quiesces aborts the rewind (timeout path)
{
  const stuckSession = buildSession('verify-stuck')
  // `whenIdle` never settles and cancel does nothing: the rewind must give up
  // at the idle-wait deadline instead of appending mid-turn.
  const stuck = {
    id: stuckSession.id,
    session: stuckSession,
    status: 'running',
    cancel: () => {},
    whenIdle: () => new Promise(() => {}),
  }
  const stuckResult = await call(stuck, '@2 chat')
  check('stuck agent aborts rewind', stuckResult.kind === 'error', stuckResult.text)
}

// 10. subagent edits are NOT tracked (Claude Code alignment): the backup
//     would land under the subagent session id where a parent-session rewind
//     could never restore it, so the capture is skipped entirely.
{
  const subSession = buildSession('verify-sub', wsDir, { origin: 'subagent', delegationDepth: 1 })
  const subAgent = { id: subSession.id, session: subSession, status: 'idle' }
  const subFile = join(wsDir, 'sub.txt')
  await writeFile(subFile, 'sub original', 'utf8')
  subSession.append('user/message', user('sub question'), { surfaceOp: 'append' })
  await runWrite(subAgent, 'c5', subFile, 'sub new')
  // The main session's own rewinds consumed seq 2/4/5; seq 0 (the first user
  // message) is still on its surface and covers every backup anchored at or
  // after it.
  const preview = await call(agent, 'preview @0 both')
  check('subagent edit is not tracked', preview.kind === 'success' && !preview.text.includes(subFile), preview.text)
  // And the snapshot root holds no subagent session directory.
  const subSessionDir = join(snapRoot, subSession.id)
  let subDirExists = false
  try { await readdir(subSessionDir); subDirExists = true } catch { subDirExists = false }
  check('no snapshot dir for the subagent session', !subDirExists, subSessionDir)
}

await rm(tmpRoot, { recursive: true, force: true })
console.log(failures === 0 ? '\nverify-host: all checks passed' : `\nverify-host: ${failures} check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
