/**
 * Compatibility invariant I9 probe — tool-update history across a rewind
 * (DSH 0.1.7-rc.2).
 *
 * The rc.2 line lets an ONGOING conversation use a newly enabled tool: the
 * agent loop appends a `developer/message` carrying `tool-addition` /
 * `tool-removal` blocks, and every request projects them through
 * `Session.toolHistory()` + `projectToolUpdates()`. The fold reads the WHOLE
 * append-only log, while a rewind cuts only the model-visible surface — so a
 * withdrawn tool-addition stays in the fold but leaves the derived messages.
 *
 * I9 pins that this combination stays safe, using the harness's REAL
 * projection code (no mocks), because dsh-rewind is the only producer of
 * surface cuts:
 *
 *   - folding a rewind-bearing tool-update log never throws, and the log stays
 *     replayable for `Session.create`;
 *   - while the update is ON the surface it is genuinely projected — the probe
 *     exercises the mechanism, not only its fallback;
 *   - once a rewind withdraws it, no `tool-addition` / `tool-removal` block
 *     reaches the provider and the complete current declarations survive.
 */
import { describe, expect, it } from 'vitest'
import { createDeveloperMessage, type ToolSchema } from '@deepseek-ai/dsh-llm'
import { projectToolUpdates } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, type SessionSeq } from '@deepseek-ai/dsh-session'
// Type-only: pulls the `tool-registry` MessageSourceMap entry the agent loop
// uses for its tool-change developer messages.
import type {} from '@deepseek-ai/dsh-tools'
import { applyRewind, assistantMessage, textMessage } from './helpers.ts'

/** The request header every synthetic request in this probe is built under. */
const CONFIG = { provider: 'test', model: 'test-model' } as const

/** The tool set before the conversation enables a second one. */
const ALPHA: ToolSchema = { name: 'alpha', description: 'first tool', parameters: { type: 'object' } }
/** The tool enabled mid-conversation, exactly as the registry would declare it. */
const BETA: ToolSchema = { name: 'beta', description: 'later tool', parameters: { type: 'object' } }

/** Every block type the tool-update projection decides on. */
function toolBlocksOf(messages: readonly { readonly role: string; readonly content: readonly { readonly type: string }[] }[]): string[] {
  return messages.flatMap(message => message.content
    .filter(block => block.type === 'tool-addition' || block.type === 'tool-removal')
    .map(block => block.type))
}

/**
 * A session shaped like the rc.2 agent loop: turn 1 logs the initial header
 * `[alpha]`; turn 2 diffs the assembled tools, logs a `change` header
 * `[alpha, beta]` plus the tool-addition developer message that activates
 * `beta`, then completes. `target` is turn 2's user message — rewinding to it
 * withdraws the developer message while leaving the header in the log.
 * @returns the live session and the rewind target seq.
 */
function buildToolUpdateSession(): { session: Session; target: SessionSeq } {
  const session = Session.create(SessionId('compat-tool-updates'))
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('user/message', textMessage('question 1'), { surfaceOp: 'append' })
  session.append('request/header', { header: { config: CONFIG, tools: [ALPHA] }, reason: 'initial' })
  session.append('assistant/message', {
    turn: 1, step: 1, message: assistantMessage('answer 1'), stream: [],
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

  session.append('turn/start', { turn: 2 })
  session.append('step/start', { turn: 2, step: 1 })
  const target = session.append('user/message', textMessage('question 2'), { surfaceOp: 'append' }).seq
  const changed = session.append('request/header', {
    header: { config: CONFIG, tools: [ALPHA, BETA] }, reason: 'change',
  })
  session.append('developer/message', {
    turn: 2,
    step: 1,
    message: createDeveloperMessage({
      source: { kind: 'tool-registry' },
      content: [{ type: 'tool-addition', toolName: BETA.name }],
    }),
    headerSeq: changed.seq,
  }, { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 2, step: 1, message: assistantMessage('answer 2'), stream: [],
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 2, step: 1 })
  session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
  return { session, target }
}

describe('I9 tool-update history survives a surface cut', () => {
  it('projects a surface tool addition, then drops it once a rewind withdraws it', () => {
    const { session, target } = buildToolUpdateSession()
    const currentTools = [ALPHA, BETA]

    // On-surface: the addition is real, so the probe cannot pass on the
    // fallback path alone. `beta` follows the cached history as a deferred
    // declaration activated by the recorded developer message.
    const onSurface = projectToolUpdates(session.deriveMessages(), currentTools, 'addition-only', session.toolHistory())
    expect(onSurface.tools).toEqual([ALPHA, { ...BETA, deferLoading: true }])
    expect(toolBlocksOf(onSurface.messages)).toEqual(['tool-addition'])

    // The rewind withdraws the developer message (a surface node) and leaves
    // the request header (a log-only event) untouched.
    applyRewind(session, target)
    expect(toolBlocksOf(session.deriveMessages())).toEqual([])

    // The fold reads the full log, so the withdrawn update is still recorded —
    // this is the hazard the projection's guard exists for.
    const history = session.toolHistory()
    expect(history.updates).toHaveLength(1)
    expect([...history.updates[0]!.additions.map(tool => tool.name)]).toEqual([BETA.name])

    // I9a: no tool-change block leaks into the provider request, and the
    // complete current declarations survive the fallback.
    const afterRewind = projectToolUpdates(session.deriveMessages(), currentTools, 'addition-only', history)
    expect(toolBlocksOf(afterRewind.messages)).toEqual([])
    expect(afterRewind.tools).toEqual(currentTools)
    expect(JSON.stringify(afterRewind.messages)).not.toContain('tool-addition')

    // I9b: a rewind-bearing tool-update log stays replayable (I1 scope).
    expect(() => session.toolHistory()).not.toThrow()
    expect(() => Session.create(session.id, session.snapshotEvents())).not.toThrow()
  })

  it('keeps the declaration list complete when no route projects tool updates', () => {
    const { session } = buildToolUpdateSession()
    // A route without `toolUpdate` support receives immediate tools and no
    // developer tool-change messages at all.
    const projected = projectToolUpdates(session.deriveMessages(), [ALPHA, BETA], undefined, session.toolHistory())
    expect(toolBlocksOf(projected.messages)).toEqual([])
    expect(projected.tools).toEqual([ALPHA, BETA])
  })
})
