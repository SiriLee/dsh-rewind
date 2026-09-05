/**
 * @vitest-environment jsdom
 *
 * Composer-refill probes for the durable rewind path (`runRewindAndFill` in
 * `portals.tsx`): the empty-draft guard (a draft the user is editing must not
 * be clobbered, matching `retractPending`), the narrowed contract that a
 * normal rewind emits no verbose diagnostics, and the teardown-safety rewrite
 * (a `session.command` throw becomes a `warn` on the
 * `void runRewindAndFill(...)` call site instead of a silent unhandled
 * rejection). The session face and chat snapshot are hand fakes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatConversationViewNode, CommandNode, SessionFace } from '../src/client/dsh-types.ts'
import { runRewindAndFill } from '../src/client/portals.tsx'
import type { ChatOf, ChatWatch, HiddenChat } from '../src/client/hidden.ts'

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
  // First-check hit path: the watch is never needed (no-op), but the signature
  // now requires it. See fakeSessionControlled for the watch-driven path.
  const watch: ChatWatch = () => () => {}
  return { session, chatOf, command, watch }
}

/**
 * A fake session that does NOT append the executed rewind node inside
 * `command`: the first check misses, and the refill only proceeds once the
 * chat-update `watch` fires (0.1.2 signal path). Exposes a manual trigger.
 */
function fakeSessionControlled() {
  let chat = makeChat([userNode(TARGET)])
  let trigger: (() => void) | null = null
  const command = vi.fn(async () => ({ ok: true, value: { matched: true } }))
  const watch: ChatWatch = (_sid, cb) => {
    trigger = cb
    return () => {}
  }
  const session = {
    sessionId: 's1',
    command,
    subscribe: vi.fn(() => () => {}),
    getSnapshot: vi.fn(() => ({})),
  } as unknown as SessionFace
  const chatOf: ChatOf = () => chat
  const settleChat = (): void => {
    chat = makeChat([userNode(TARGET), executedRewind(COMMAND_SEQ, TARGET)])
  }
  return { session, chatOf, command, watch, settleChat, getTrigger: (): (() => void) | null => trigger }
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

  it('refills the empty composer (normal path emits no verbose diagnostics)', async () => {
    const { session, chatOf, command, watch } = fakeSession()
    const setComposerText = vi.fn(() => true)
    // The DEBUG switch no longer gates any call in this path: even with it
    // on, a successful rewind must not emit verbose info/debug output.
    localStorage.setItem('dsh-rewind.debug', 'dsh-rewind:refill,dsh-rewind:hiding')
    const info = vi.spyOn(console, 'info').mockReturnValue(undefined)
    const debug = vi.spyOn(console, 'debug').mockReturnValue(undefined)
    await runRewindAndFill(session, TARGET, 'both', currentSessionId, chatOf, watch, setComposerText)
    expect(command).toHaveBeenCalledWith(`/rewind @${TARGET} both`)
    expect(setComposerText).toHaveBeenCalledTimes(1)
    expect(setComposerText).toHaveBeenCalledWith('s1', TEXT)
    expect(info).not.toHaveBeenCalled()
    expect(debug).not.toHaveBeenCalled()
  })

  it('skips the refill when the composer already holds a draft (guard)', async () => {
    addEditableDraft('in progress draft')
    const { session, chatOf, watch } = fakeSession()
    const setComposerText = vi.fn(() => true)
    await runRewindAndFill(session, TARGET, 'both', currentSessionId, chatOf, watch, setComposerText)
    expect(setComposerText).not.toHaveBeenCalled()
  })

  it('turns a session.command throw into a warn instead of an unhandled rejection', async () => {
    const { session, chatOf, watch } = fakeSession()
    session.command = vi.fn(async () => { throw new Error('teardown') }) as SessionFace['command']
    const setComposerText = vi.fn(() => true)
    const warn = vi.spyOn(console, 'warn').mockReturnValue(undefined)
    await expect(runRewindAndFill(session, TARGET, 'both', currentSessionId, chatOf, watch, setComposerText)).resolves.toBeUndefined()
    expect(setComposerText).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('does nothing on an unmatched rewind (matched !== true)', async () => {
    const { session, chatOf, watch } = fakeSession()
    session.command = vi.fn(async () => ({ ok: true, value: { matched: false } })) as SessionFace['command']
    const setComposerText = vi.fn(() => true)
    await runRewindAndFill(session, TARGET, 'both', currentSessionId, chatOf, watch, setComposerText)
    expect(setComposerText).not.toHaveBeenCalled()
  })

  it('refills after the chat-update watch fires (0.1.2 signal path: the first check misses)', async () => {
    const { session, chatOf, command, watch, settleChat, getTrigger } = fakeSessionControlled()
    const setComposerText = vi.fn(() => true)
    const call = runRewindAndFill(session, TARGET, 'both', currentSessionId, chatOf, watch, setComposerText)
    // command resolves (matched) and the first check misses; the refill waits on watch
    await Promise.resolve()
    await Promise.resolve()
    settleChat()
    getTrigger()?.()
    await call
    expect(command).toHaveBeenCalledWith(`/rewind @${TARGET} both`)
    expect(setComposerText).toHaveBeenCalledTimes(1)
    expect(setComposerText).toHaveBeenCalledWith('s1', TEXT)
  })

  it('still honours the empty-composer guard when the watch fires late', async () => {
    addEditableDraft('in progress draft')
    const { session, chatOf, watch, settleChat, getTrigger } = fakeSessionControlled()
    const setComposerText = vi.fn(() => true)
    const call = runRewindAndFill(session, TARGET, 'both', currentSessionId, chatOf, watch, setComposerText)
    await Promise.resolve()
    await Promise.resolve()
    settleChat()
    getTrigger()?.()
    await call
    expect(setComposerText).not.toHaveBeenCalled()
  })
})
