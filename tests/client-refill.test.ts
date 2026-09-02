/**
 * @vitest-environment jsdom
 *
 * Composer-refill probes for the durable rewind path (`runRewindAndFill` in
 * `portals.tsx`): the empty-draft guard (a draft the user is editing must not
 * be clobbered, matching `retractPending`), the event-level refill log, and
 * the teardown-safety rewrite (a `session.command` throw becomes a `warn` on
 * the `void runRewindAndFill(...)` call site instead of a silent unhandled
 * rejection). The session face and chat snapshot are hand fakes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatConversationViewNode, CommandNode, SessionFace } from '@deepseek-ai/dsh-client-runtime/client'
import { runRewindAndFill } from '../src/client/portals.tsx'
import type { ChatOf, HiddenChat } from '../src/client/hidden.ts'

const TARGET = 5
const COMMAND_SEQ = 99
const TEXT = 'hello world'

/** A chat view node; only the fields the reading logic touches are real. */
function node(key: string, kind: string, anchorSeq: number, data: unknown): ChatConversationViewNode {
  return { key, kind, id: key, target: 'chat', anchorSeq, data } as unknown as ChatConversationViewNode
}

/** A user message row carrying the target seq + editable text. */
function userNode(seq: number): ChatConversationViewNode {
  return node(`u${seq}`, 'user', seq, { seq, content: [{ type: 'text', text: TEXT }] })
}

/** An executed rewind command row (success + marker) targeting `target`. */
function executedRewind(seq: number, target: number): ChatConversationViewNode {
  const data = {
    kind: 'command', seq, time: 0, commandId: 'cid', name: 'rewind',
    args: `@${target} both`,
    outcome: { kind: 'success', text: `Withdrawn seq ${target} and everything after it.`, sourceEventSeq: seq },
  } as unknown as CommandNode
  return node(`c${seq}`, 'command', seq, data)
}

function makeChat(nodes: readonly ChatConversationViewNode[]): HiddenChat {
  const order: string[] = []
  const map = new Map<string, ChatConversationViewNode>()
  for (const n of nodes) {
    order.push(n.key)
    map.set(n.key, n)
  }
  return { order, nodes: { get: (k: string) => map.get(k) } } as HiddenChat
}

/** Build a fake session whose `command` appends the executed rewind node. */
function fakeSession() {
  let chat = makeChat([userNode(TARGET)])
  const command = vi.fn(async () => {
    chat = makeChat([userNode(TARGET), executedRewind(COMMAND_SEQ, TARGET)])
    return { ok: true, value: { matched: true } }
  })
  const session = {
    sessionId: 's1',
    command,
    subscribe: vi.fn(() => () => {}),
    getSnapshot: vi.fn(() => ({})),
  } as unknown as SessionFace
  const chatOf: ChatOf = () => chat
  return { session, chatOf, command }
}

/** A `[data-composer-input]` contenteditable holding an existing draft. */
function addEditableDraft(text: string): HTMLElement {
  const editable = document.createElement('div')
  editable.setAttribute('data-composer-input', '')
  editable.setAttribute('contenteditable', 'true')
  editable.textContent = text
  document.body.appendChild(editable)
  return editable
}

afterEach(() => {
  document.body.innerHTML = ''
  localStorage.removeItem('dsh-rewind.debug')
  vi.restoreAllMocks()
})

describe('runRewindAndFill (durable rewind refill)', () => {
  const currentSessionId = (): string => 's1'

  it('refills the empty composer and logs the event when the switch is on', async () => {
    const { session, chatOf, command } = fakeSession()
    const setComposerText = vi.fn(() => true)
    localStorage.setItem('dsh-rewind.debug', 'dsh-rewind:refill')
    const info = vi.spyOn(console, 'info').mockReturnValue(undefined)
    await runRewindAndFill(session, TARGET, 'both', currentSessionId, chatOf, setComposerText)
    expect(command).toHaveBeenCalledWith(`/rewind @${TARGET} both`)
    expect(setComposerText).toHaveBeenCalledTimes(1)
    expect(setComposerText).toHaveBeenCalledWith('s1', TEXT)
    expect(info).toHaveBeenCalledTimes(1)
  })

  it('skips the refill when the composer already holds a draft (guard)', async () => {
    addEditableDraft('in progress draft')
    const { session, chatOf } = fakeSession()
    const setComposerText = vi.fn(() => true)
    await runRewindAndFill(session, TARGET, 'both', currentSessionId, chatOf, setComposerText)
    expect(setComposerText).not.toHaveBeenCalled()
  })

  it('turns a session.command throw into a warn instead of an unhandled rejection', async () => {
    const { session, chatOf } = fakeSession()
    session.command = vi.fn(async () => { throw new Error('teardown') }) as SessionFace['command']
    const setComposerText = vi.fn(() => true)
    const warn = vi.spyOn(console, 'warn').mockReturnValue(undefined)
    await expect(runRewindAndFill(session, TARGET, 'both', currentSessionId, chatOf, setComposerText)).resolves.toBeUndefined()
    expect(setComposerText).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('does nothing on an unmatched rewind (matched !== true)', async () => {
    const { session, chatOf } = fakeSession()
    session.command = vi.fn(async () => ({ ok: true, value: { matched: false } })) as SessionFace['command']
    const setComposerText = vi.fn(() => true)
    await runRewindAndFill(session, TARGET, 'both', currentSessionId, chatOf, setComposerText)
    expect(setComposerText).not.toHaveBeenCalled()
  })
})
