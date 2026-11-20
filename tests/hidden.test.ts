/**
 * Unit tests for the client Chat-snapshot readers (`src/client/hidden.ts`).
 */
import { describe, expect, it } from 'vitest'
import {
  chatNodesOf,
  chatSnapshotOf,
  imageRefsOf,
  type ChatConversationViewNode,
  type HiddenChat,
} from '../src/client/hidden.ts'

/** A chat view node for one row; only fields the readers use are real. */
function viewNode(key: string, kind: string, anchorSeq: number, data: unknown = null): ChatConversationViewNode {
  return {
    key, kind, id: key, target: 'chat', anchorSeq,
    visibility: 'visible', data,
  } as unknown as ChatConversationViewNode
}

function snap(nodes: readonly ChatConversationViewNode[], order = nodes.map(node => node.key)): HiddenChat {
  return {
    order,
    nodes: {
      get: (key: string) => nodes.find(node => node.key === key),
      values: () => nodes,
    },
  }
}

describe('chatNodesOf', () => {
  it('includes hidden nodes when the store exposes values', () => {
    const hidden = { ...viewNode('u1', 'user', 1), visibility: 'hidden' as const }
    expect(chatNodesOf(snap([hidden], [])).map(node => node.key)).toEqual(['u1'])
  })

  it('falls back to the visible order on an older snapshot', () => {
    const nodes = new Map([['u1', viewNode('u1', 'user', 1)]])
    const chat: HiddenChat = { order: ['u1'], nodes: { get: key => nodes.get(key) } }
    expect(chatNodesOf(chat).map(node => node.key)).toEqual(['u1'])
  })

  it('returns no nodes when the chat is unavailable', () => {
    expect(chatNodesOf(undefined)).toEqual([])
  })
})

describe('chatSnapshotOf', () => {
  it('reads the view snapshot and degrades to undefined without a view', () => {
    const chat = snap([viewNode('u1', 'user', 1)])
    expect(chatSnapshotOf({ getSnapshot: () => chat })).toBe(chat)
    expect(chatSnapshotOf(undefined)).toBeUndefined()
  })
})

describe('imageRefsOf', () => {
  it('keeps the complete durable reference the session image read verifies', () => {
    expect(imageRefsOf([{
      type: 'image',
      attachment: { attachmentId: 'a6', mediaType: 'image/webp', bytes: 42, width: 7, height: 9, name: 'shot.webp' },
    }])).toEqual([{
      attachmentId: 'a6', mediaType: 'image/webp', bytes: 42, width: 7, height: 9, name: 'shot.webp',
    }])
  })

  it('skips malformed, non-image and file blocks', () => {
    expect(imageRefsOf([
      { type: 'text' },
      { type: 'file', attachment: { attachmentId: 'f1', mediaType: 'text/plain' } },
      { type: 'image', attachment: { attachmentId: 'bad' } },
      { type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/png' } },
    ])).toEqual([{ attachmentId: 'a1', mediaType: 'image/png' }])
  })

  it('returns [] for missing content', () => {
    expect(imageRefsOf(undefined)).toEqual([])
  })
})
