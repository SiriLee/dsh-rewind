/**
 * Chat-channel probes (SiriLee/dsh-rewind#7). On the target line the chat
 * snapshot lives on the `uiConversation` service's named "chat" view
 * (contributed by dsh-client-ui-chat). `chatSnapshotOf` reads that single
 * channel; these probes lock the view-snapshot shape (Map-like nodes, extra
 * `locations` field) flowing through the hiding logic untouched, and the
 * undefined degradation when no view is registered.
 */
import { describe, expect, it } from 'vitest'
import { chatSnapshotOf, hiddenSeqsOf, type ChatConversationViewNode, type HiddenChat } from '../src/client/hidden.ts'

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

describe('hiddenSeqsOf cut spans', () => {
  /**
   * A snapshot holding one user node per seq plus one executed rewind per cut.
   * Each command's `sourceEventSeq` is the cut's marker seq.
   */
  function rewindChat(cuts: ReadonlyArray<{ target: number; marker: number }>, seqs: readonly number[]): HiddenChat {
    const nodes = new Map<string, unknown>()
    for (const seq of seqs) {
      nodes.set(`m${seq}`, { kind: 'user', anchorSeq: seq, data: { seq, time: 0, content: [] } })
    }
    for (const cut of cuts) {
      nodes.set(`c${cut.marker}`, {
        kind: 'command',
        anchorSeq: cut.marker,
        data: { seq: cut.marker, name: 'rewind', args: `@${cut.target} chat`, outcome: { kind: 'success', sourceEventSeq: cut.marker } },
      })
    }
    return {
      order: [...nodes.keys()],
      nodes: { get: key => nodes.get(key) as ChatConversationViewNode | undefined },
    }
  }

  const range = (from: number, to: number): number[] =>
    Array.from({ length: to - from + 1 }, (_, index) => from + index)

  it('merges overlapping cuts into one range', () => {
    // A later rewind to a point inside the first cut: [1,30] and [20,40] are
    // one continuous withdrawal.
    const chat = rewindChat([{ target: 1, marker: 30 }, { target: 20, marker: 40 }], range(1, 45))
    expect(hiddenSeqsOf(chat)).toEqual(new Set(range(1, 40)))
  })

  it('hides an unbroken run cut by two adjacent rewinds', () => {
    // [1,5] and [6,9] leave no visible seq between them. They stay separate
    // ranges (only strict overlap merges), so this pins the union, not the
    // range count.
    const chat = rewindChat([{ target: 1, marker: 5 }, { target: 6, marker: 9 }], range(1, 12))
    const hidden = hiddenSeqsOf(chat)
    expect(hidden).toEqual(new Set(range(1, 9)))
  })

  it('keeps a gap between cuts visible', () => {
    // The doc's stated reason spans are not collapsed to [min target, max
    // marker]: the seqs between two cuts are still on the surface.
    const chat = rewindChat([{ target: 1, marker: 3 }, { target: 10, marker: 12 }], range(1, 15))
    expect(hiddenSeqsOf(chat)).toEqual(new Set([...range(1, 3), ...range(10, 12)]))
  })

  it('matches the per-seq scan it replaced across many cuts', () => {
    // Equivalence pin for the coalesce + binary search: the same answer the
    // naive "any span contains this seq" scan produced, over 40 cuts.
    const cuts = Array.from({ length: 40 }, (_, index) => ({ target: 1 + index * 7, marker: 1 + index * 7 + 11 + (index % 5) }))
    const seqs = range(1, 400)
    const chat = rewindChat(cuts, seqs)
    const expected = new Set<number>()
    for (const cut of cuts) expected.add(cut.marker)
    for (const seq of seqs) {
      if (cuts.some(cut => seq >= cut.target && seq <= cut.marker)) expected.add(seq)
    }
    expect(hiddenSeqsOf(chat)).toEqual(expected)
  })
})
