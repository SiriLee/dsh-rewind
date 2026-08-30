/**
 * @vitest-environment jsdom
 *
 * DOM-level probe for the rewind button path (SiriLee/dsh-rewind#7). The
 * chat-channel fix reroutes the chat snapshot through `chatSnapshotOf`; these
 * cases pin the DOM→targets pairing (`collectTargets`) that turns a session's
 * chat nodes × action rows into the per-message ↶ portal targets — the one
 * piece the pure-function suites (`chat-channel`, `hidden`) do not reach.
 *
 * Compilation: typechecked by `tsconfig.client-test.json` (client surface +
 * JSX), excluded from `tsconfig.json` (host, no JSX) — see the neighbouring
 * `client-contract.test.ts` comment.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { ChatConversationViewNode } from '@deepseek-ai/dsh-client-runtime/client'
import { collectTargets } from '../src/client/portals.tsx'
import type { HiddenChat } from '../src/client/hidden.ts'

/** A durable user node in the HiddenChat shape the collector reads. */
function userNode(seq: number) {
  return {
    kind: 'user',
    anchorSeq: seq,
    data: { seq, time: seq * 1000, content: [{ type: 'text', text: `msg ${seq}` }] },
  }
}

/** Build a HiddenChat snapshot whose nodes are served by a Map. */
function chatWith(entries: Array<[string, unknown]>): HiddenChat {
  const nodes = new Map<string, unknown>(entries)
  return {
    order: [...nodes.keys()],
    nodes: { get: (key) => nodes.get(key) as ChatConversationViewNode | undefined },
  }
}

/** Append a user/steering row whose `[data-time-hover-root]` last child is an
 * actions container with a `<button>` — the shape the collector accepts. */
function addRow(kind: string, key: string, withButton = true): HTMLElement {
  const row = document.createElement('div')
  row.dataset.chatFlowKind = kind
  row.dataset.chatAnchorKey = key
  const root = document.createElement('div')
  root.setAttribute('data-time-hover-root', '')
  const bubble = document.createElement('div')
  bubble.textContent = 'bubble'
  const actions = document.createElement('div')
  actions.className = 'actions'
  if (withButton) {
    const button = document.createElement('button')
    button.textContent = 'Copy'
    actions.appendChild(button)
  }
  root.append(bubble, actions)
  row.appendChild(root)
  document.body.appendChild(row)
  return actions
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('collectTargets (chat node × user action row → portal target)', () => {
  it('collects a durable target for a matched user row', () => {
    const actions = addRow('user', 'm1')
    const targets = collectTargets(chatWith([['m1', userNode(5)]]), new Set())
    expect(targets).toHaveLength(1)
    expect(targets[0]).toEqual({
      kind: 'durable',
      key: 'm1',
      container: actions,
      seq: 5,
      time: 5000,
      preview: 'msg 5',
    })
  })

  it('collects steering rows the same way', () => {
    const actions = addRow('steering', 'm2')
    const targets = collectTargets(
      chatWith([['m2', { kind: 'steering', anchorSeq: 9, data: { seq: 9, time: 9000, content: [{ type: 'text', text: 'st' }] } }]]),
      new Set(),
    )
    expect(targets).toHaveLength(1)
    const target = targets[0]!
    expect(target.kind).toBe('durable')
    if (target.kind === 'durable') {
      expect(target.seq).toBe(9)
      expect(target.container).toBe(actions)
    }
  })

  it('refuses a row whose actions container has no <button> (layout mismatch)', () => {
    addRow('user', 'm3', false)
    const targets = collectTargets(chatWith([['m3', userNode(6)]]), new Set())
    expect(targets).toHaveLength(0)
  })

  it('skips a withdrawn row (anchor seq already hidden)', () => {
    addRow('user', 'm4')
    const targets = collectTargets(chatWith([['m4', userNode(7)]]), new Set([7]))
    expect(targets).toHaveLength(0)
  })

  it('collects nothing when a chat node has no matching DOM row', () => {
    const targets = collectTargets(chatWith([['m5', userNode(8)]]), new Set())
    expect(targets).toHaveLength(0)
  })
})
