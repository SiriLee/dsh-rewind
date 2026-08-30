/**
 * @vitest-environment node
 *
 * Dual-channel probe for the popover's command scanning (`knownCommandSeqs`):
 * the `/rewind` command nodes are discovered by walking the chat snapshot
 * through `chatOf` → `chatSnapshotOf`. These cases pin that the SAME command
 * set is reached whether the chat rides the rc.2 session-face snapshot or the
 * `0.1.2-alpha.1+` `uiConversation` "chat" view, and that a missing channel
 * yields an empty set — the consumer side of the seam the #7 fix rerouted.
 */
import { describe, expect, it } from 'vitest'
import type { ChatConversationViewNode, CommandNode, SessionFace } from '@deepseek-ai/dsh-client-runtime/client'
import { knownCommandSeqs } from '../src/client/popover.ts'
import { chatSnapshotOf, type ChatOf, type HiddenChat } from '../src/client/hidden.ts'

/** A chat snapshot in the HiddenChat shape the command scanner reads. */
function chatOfNodes(nodes: Array<[string, unknown]>): HiddenChat {
  const m = new Map<string, unknown>(nodes)
  return {
    order: [...m.keys()],
    nodes: { get: (key) => m.get(key) as ChatConversationViewNode | undefined },
  }
}

/** A `/rewind` command node in the shape the scanner reads (CommandNode data). */
function rewindNode(seq: number, args: string): unknown {
  return { kind: 'command', anchorSeq: seq, data: { seq, name: 'rewind', args } }
}

/** The scanner only forwards the session to chatOf, which the probes ignore. */
const fakeSession = {} as unknown as SessionFace

/** Matches executed `/rewind` command nodes by name. */
const isRewindCommand = (node: CommandNode) => node.name === 'rewind'

/** rc.2 channel: chat on the session-face snapshot, no `uiConversation` view. */
const rc2 = (chat: HiddenChat): ChatOf => () => chatSnapshotOf({ getSnapshot: () => ({ chat }) }, undefined)

/** alpha.1 channel: face carries no chat; the `uiConversation` "chat" view does. */
const alpha1 = (chat: HiddenChat): ChatOf =>
  () => chatSnapshotOf({ getSnapshot: () => ({}) }, { getSnapshot: () => chat })

const chatWithRewind = chatOfNodes([
  ['m1', { kind: 'user', anchorSeq: 1, data: { seq: 1, time: 1, content: [] } }],
  ['c5', rewindNode(5, '@5 chat')],
])

describe("knownCommandSeqs (command nodes via the dual-channel chat)", () => {
  it('reads /rewind command seqs from the rc.2 session-face chat', () => {
    const known = knownCommandSeqs(fakeSession, rc2(chatWithRewind), isRewindCommand)
    expect(known).toEqual(new Set([5]))
  })

  it('reads the same command set from the alpha.1 uiConversation view', () => {
    const known = knownCommandSeqs(fakeSession, alpha1(chatWithRewind), isRewindCommand)
    expect(known).toEqual(new Set([5]))
  })

  it('degrades to an empty set when no channel has a chat', () => {
    const known = knownCommandSeqs(fakeSession, () => undefined, isRewindCommand)
    expect(known).toEqual(new Set())
  })

  it('only includes nodes matching the predicate', () => {
    const known = knownCommandSeqs(fakeSession, rc2(chatWithRewind), () => false)
    expect(known).toEqual(new Set())
  })
})
