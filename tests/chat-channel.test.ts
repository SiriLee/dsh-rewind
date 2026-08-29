/**
 * Chat-channel compatibility probes (SiriLee/dsh-rewind#7). Since harness
 * 0.1.2-alpha.1 the chat snapshot moved off the session face into the
 * `uiConversation` service's named "chat" view (contributed by
 * dsh-client-ui-chat). The plugin reads BOTH channels through
 * `chatSnapshotOf`; these probes lock the channel precedence and the alpha.1
 * snapshot shape (Map-like nodes, extra `locations` field) flowing through
 * the hiding logic untouched.
 */
import { describe, expect, it } from 'vitest'
import { chatSnapshotOf, hiddenSeqsOf, type HiddenChat } from '../src/client/hidden.ts'

/** A face whose snapshot carries the rc.2 `chat` field. */
const faceWith = (chat: unknown) => ({ getSnapshot: () => ({ chat }) })

/** The alpha.1 face: the chat field is gone entirely (reads undefined). */
const faceAlpha1 = faceWith(undefined)

/** The alpha.1 EMPTY_CHAT_SNAPSHOT shape (dsh-client-ui-chat): Map-like nodes. */
const EMPTY_CHAT_SNAPSHOT_ALPHA1 = {
  order: [],
  nodes: { get: () => undefined, values: () => [] },
  locations: { get: () => undefined },
}

/** A minimal populated chat snapshot in the same Map-like alpha.1 shape. */
const chatAlpha1 = (order: string[], nodes: Map<string, unknown>) => ({
  order,
  nodes: { get: (key: string) => nodes.get(key), values: () => [...nodes.values()] },
  locations: { get: () => undefined },
})

const viewOf = (snapshot: unknown) => ({ getSnapshot: () => snapshot })

describe('chat channel precedence (rc.2 face vs alpha.1+ uiConversation view)', () => {
  it('reads the rc.2 session-face chat first', () => {
    const chat: HiddenChat = { order: [], nodes: { get: () => undefined } }
    expect(chatSnapshotOf(faceWith(chat), viewOf(EMPTY_CHAT_SNAPSHOT_ALPHA1))).toBe(chat)
  })

  it('falls through an alpha.1 face (chat === undefined) to the uiConversation view', () => {
    const chat: HiddenChat = { order: [], nodes: { get: () => undefined } }
    expect(chatSnapshotOf(faceAlpha1, viewOf(chat))).toBe(chat)
  })

  it('falls through an unregistered view (getSnapshot() === undefined)', () => {
    const chat: HiddenChat = { order: [], nodes: { get: () => undefined } }
    expect(chatSnapshotOf(faceAlpha1, viewOf(undefined))).toBe(undefined)
    // rc.2 face + not-yet-registered view still serves the face snapshot.
    expect(chatSnapshotOf(faceWith(chat), viewOf(undefined))).toBe(chat)
  })

  it('degrades to undefined when no channel has a chat', () => {
    expect(chatSnapshotOf(faceAlpha1, undefined)).toBe(undefined)
    expect(chatSnapshotOf(undefined, viewOf(undefined))).toBe(undefined)
    expect(chatSnapshotOf(undefined, undefined)).toBe(undefined)
  })

  it('accepts the alpha.1 EMPTY_CHAT_SNAPSHOT shape (Map-like nodes, locations)', () => {
    const snapshot = chatSnapshotOf(faceAlpha1, viewOf(EMPTY_CHAT_SNAPSHOT_ALPHA1))
    expect(snapshot).toBeDefined()
    expect(snapshot!.order).toEqual([])
    expect(snapshot!.nodes.get('missing')).toBeUndefined()
    // The hiding logic walks it without crashing.
    expect(hiddenSeqsOf(snapshot!)).toEqual(new Set())
  })

  it('runs the hiding logic over an alpha.1-shaped populated snapshot', () => {
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
    const snapshot = chatSnapshotOf(faceAlpha1, viewOf(chatAlpha1(order, nodes)))!
    // Message anchors 5..7 sit inside the rewind's [target, marker] span.
    expect(hiddenSeqsOf(snapshot)).toEqual(new Set([5, 6, 7]))
  })
})
