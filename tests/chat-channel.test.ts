/**
 * Chat-channel probes (SiriLee/dsh-rewind#7). On the 0.1.2 line the chat
 * snapshot lives on the `uiConversation` service's named "chat" view
 * (contributed by dsh-client-ui-chat). `chatSnapshotOf` reads that single
 * channel; these probes lock the view-snapshot shape (Map-like nodes, extra
 * `locations` field) flowing through the hiding logic untouched, and the
 * undefined degradation when no view is registered.
 */
import { describe, expect, it } from 'vitest'
import { chatSnapshotOf, hiddenSeqsOf, type HiddenChat } from '../src/client/hidden.ts'

/** The 0.1.2 EMPTY_CHAT_SNAPSHOT shape (dsh-client-ui-chat): Map-like nodes. */
const EMPTY_CHAT_SNAPSHOT_012 = {
  order: [],
  nodes: { get: () => undefined, values: () => [] },
  locations: { get: () => undefined },
}

/** A minimal populated chat snapshot in the same Map-like 0.1.2 shape. */
const chat012 = (order: string[], nodes: Map<string, unknown>) => ({
  order,
  nodes: { get: (key: string) => nodes.get(key), values: () => [...nodes.values()] },
  locations: { get: () => undefined },
})

const viewOf = (snapshot: unknown) => ({ getSnapshot: () => snapshot })

describe('chatSnapshotOf (0.1.2 uiConversation "chat" view)', () => {
  it('reads the chat view snapshot when registered', () => {
    const chat: HiddenChat = { order: [], nodes: { get: () => undefined } }
    expect(chatSnapshotOf(viewOf(chat))).toBe(chat)
  })

  it('degrades to undefined for an unregistered view (getSnapshot() === undefined)', () => {
    expect(chatSnapshotOf(viewOf(undefined))).toBe(undefined)
  })

  it('degrades to undefined when there is no view at all', () => {
    expect(chatSnapshotOf(undefined)).toBe(undefined)
  })

  it('accepts the 0.1.2 EMPTY_CHAT_SNAPSHOT shape (Map-like nodes, locations)', () => {
    const snapshot = chatSnapshotOf(viewOf(EMPTY_CHAT_SNAPSHOT_012))
    expect(snapshot).toBeDefined()
    expect(snapshot!.order).toEqual([])
    expect(snapshot!.nodes.get('missing')).toBeUndefined()
    // The hiding logic walks it without crashing.
    expect(hiddenSeqsOf(snapshot!)).toEqual(new Set())
  })

  it('runs the hiding logic over a 0.1.2-shaped populated snapshot', () => {
    // One executed /rewind @5 chat command (marker seq 7) + messages 1..9.
    const command = {
      kind: 'command',
      anchorSeq: 7,
      data: { seq: 7, name: 'rewind', args: '@5 chat', outcome: { kind: 'success', sourceEventSeq: 7 } },
    }
    const node = (seq: number) => ({ kind: 'user', anchorSeq: seq, data: { seq, time: 0, content: [] } })
    const order = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9']
    const nodes = new Map<string, unknown>(order.map(key => [key, node(Number(key[1]))]))
    nodes.set('c7', command)
    order.push('c7')
    const snapshot = chatSnapshotOf(viewOf(chat012(order, nodes)))!
    // Message anchors 5..7 sit inside the rewind's [target, marker] span.
    expect(hiddenSeqsOf(snapshot)).toEqual(new Set([5, 6, 7]))
  })
})
