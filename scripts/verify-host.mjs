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
 * 11. subagent edits are NOT tracked (Claude Code alignment);
 * 12. the REAL `/compact` command (command-compact + compaction-basic with a
 *     stubbed summarizer, no LLM) lands a compaction/start…end transaction on
 *     top of a rewind marker and the log stays replayable (token-meter +
 *     Session.create resume preflight);
 * 12b. a small post-rewind surface makes /compact a legal no-op that never
 *     fires a transaction and stays replayable;
 * 13. rewind → real turn → rewind → real /compact stays replayable and the
 *     compaction bookkeeping stays balanced;
 * 14. rewinding across a compaction checkpoint is refused with the plugin's
 *     own error (not a crash);
 * 15. no rewind/compact combination ever leaves a dangling step/start or
 *     turn/start frame in the log.
 */
import { Context } from '@deepseek-ai/cordis'
import { CommandId } from '@deepseek-ai/dsh-commands'
import { FileSystem, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { TokenMeter } from '@deepseek-ai/dsh-token-meter'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { apply as applyCommandCompact } from '@deepseek-ai/dsh-command-compact'
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir, utimes, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply as applyRewind } from '../lib/index.js'

const aborted = () => new AbortController().signal

const tmpRoot = await mkdtemp(join(tmpdir(), 'dsh-rewind-verify-'))
const wsDir = join(tmpRoot, 'ws')
const snapRoot = join(tmpRoot, 'snapshots')
// Isolate the cleanup config to a temp sibling (NOT inside snapRoot, which a
// later check wipes) so the auto-sweep reads an empty/default file during the
// rewind checks and never touches the developer's real policy.
const cleanupConfig = join(tmpRoot, 'snapshot-cleanup.json')
process.env.DSH_SNAPSHOT_CLEANUP_CONFIG = cleanupConfig
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

/** Minimal Inbox double: a mutable next-step list with a removing remove(). */
function makeInbox(initial = []) {
  const nextStep = [...initial]
  return {
    nextStep,
    remove(messageId) {
      const index = nextStep.findIndex((message) => message.id === messageId)
      if (index >= 0) nextStep.splice(index, 1)
      return index >= 0
    },
  }
}

/** Minimal Agent double carrying the fields executeRewind reads today. */
function makeAgent(id, session, status = 'idle', inbox = makeInbox()) {
  return {
    id, session, status, inbox,
    options: { provider: 'test', model: 'test-model' },
    // Manual compaction requires an idle agent whose maintenance task runs
    // with its own signal (ManualCompactAgentContext).
    runMaintenance: async task => {
      if (status !== 'idle') throw new Error('agent is not idle')
      return task(aborted())
    },
  }
}

/**
 * A session shaped like a REAL harness session (the agent loop's exact event
 * shape: turn/start → step/start → user → assistant → step/end → turn/end),
 * so the harness token-meter replay accepts it — required to drive the real
 * `/compact` transaction.
 */
function buildFramedSession(id, turns = 2) {
  const session = Session.create(SessionId(id))
  for (let turn = 1; turn <= turns; turn++) {
    session.append('turn/start', { turn })
    session.append('step/start', { turn, step: 1 })
    // Long enough content that a 3-turn retained span out-tokens the
    // compaction backend's fixed checkpoint preamble — otherwise /compact
    // legally no-ops ("summary not smaller than the shadowed content").
    session.append('user/message', user(`framed question ${turn}: the quick brown fox jumps over the lazy dog and keeps running through the deep forest`), { surfaceOp: 'append' })
    session.append('assistant/message', { turn, step: 1, message: assistant(`framed answer ${turn}: the response covers the requested detail, the follow-up implications, and the remaining open questions for the user to decide on`) }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  return session
}

/** True when the log holds no unclosed step/start and no unclosed turn/start. */
function hasNoDanglingFrames(events) {
  const openSteps = new Map()
  for (const event of events) {
    if (event.type === 'step/start') openSteps.set(`${event.data.turn}:${event.data.step}`, true)
    else if (event.type === 'step/end') openSteps.delete(`${event.data.turn}:${event.data.step}`)
  }
  let openTurn = false
  for (const event of events) {
    if (event.type === 'turn/start') openTurn = true
    else if (event.type === 'turn/end') openTurn = false
  }
  return openSteps.size === 0 && !openTurn
}

const session = buildSession('verify-host')
const agent = makeAgent(session.id, session)

const ctx = new Context()
const commands = new Map()
ctx.provide('commands', {
  register: definition => {
    commands.set(definition.name, definition)
    return () => { commands.delete(definition.name) }
  },
})
ctx.provide('fs', fs)
ctx.provide('sessions', { flush: async () => {} })
// The real token-meter service (registers itself as ctx.tokenMeter) and a
// real compaction backend whose ONLY hook is a stubbed summarize() — the
// manual `/compact` command path needs no LLM.
new TokenMeter(ctx)
class StubCompactionEngine extends BasicCompactionEngine {
  constructor() { super(ctx, { summarizationProvider: 'test', summarizationModel: 'test-model' }) }
  async summarize(input, agent, signal) {
    return { summary: [{ type: 'text', text: 'rewind-compat summary' }], provider: 'test', model: 'test-model' }
  }
}
new StubCompactionEngine(ctx)
applyRewind(ctx, { snapshotDir: snapRoot })
applyCommandCompact(ctx)

const call = (agentOf, rawInput) => commands.get('rewind').handler({ commandId: CommandId('cid'), agent: agentOf, rawInput, signal: aborted() })

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
check('command registered', typeof commands.get('rewind')?.handler === 'function' && commands.get('rewind').name === 'rewind', JSON.stringify(commands.get('rewind')))

// 2. bare /rewind (manual, no parameters) withdraws the most recent user
//    message (seq 2 "second question") and everything after it
const bareBefore = [...session.surface.nodes]
const bareResult = await call(agent, '')
const bareAfter = [...session.surface.nodes]
check('bare /rewind succeeds', bareResult.kind === 'success', bareResult.text)
check('bare /rewind withdraws the latest message', bareAfter.length === 3 && bareAfter[0] === 0 && bareAfter[1] === 1 && bareAfter[2] > 3, `before ${JSON.stringify(bareBefore)} -> after ${JSON.stringify(bareAfter)}`)
// The marker rides a ghost-step frame (step/start + step/end) so the harness
// token-meter replay accepts it (issue #2: bare markers break /compact).
check('log stays append-only (7 events: 4 + marker frame)', session.events.length === 7, `events=${session.events.length}`)

// 3. /rewind @<seq> chat (the button's exact call form) cuts the surface on a
//    fresh session
const paramSession = buildSession('verify-param')
const paramAgent = makeAgent(paramSession.id, paramSession)
const before = [...paramSession.surface.nodes]
const chatResult = await call(paramAgent, '@2 chat')
const after = [...paramSession.surface.nodes]
check('rewind chat succeeds', chatResult.kind === 'success', chatResult.text)
check('surface cut to [0,1,marker] (target withdrawn)', after.length === 3 && after[0] === 0 && after[1] === 1 && after[2] > 3, `before ${JSON.stringify(before)} -> after ${JSON.stringify(after)}`)
// Same ghost-step frame as above: 4 seed events + step/start + marker + step/end.
check('log stays append-only (7 events: 4 + marker frame)', paramSession.events.length === 7, `events=${paramSession.events.length}`)

// 4. a tracked write commits a before-backup; rewinding both restores the
//    real file and deletes files created after the target
{
  const aPath = join(wsDir, 'a.txt')
  await writeFile(aPath, 'original content', 'utf8')
  // The next user message anchors the turn that will edit a.txt. Resolve it
  // dynamically: the shared session already carries the ghost-step marker
  // frame from the bare rewind above, so seqs are not contiguous from 4.
  session.append('user/message', user('third question'), { surfaceOp: 'append' })
  const anchorSeq = session.events.findLast(event => event.type === 'user/message').seq
  await runWrite(agent, 'c1', aPath, 'rewritten') // before-capture: 'original content'
  const createdPath = join(wsDir, 'created.txt')
  await runWrite(agent, 'c2', createdPath, 'new') // file did not exist: before-capture = created
  await writeFile(aPath, 'v3', 'utf8') // later edit lands after the backups

  const preview = await call(agent, `preview @${anchorSeq} both`)
  check('preview reports the file impact', preview.kind === 'success' && preview.text.includes(aPath) && /impact=2/.test(preview.text), preview.text)
  check('preview carries the machine restore/delete lines', preview.kind === 'success' && preview.text.includes(`restore:${aPath}`), preview.text)

  // The both-mode restore must re-sync the harness fs-observation policy:
  // record every fs/observed emission around the restore, then assert the
  // deleted file was marked absent and the restored file present-at-version
  // (owner = this session), so the session's next write of either file is
  // not judged against the stale pre-restore observation.
  const observed = []
  const disposeObs = ctx.on('fs/observed', (target, observation, actor) => {
    observed.push({
      path: target.displayPath,
      kind: observation.kind,
      version: observation.version,
      ownerIsSession: actor?.agent?.session === session,
    })
  }, { global: true })
  const both = await call(agent, `@${anchorSeq} both`)
  disposeObs()

  check('rewind both succeeds', both.kind === 'success' && both.text.includes('restored 1 file(s)') && both.text.includes('deleted 1 file(s)'), both.text)
  check('modified file restored to pre-edit content', await readFile(aPath, 'utf8') === 'original content', await readFile(aPath, 'utf8'))
  let createdGone = false
  try { await readFile(createdPath, 'utf8') } catch { createdGone = true }
  check('created file deleted', createdGone, `exists=${!createdGone}`)
  check('restore emits absent observation for the deleted file', observed.some(o => o.path === createdPath && o.kind === 'absent' && o.ownerIsSession), JSON.stringify(observed))
  check('restore emits present observation for the restored file', observed.some(o => o.path === aPath && o.kind === 'present' && o.version !== undefined && o.ownerIsSession), JSON.stringify(observed))
}

// 5. a denied call never commits (no phantom entry)
{
  // Own session so the anchor stays stable (the shared session's seqs drift
  // with each rewind's ghost-step frame).
  const deniedSession = buildSession('verify-denied')
  const deniedAgent = makeAgent(deniedSession.id, deniedSession)
  deniedSession.append('user/message', user('denied anchor question'), { surfaceOp: 'append' })
  const anchorSeq = deniedSession.events.findLast(event => event.type === 'user/message').seq
  const deniedPath = join(wsDir, 'denied.txt')
  await writeFile(deniedPath, 'x', 'utf8')
  const exec = { callId: 'c3', name: 'write', arguments: { file_path: deniedPath, content: 'denied write' }, agent: deniedAgent, signal: aborted() }
  await ctx.waterfall('tools/pre-execute', exec, async () => ({ kind: 'deny', reason: 'no' }))
  await ctx.waterfall('tools/post-execute', exec, { isError: true, error: { message: 'denied', info: { name: 'x', code: 'y' } }, content: [] }, async () => ({ kind: 'accept' }))
  const preview = await call(deniedAgent, `preview @${anchorSeq} both`)
  check('denied call is not in the impact list', preview.kind === 'success' && !preview.text.includes(deniedPath), preview.text)
}

// 6. relative paths resolve against the session cwd (fs-tools rule)
{
  const cwdSession = buildSession('verify-cwd', wsDir)
  const cwdAgent = makeAgent(cwdSession.id, cwdSession)
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
  const cleanAgent = makeAgent(cleanSession.id, cleanSession)
  const previewResult = await call(cleanAgent, 'preview @2 both')
  check('preview with no entries reports no changes', previewResult.kind === 'success' && previewResult.text.includes('No restorable changes after the target.') && /impact=0/.test(previewResult.text), previewResult.text)
}

// 8. a running agent is force-stopped before the rewind (not refused)
{
  const runningSession = buildSession('verify-running')
  let cancelled = false
  // `whenIdle` resolves once cancel flips status back to idle (the real
  // harness loop's activity promise settles the same way).
  const running = {
    ...makeAgent(runningSession.id, runningSession, 'running'),
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

// 8b. an IDLE agent with pending steering messages: the rewind drops them
//     (they belong to the future being cut) while queued (next-turn) messages
//     are left untouched — the harness QueueDock owns those.
{
  const pendSession = buildSession('verify-pending')
  const pendInbox = makeInbox([{ id: 'steer-1' }, { id: 'steer-2' }])
  const pendAgent = makeAgent(pendSession.id, pendSession, 'idle', pendInbox)
  const pendResult = await call(pendAgent, '@2 chat')
  check('rewind with pending steering succeeds', pendResult.kind === 'success', pendResult.text)
  check('pending steering dropped by rewind', pendInbox.nextStep.length === 0, `nextStep=${JSON.stringify(pendInbox.nextStep)}`)
}

// 9. a cancel that never quiesces aborts the rewind (timeout path)
{
  const stuckSession = buildSession('verify-stuck')
  // `whenIdle` never settles and cancel does nothing: the rewind must give up
  // at the idle-wait deadline instead of appending mid-turn.
  const stuck = {
    ...makeAgent(stuckSession.id, stuckSession, 'running'),
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
  const subAgent = makeAgent(subSession.id, subSession)
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

// 12. I5/I1 probe — the REAL /compact command lands on top of a rewind marker
//     and the log stays replayable (token-meter + resume preflight). Six
//     turns keep the surface large enough that the real transaction fires
//     (the compaction backend refuses to shrink a surface whose framed
//     summary would not be smaller than the shadowed content).
{
  const cs = buildFramedSession('verify-compact', 8)
  const ca = makeAgent(cs.id, cs)
  const rewindResult = await call(ca, '@20 chat')
  check('rewind before real /compact succeeds', rewindResult.kind === 'success', rewindResult.text)

  const compactDef = commands.get('compact')
  check('compact command registered by command-compact', typeof compactDef?.handler === 'function', JSON.stringify(compactDef))
  const compactResult = await compactDef.handler({ commandId: CommandId('cid'), agent: ca, rawInput: '', signal: aborted() })
  check('real /compact succeeds after rewind', compactResult.kind === 'success', JSON.stringify(compactResult))

  const events = cs.events
  const compStarts = events.filter(e => e.type === 'compaction/start').length
  const compEnds = events.filter(e => e.type === 'compaction/end').length
  check('compaction/start…end pair lands once', compStarts === 1 && compEnds === 1, `start=${compStarts} end=${compEnds}`)

  let meterOk = true
  let resumeOk = true
  let framesOk = hasNoDanglingFrames(events)
  try { new TokenMeter(new Context()).measure(cs) } catch { meterOk = false }
  try { Session.create(cs.id, cs.events) } catch { resumeOk = false }
  check('token-meter replays rewind+compact log', meterOk, '')
  check('resume preflight replays rewind+compact log', resumeOk, '')
  check('no dangling step/turn frames after rewind+compact', framesOk, '')
}

// 12b. A small post-rewind surface makes /compact a legal no-op ("No
//      compactable history yet") — the transaction must not fire and the log
//      must stay replayable.
{
  const cs = buildFramedSession('verify-compact-nop', 2)
  const ca = makeAgent(cs.id, cs)
  await call(ca, '@2 chat')
  const compactDef = commands.get('compact')
  const compactResult = await compactDef.handler({ commandId: CommandId('cid'), agent: ca, rawInput: '', signal: aborted() })
  check('small-surface /compact after rewind is a legal no-op', compactResult.kind === 'success' && /No compactable history/.test(compactResult.text), JSON.stringify(compactResult))
  const starts = cs.events.filter(e => e.type === 'compaction/start').length
  check('no compaction transaction on the no-op path', starts === 0, `starts=${starts}`)
  let ok = true
  try { new TokenMeter(new Context()).measure(cs); Session.create(cs.id, cs.events) } catch { ok = false }
  check('no-op path stays replayable', ok, '')
}

// 13. I1 stress probe — continue with a real turn, rewind again, compact
//     again: the log stays replayable at every step.
{
  const cs = buildFramedSession('verify-compact2', 8)
  const ca = makeAgent(cs.id, cs)
  await call(ca, '@20 chat')
  // A real harness turn continues after the rewind.
  cs.append('turn/start', { turn: 9 })
  cs.append('step/start', { turn: 9, step: 1 })
  cs.append('user/message', user('ninth question'), { surfaceOp: 'append' })
  cs.append('assistant/message', { turn: 9, step: 1, message: assistant('ninth answer') }, { surfaceOp: 'append' })
  cs.append('step/end', { turn: 9, step: 1 })
  cs.append('turn/end', { turn: 9, reason: { kind: 'completed' } })
  await call(ca, '@20 chat') // rewind again
  const compactDef = commands.get('compact')
  const compactResult = await compactDef.handler({ commandId: CommandId('cid'), agent: ca, rawInput: '', signal: aborted() })
  check('second /compact after rewind+turn succeeds', compactResult.kind === 'success', JSON.stringify(compactResult))
  const pairs = cs.events.filter(e => e.type === 'compaction/start').length === cs.events.filter(e => e.type === 'compaction/end').length
  check('compaction bookkeeping stays balanced (stress)', pairs, '')
  let ok = true
  try { new TokenMeter(new Context()).measure(cs); Session.create(cs.id, cs.events) } catch { ok = false }
  check('rewind+turn+compact log replays (meter + resume)', ok, '')
  check('no dangling step/turn frames (stress)', hasNoDanglingFrames(cs.events), '')
}

// 14. I5 probe — rewinding to a message shadowed by a compaction checkpoint
//     is refused by the plugin with its own error (not a crash).
{
  const cs = buildFramedSession('verify-checkpoint', 8)
  const ca = makeAgent(cs.id, cs)
  await call(ca, '@20 chat')
  const compactDef = commands.get('compact')
  await compactDef.handler({ commandId: CommandId('cid'), agent: ca, rawInput: '', signal: aborted() })
  // seq 2 is turn 1's question — now shadowed by the compaction checkpoint.
  const refused = await call(ca, '@2 chat')
  check('rewind across a compaction checkpoint is refused', refused.kind === 'error' && /no longer in the model context/.test(refused.text), refused.text)
}

// 15. /snapshot-auto-cleanup: view/configure, persist to disk, run (dry then
//     apply), and fail-closed on a corrupt config file.
{
  const cleanupDef = commands.get('snapshot-auto-cleanup')
  const callCleanup = rawInput => cleanupDef.handler({ commandId: CommandId('cid'), agent, rawInput, signal: aborted() })
  const exists = async (path) => { try { await stat(path); return true } catch { return false } }
  const seedDir = async (sessionId, mtime) => {
    const anchor = join(snapRoot, sessionId, '1')
    await mkdir(anchor, { recursive: true })
    await writeFile(join(anchor, 'call.json'), JSON.stringify({ callId: 'call', anchorSeq: 1, path: 'x', before: 'v', time: 1 }), 'utf8')
    await utimes(join(anchor, 'call.json'), mtime, mtime)
    await utimes(anchor, mtime, mtime)
    await utimes(join(snapRoot, sessionId), mtime, mtime)
  }

  check('snapshot-auto-cleanup command registered', typeof cleanupDef?.handler === 'function', JSON.stringify(cleanupDef))
  // The client only forwards free-form args (on/off/max-age/run) as rawInput
  // when the command declares `input`; without it, an argued line degrades to
  // a plain message. Guard that the descriptor keeps it.
  check('snapshot-auto-cleanup declares input', cleanupDef?.input !== undefined, JSON.stringify(cleanupDef))

  // Default: disabled, no config file yet.
  const status0 = await callCleanup('')
  check('cleanup default status is disabled', status0.kind === 'success' && /disabled/.test(status0.text), status0.text)

  // Enable persists a config file with enabled:true.
  const onResult = await callCleanup('on')
  check('cleanup on succeeds', onResult.kind === 'success', onResult.text)
  const cfgOn = JSON.parse(await readFile(cleanupConfig, 'utf8'))
  check('cleanup config persisted (enabled)', cfgOn.enabled === true, JSON.stringify(cfgOn))
  const statusOn = await callCleanup('')
  check('cleanup status reflects enabled', statusOn.kind === 'success' && /enabled/.test(statusOn.text), statusOn.text)

  // max-age persists; an invalid value is rejected without writing.
  const maxAgeResult = await callCleanup('max-age 5')
  check('cleanup max-age set', maxAgeResult.kind === 'success', maxAgeResult.text)
  const cfgAge = JSON.parse(await readFile(cleanupConfig, 'utf8'))
  check('cleanup config persisted (maxAgeDays)', cfgAge.maxAgeDays === 5, JSON.stringify(cfgAge))
  const badAge = await callCleanup('max-age 0')
  check('cleanup rejects max-age 0', badAge.kind === 'error', badAge.text)

  // Seed one stale and one fresh session dir, then run (dry, then apply).
  await seedDir('staleCleanup', new Date(Date.now() - 40 * 86_400_000))
  await seedDir('freshCleanup', new Date())

  const dry = await callCleanup('run')
  check('cleanup run dry-run succeeds', dry.kind === 'success', dry.text)
  check('cleanup dry-run leaves the stale dir', await exists(join(snapRoot, 'staleCleanup')))

  const applied = await callCleanup('run --apply')
  check('cleanup run --apply succeeds', applied.kind === 'success', applied.text)
  check('cleanup apply removes the stale dir', !(await exists(join(snapRoot, 'staleCleanup'))))
  check('cleanup apply keeps the fresh dir', await exists(join(snapRoot, 'freshCleanup')))

  // Disable; status reflects it.
  const offResult = await callCleanup('off')
  check('cleanup off succeeds', offResult.kind === 'success', offResult.text)
  const statusOff = await callCleanup('')
  check('cleanup status reflects disabled', statusOff.kind === 'success' && /disabled/.test(statusOff.text), statusOff.text)

  // A corrupt config file fail-closes: `run` reports an error, deletes nothing.
  await writeFile(cleanupConfig, '{broken', 'utf8')
  const badRun = await callCleanup('run')
  check('cleanup run fail-closes on corrupt config', badRun.kind === 'error', badRun.text)
}

// 16. deleting the plugin data directory wipes ONLY file backups: chat
//     rewinds keep working and both-mode preview reports nothing left to
//     restore (the store rebuilds from scratch on the next capture).
{
  await rm(snapRoot, { recursive: true, force: true })
  const chatSession = buildSession('verify-wipe-chat')
  const chatAgent = makeAgent(chatSession.id, chatSession)
  const chatResult = await call(chatAgent, '@2 chat')
  check('chat rewind works after the data dir is deleted', chatResult.kind === 'success', chatResult.text)
  const previewSession = buildSession('verify-wipe-preview')
  const previewAgent = makeAgent(previewSession.id, previewSession)
  const preview = await call(previewAgent, 'preview @2 both')
  check('both preview reports no restorable changes after the wipe', preview.kind === 'success' && /No restorable changes/.test(preview.text), preview.text)
}

await rm(tmpRoot, { recursive: true, force: true })
console.log(failures === 0 ? '\nverify-host: all checks passed' : `\nverify-host: ${failures} check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
