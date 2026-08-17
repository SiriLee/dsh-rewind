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
 *  4. write tools are ledgered through pre/post-execute;
 *  5. `/rewind preview @<seq> both` reports the file impact;
 *  6. `/rewind @<seq> both` restores the file and reports it.
 */
import { Context } from '@deepseek-ai/cordis'
import { FileSystem, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { apply as applyRewind } from '../lib/index.js'

const aborted = () => new AbortController().signal

/** In-memory fs double (resolve/readText/writeText/processPath + delete via processPath). */
class FakeFs extends FileSystem {
  files = new Map()
  async resolve(path) { return { targetKey: FsTargetKey(path), displayPath: path } }
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

const session = Session.create(SessionId('verify-host'))
const user = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const assistant = text => createAssistantMessage({ content: [{ type: 'text', text }], source: { provider: 'test', model: 'test' } })
session.append('user/message', user('first question'), { surfaceOp: 'append' })
session.append('assistant/message', { turn: 0, step: 0, message: assistant('first answer') }, { surfaceOp: 'append' })
session.append('user/message', user('second question'), { surfaceOp: 'append' })
session.append('assistant/message', { turn: 1, step: 0, message: assistant('second answer') }, { surfaceOp: 'append' })

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

const call = rawInput => registered.handler({ commandId: Symbol('cid'), agent, rawInput, signal: aborted() })

let failures = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — ${detail}`}`)
  if (!ok) failures += 1
}

// 1. command registered
check('command registered', typeof registered?.handler === 'function' && registered.name === 'rewind', JSON.stringify(registered))

// 2. bare /rewind lists candidates
const listResult = await call('')
check('bare /rewind lists candidates', listResult.kind === 'success' && listResult.text.includes('second question') && listResult.text.includes('first question'), listResult.text)

// 3. /rewind @2 chat cuts the surface in place
const before = [...session.surface.nodes]
const chatResult = await call('@2 chat')
const after = [...session.surface.nodes]
check('rewind chat succeeds', chatResult.kind === 'success', chatResult.text)
check('surface cut to [0,1,2,marker]', after.length === 4 && after[0] === 0 && after[1] === 1 && after[2] === 2 && after[3] > 3, `before ${JSON.stringify(before)} -> after ${JSON.stringify(after)}`)
check('log stays append-only (5 events)', session.events.length === 5, `events=${session.events.length}`)

// 4. ledger records a write after the rewind point
const exec = {
  callId: 'c1', name: 'write', arguments: { file_path: '/workspace/a.txt', content: 'rewritten' },
  agent, signal: aborted(),
}
// tools/pre-execute (waterfall) captures the before-state…
await ctx.waterfall('tools/pre-execute', exec, async () => ({ kind: 'allow' }))
// …the tool body actually writes the file…
await fs.writeText({ targetKey: FsTargetKey('/workspace/a.txt'), displayPath: '/workspace/a.txt' }, 'rewritten')
// …tools/post-execute (waterfall) commits the ledger entry.
await ctx.waterfall('tools/post-execute', exec, { isError: false, content: [] }, async () => ({ kind: 'accept' }))
check('file mutated on disk', fs.files.get('/workspace/a.txt') === 'rewritten', fs.files.get('/workspace/a.txt'))

// 5. preview reports the impact (rewind to seq 2 reverts the anchor-2 write)
const previewResult = await call('preview @2 both')
check('preview shows file impact', previewResult.kind === 'success' && previewResult.text.includes('/workspace/a.txt'), previewResult.text)

// 6. both mode restores the file
const bothResult = await call('@2 both')
check('rewind both restores file', bothResult.kind === 'success' && bothResult.text.includes('还原 1 个文件'), bothResult.text)
check('file content restored', fs.files.get('/workspace/a.txt') === 'original content', fs.files.get('/workspace/a.txt'))

// 7. safety guard: running agent refuses
const running = { ...agent, status: 'running' }
const runningResult = await registered.handler({ commandId: Symbol('cid'), agent: running, rawInput: '@2 chat', signal: aborted() })
check('running agent refused', runningResult.kind === 'error', runningResult.text)

console.log(failures === 0 ? '\nverify-host: all checks passed' : `\nverify-host: ${failures} check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
