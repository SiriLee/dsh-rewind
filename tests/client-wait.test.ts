/**
 * @vitest-environment jsdom
 *
 * `waitForCommand` wait-signal probes (SiriLee/dsh-rewind#14): a waiting caller
 * must be woken when the CHAT snapshot changes. On the 0.1.2 line the chat
 * moved off the session face into the `uiConversation` view, so the face no
 * longer fires on a chat update; the caller passes a `watch` bound to that
 * view. These tests lock the three behaviors: first-check hit, watch-triggered
 * hit, and timeout — plus the `resolveChatWatch` view-only channel selection.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatConversationViewNode, CommandNode, SessionFace } from '../src/client/dsh-types.ts'
import { waitForCommand } from '../src/client/popover.ts'
import { isExecutedRewindCommand, resolveChatWatch, type ChatOf, type HiddenChat } from '../src/client/hidden.ts'

const TARGET = 5
const COMMAND_SEQ = 99
const OUTCOME_TEXT = 'Withdrawn seq 5 and everything after it.'

function node(key: string, kind: string, anchorSeq: number, data: unknown): ChatConversationViewNode {
  return { key, kind, id: key, target: 'chat', anchorSeq, data } as unknown as ChatConversationViewNode
}

function userNode(seq: number): ChatConversationViewNode {
  return node(`u${seq}`, 'user', seq, { seq, content: [{ type: 'text', text: 'hello world' }] })
}

function executedRewind(seq: number, target: number): ChatConversationViewNode {
  const data = {
    kind: 'command', seq, time: 0, commandId: 'cid', name: 'rewind',
    args: `@${target} both`,
    outcome: { kind: 'success', text: OUTCOME_TEXT, sourceEventSeq: seq },
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

/** A fake session + chat variable with a live-outcome roll-in helper. */
function makeFake() {
  let chat = makeChat([userNode(TARGET)])
  const session = {
    sessionId: 's1',
  } as unknown as SessionFace
  const chatOf: ChatOf = () => chat
  const settleChatWithOutcome = (): void => {
    chat = makeChat([userNode(TARGET), executedRewind(COMMAND_SEQ, TARGET)])
  }
  return { session, chatOf, settleChatWithOutcome }
}

const matchExecuted = (node: CommandNode): boolean => isExecutedRewindCommand(node, TARGET)

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('waitForCommand wait signal', () => {
  it('resolves immediately when the first check finds an outcome', async () => {
    const { session, chatOf, settleChatWithOutcome } = makeFake()
    settleChatWithOutcome()
    const outcome = await waitForCommand(session, chatOf, matchExecuted, 8000, () => () => {})
    expect(outcome).toEqual({ kind: 'success', text: OUTCOME_TEXT })
  })

  it('is woken by the passed watch when the first check misses (0.1.2 chat-update signal)', async () => {
    const { session, chatOf, settleChatWithOutcome } = makeFake()
    const callbacks: Array<() => void> = []
    const watch = (cb: () => void): (() => void) => {
      callbacks.push(cb)
      return () => {}
    }
    // First check runs synchronously but finds no outcome yet -> waits on watch.
    const pending = waitForCommand(session, chatOf, matchExecuted, 8000, watch)
    expect(callbacks).toHaveLength(1)
    // The chat snapshot updates (as on the 0.1.2 line), then the watch fires.
    settleChatWithOutcome()
    for (const cb of callbacks) cb()
    await expect(pending).resolves.toEqual({ kind: 'success', text: OUTCOME_TEXT })
  })

  it('resolves null on timeout when nothing ever signals', async () => {
    vi.useFakeTimers()
    const { session, chatOf } = makeFake()
    const pending = waitForCommand(session, chatOf, matchExecuted, 5000, () => () => {})
    await vi.advanceTimersByTimeAsync(5000)
    await expect(pending).resolves.toBeNull()
  })
})

describe('resolveChatWatch channel selection', () => {
  const viewOf = (subscribe?: (cb: () => void) => () => void) => ({ subscribe })

  it('subscribes to the uiConversation view subscribe when it is reachable', () => {
    const viewSub = vi.fn(() => () => {})
    resolveChatWatch(() => viewOf(viewSub), 's1', () => {})
    expect(viewSub).toHaveBeenCalledTimes(1)
  })

  it('returns a no-op unsubscriber when the view is unreachable', () => {
    const unsub = resolveChatWatch(() => undefined, 's1', () => {})
    expect(typeof unsub).toBe('function')
    expect(() => unsub()).not.toThrow()
  })

  it('returns a no-op unsubscriber when the view has no subscribe', () => {
    const unsub = resolveChatWatch(() => viewOf(undefined), 's1', () => {})
    expect(typeof unsub).toBe('function')
    expect(() => unsub()).not.toThrow()
  })
})
