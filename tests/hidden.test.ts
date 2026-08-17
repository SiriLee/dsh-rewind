/**
 * Unit tests for the client-side rewind row-hiding computation
 * (src/client/hidden.ts): which transcript rows a rewind hides, across single
 * and MULTIPLE rewinds — including the regression where a second rewind to a
 * LATER point must keep rows cut by an earlier rewind hidden.
 */
import { describe, expect, it } from 'vitest'
import type { ChatConversationViewNode, CommandNode } from '@deepseek-ai/dsh-client-runtime/client'
import { hiddenSeqsOf, targetOfOutcome, type HiddenChat } from '../src/client/hidden.ts'

/** A chat view node for one row; only fields the hiding logic reads are real. */
function viewNode(key: string, kind: string, anchorSeq: number, data: unknown = null): ChatConversationViewNode {
  return {
    key, kind, id: key, target: 'chat', anchorSeq,
    location: undefined as never, visibility: 'visible', data,
  } as unknown as ChatConversationViewNode
}

/** A `/rewind` command row with an explicit settled outcome. */
function rewindCommand(key: string, anchorSeq: number, seq: number, outcome: CommandNode['outcome']): ChatConversationViewNode {
  return viewNode(key, 'command', anchorSeq, {
    kind: 'command', seq, time: 0, commandId: 'cid', name: 'rewind', args: null, outcome,
  } as unknown as CommandNode)
}

/** A real executed rewind (marker seq = sourceEventSeq), target N. */
function executed(key: string, anchorSeq: number, seq: number, target: number): ChatConversationViewNode {
  return rewindCommand(key, anchorSeq, seq, {
    kind: 'success',
    text: `已撤回 seq ${target} 及之后内容（对话已回到此前）。`,
    sourceEventSeq: seq,
  })
}

/** A preview-only rewind: success but no marker appended. */
function preview(key: string, anchorSeq: number, seq: number, target: number): ChatConversationViewNode {
  return rewindCommand(key, anchorSeq, seq, {
    kind: 'success',
    text: `将回退到 seq ${target}，从模型上下文移除 1 个节点（对话日志保留）。`,
    sourceEventSeq: undefined,
  })
}

function snap(nodes: readonly ChatConversationViewNode[]): HiddenChat {
  return {
    order: nodes.map(node => node.key),
    nodes: new Map(nodes.map(node => [node.key, node])),
  }
}

const sorted = (hidden: Set<number>): number[] => [...hidden].sort((a, b) => a - b)

describe('hiddenSeqsOf', () => {
  it('hides the command row and every row in the withdrawn range of one rewind', () => {
    const nodes = [
      viewNode('u0', 'user', 0),
      viewNode('a1', 'assistant', 1),
      viewNode('u2', 'user', 2),
      viewNode('a3', 'assistant', 3),
      viewNode('u4', 'user', 4),
      viewNode('a5', 'assistant', 5),
      executed('cmd', 10, 10, 2),
    ]
    expect(sorted(hiddenSeqsOf(snap(nodes)))).toEqual([2, 3, 4, 5, 10])
  })

  it('keeps rows cut by an earlier rewind hidden after a second rewind to a LATER point', () => {
    // rewind1 withdraws seq 2..10, then new traffic 11/12, then rewind2
    // withdraws 11..13. The second rewind's own range is only [11,13], but rows
    // 2..10 must STAY hidden — the regression the old "latest only" logic had.
    const nodes = [
      viewNode('u0', 'user', 0),
      viewNode('a1', 'assistant', 1),
      viewNode('u2', 'user', 2),
      viewNode('a3', 'assistant', 3),
      viewNode('u4', 'user', 4),
      viewNode('a5', 'assistant', 5),
      viewNode('m10', 'assistant', 10), // marker1 row
      executed('cmd1', 10, 10, 2),
      viewNode('u11', 'user', 11), // new traffic after rewind1
      viewNode('a12', 'assistant', 12),
      viewNode('m13', 'assistant', 13), // marker2 row
      executed('cmd2', 13, 13, 11),
      viewNode('u14', 'user', 14), // visible: after the latest marker
    ]
    expect(sorted(hiddenSeqsOf(snap(nodes)))).toEqual([2, 3, 4, 5, 10, 11, 12, 13])
    // Rows before the earliest cut and after the latest marker stay visible.
    const hidden = hiddenSeqsOf(snap(nodes))
    expect(hidden.has(0)).toBe(false)
    expect(hidden.has(1)).toBe(false)
    expect(hidden.has(14)).toBe(false)
  })

  it('rewinding further back extends the cut to the earliest target', () => {
    const nodes = [
      viewNode('u0', 'user', 0),
      viewNode('a1', 'assistant', 1),
      viewNode('u2', 'user', 2),
      executed('cmd', 9, 9, 0),
      viewNode('u10', 'user', 10),
    ]
    expect(sorted(hiddenSeqsOf(snap(nodes)))).toEqual([0, 1, 2, 9])
    expect(hiddenSeqsOf(snap(nodes)).has(10)).toBe(false)
  })

  it('ignores preview-only commands (no marker appended)', () => {
    const nodes = [
      viewNode('u0', 'user', 0),
      preview('cmd', 6, 6, 2),
      viewNode('u7', 'user', 7),
    ]
    expect(sorted(hiddenSeqsOf(snap(nodes)))).toEqual([])
  })

  it('keeps a failed rewind row visible', () => {
    const nodes = [
      viewNode('u0', 'user', 0),
      rewindCommand('cmd', 6, 6, { kind: 'error', text: '回退失败：无法停止运行中的 agent。', sourceEventSeq: undefined }),
    ]
    expect(sorted(hiddenSeqsOf(snap(nodes)))).toEqual([])
  })

  it('returns nothing for an empty or non-rewind chat', () => {
    expect(sorted(hiddenSeqsOf(snap([])))).toEqual([])
    const nodes = [viewNode('u0', 'user', 0), viewNode('a1', 'assistant', 1)]
    expect(sorted(hiddenSeqsOf(snap(nodes)))).toEqual([])
  })
})

describe('targetOfOutcome', () => {
  it('parses the target seq out of executed and preview texts', () => {
    expect(targetOfOutcome('已撤回 seq 2 及之后内容（对话已回到此前）。')).toBe(2)
    expect(targetOfOutcome('将回退到 seq 5，从模型上下文移除 1 个节点。')).toBe(5)
    expect(targetOfOutcome(undefined)).toBeUndefined()
    expect(targetOfOutcome('回退失败，会话未改变。')).toBeUndefined()
  })
})
