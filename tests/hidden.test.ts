/**
 * Unit tests for the client Chat-snapshot readers and command helpers
 * (src/client/hidden.ts).
 */
import { describe, expect, it } from 'vitest'
import type { CommandNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  ENGINE_COMMAND,
  LEGACY_ENGINE_COMMAND,
  chatNodesOf,
  isExecutedRewindCommand,
  messageAttachmentsAt,
  messageTextAt,
  targetSeqOfArgs,
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

function command(outcome: CommandNode['outcome'], args: string | null = null, name = ENGINE_COMMAND): CommandNode {
  return {
    kind: 'command', seq: 9, time: 0, commandId: 'cid', name, args, outcome,
  } as unknown as CommandNode
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
})

describe('messageTextAt', () => {
  it('reads a withdrawn target from the store, outside order', () => {
    const target = viewNode('u5', 'user', 5, {
      kind: 'user', seq: 5, content: [{ type: 'text', text: 'withdrawn text' }],
    })
    expect(messageTextAt(snap([target], []), 5)).toBe('withdrawn text')
  })

  it('accepts steering rows and returns undefined for an absent seq', () => {
    const target = viewNode('s5', 'steering', 5, {
      kind: 'steering', seq: 5, content: [{ type: 'text', text: 'steered' }],
    })
    const chat = snap([target])
    expect(messageTextAt(chat, 5)).toBe('steered')
    expect(messageTextAt(chat, 99)).toBeUndefined()
    expect(messageTextAt(undefined, 5)).toBeUndefined()
  })
})

describe('messageAttachmentsAt', () => {
  it('reads durable image references from a withdrawn target', () => {
    const target = viewNode('u5', 'user', 5, {
      kind: 'user',
      seq: 5,
      content: [{ type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/png' } }],
    })
    expect(messageAttachmentsAt(snap([target], []), 5)).toEqual([{ attachmentId: 'a1', mediaType: 'image/png' }])
  })

  it('keeps the complete durable reference the session image read verifies', () => {
    const target = viewNode('u6', 'user', 6, {
      kind: 'user',
      seq: 6,
      content: [{
        type: 'image',
        attachment: { attachmentId: 'a6', mediaType: 'image/webp', bytes: 42, width: 7, height: 9, name: 'shot.webp' },
      }],
    })
    expect(messageAttachmentsAt(snap([target], []), 6)).toEqual([{
      attachmentId: 'a6', mediaType: 'image/webp', bytes: 42, width: 7, height: 9, name: 'shot.webp',
    }])
  })

  it('returns [] for a text-only message and undefined for an absent seq', () => {
    const chat = snap([viewNode('u0', 'user', 0, {
      kind: 'user', seq: 0, content: [{ type: 'text', text: 'hi' }],
    })])
    expect(messageAttachmentsAt(chat, 0)).toEqual([])
    expect(messageAttachmentsAt(chat, 99)).toBeUndefined()
    expect(messageAttachmentsAt(undefined, 0)).toBeUndefined()
  })
})

describe('targetSeqOfArgs', () => {
  it('extracts @<seq> from command args', () => {
    expect(targetSeqOfArgs('@2 both')).toBe(2)
    expect(targetSeqOfArgs('@5 chat')).toBe(5)
    expect(targetSeqOfArgs('preview @5 both')).toBe(5)
    expect(targetSeqOfArgs('@5')).toBe(5)
  })

  it('returns undefined for malformed or absent args', () => {
    expect(targetSeqOfArgs(undefined)).toBeUndefined()
    expect(targetSeqOfArgs(null)).toBeUndefined()
    expect(targetSeqOfArgs('preview')).toBeUndefined()
    expect(targetSeqOfArgs('')).toBeUndefined()
    expect(targetSeqOfArgs('@x both')).toBeUndefined()
  })
})

describe('isExecutedRewindCommand', () => {
  it('accepts a marker-carrying success for the target', () => {
    const executed = command({ kind: 'success', sourceEventSeq: 12 }, '@5 both')
    expect(isExecutedRewindCommand(executed, 5)).toBe(true)
    expect(isExecutedRewindCommand(command({ kind: 'success', sourceEventSeq: 12 }, '@5 chat', LEGACY_ENGINE_COMMAND), 5)).toBe(true)
  })

  it('rejects a different target, failed, or markerless command', () => {
    const executed = command({ kind: 'success', sourceEventSeq: 12 }, '@5 both')
    expect(isExecutedRewindCommand(executed, 4)).toBe(false)
    expect(isExecutedRewindCommand(command({ kind: 'error', text: 'no' }, '@5 both'), 5)).toBe(false)
    expect(isExecutedRewindCommand(command({ kind: 'success', text: 'hint' }, '@5 both'), 5)).toBe(false)
    expect(isExecutedRewindCommand(command({ kind: 'success', text: 'probe' }, 'preview @5 both'), 5)).toBe(false)
  })
})
