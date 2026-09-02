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
import { actionsContainerOf, collectTargets } from '../src/client/portals.tsx'
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

/** Append a user/steering row whose actions-root last child is an actions
 * container with a `<button>` — the shape the collector accepts. The wrapper
 * attribute is dual-channel: DSH ≤ 0.1.1-rc.x used `data-time-hover-root`,
 * 0.1.2-alpha.2+ uses `data-actions-reveal`. */
function addRow(kind: string, key: string, withButton = true, actionsRootAttr = 'data-time-hover-root'): HTMLElement {
  const row = document.createElement('div')
  row.dataset.chatFlowKind = kind
  row.dataset.chatAnchorKey = key
  const root = document.createElement('div')
  root.setAttribute(actionsRootAttr, '')
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

/** alpha.4 (0.1.2-alpha.4) seat shape: the user row carries NO
 * `data-actions-reveal` / `data-time-hover-root` marker (that marker now lives
 * only on the per-turn tail footer, `TurnTailNodeView`); the actions container
 * is the LAST child of the message row and directly holds the copy `<button>`.
 * `pending` marks the row `data-pending-steering` for the pending collector. */
function addRowAlpha4(kind: string, key: string, opts: { withButton?: boolean; pending?: boolean } = {}): HTMLElement {
  const { withButton = true, pending = false } = opts
  const row = document.createElement('div')
  row.dataset.chatFlowKind = kind
  row.dataset.chatAnchorKey = key
  const userRow = document.createElement('div')
  if (pending) userRow.dataset.pendingSteering = ''
  const bubble = document.createElement('div')
  bubble.textContent = 'bubble'
  const actions = document.createElement('div')
  actions.className = 'actions'
  if (withButton) {
    const button = document.createElement('button')
    button.textContent = 'Copy'
    actions.appendChild(button)
  }
  userRow.append(bubble, actions)
  row.appendChild(userRow)
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

  it('collects a durable target on the 0.1.2-alpha.2 data-actions-reveal root', () => {
    const actions = addRow('user', 'm6', true, 'data-actions-reveal')
    const targets = collectTargets(chatWith([['m6', userNode(11)]]), new Set())
    expect(targets).toHaveLength(1)
    expect(targets[0]).toEqual({
      kind: 'durable',
      key: 'm6',
      container: actions,
      seq: 11,
      time: 11000,
      preview: 'msg 11',
    })
  })

  it('refuses an alpha.2 row whose actions container has no <button> (layout mismatch)', () => {
    addRow('user', 'm7', false, 'data-actions-reveal')
    const targets = collectTargets(chatWith([['m7', userNode(12)]]), new Set())
    expect(targets).toHaveLength(0)
  })

  it('collects a durable target on the alpha.4 structural row (no actions-reveal marker)', () => {
    const actions = addRowAlpha4('user', 'a1')
    const targets = collectTargets(chatWith([['a1', userNode(21)]]), new Set())
    expect(targets).toHaveLength(1)
    expect(targets[0]).toEqual({
      kind: 'durable',
      key: 'a1',
      container: actions,
      seq: 21,
      time: 21000,
      preview: 'msg 21',
    })
  })

  it('collects an alpha.4 steering row via the structural fallback', () => {
    const actions = addRowAlpha4('steering', 'a2')
    const targets = collectTargets(
      chatWith([['a2', { kind: 'steering', anchorSeq: 23, data: { seq: 23, time: 23000, content: [{ type: 'text', text: 'st' }] } }]]),
      new Set(),
    )
    expect(targets).toHaveLength(1)
    const target = targets[0]!
    expect(target.kind).toBe('durable')
    if (target.kind === 'durable') {
      expect(target.seq).toBe(23)
      expect(target.container).toBe(actions)
    }
  })

  it('refuses an alpha.4 row whose actions container has no <button> (layout mismatch)', () => {
    addRowAlpha4('user', 'a3', { withButton: false })
    const targets = collectTargets(chatWith([['a3', userNode(24)]]), new Set())
    expect(targets).toHaveLength(0)
  })
})

describe('actionsContainerOf (dual-channel finder: rc.2 attribute → alpha.4 structural)', () => {
  it('finds the actions container on an rc.2 data-time-hover-root row', () => {
    const actions = addRow('user', 'r1')
    expect(actionsContainerOf(document.querySelector('[data-chat-anchor-key="r1"]')!)).toBe(actions)
  })

  it('finds the actions container on an alpha.2 data-actions-reveal row', () => {
    const actions = addRow('user', 'r2', true, 'data-actions-reveal')
    expect(actionsContainerOf(document.querySelector('[data-chat-anchor-key="r2"]')!)).toBe(actions)
  })

  it('finds the actions container on an alpha.4 row via the copy-button parent (no marker)', () => {
    const actions = addRowAlpha4('user', 'a4')
    expect(actionsContainerOf(document.querySelector('[data-chat-anchor-key="a4"]')!)).toBe(actions)
  })

  it('finds the actions container on an alpha.4 pending row (last child = actions, no marker)', () => {
    const actions = addRowAlpha4('user', 'a5', { pending: true })
    const pendingRow = document.querySelector('[data-pending-steering]')!
    expect(pendingRow).toBeInstanceOf(HTMLElement)
    expect(actionsContainerOf(pendingRow as HTMLElement)).toBe(actions)
  })

  it('returns undefined when the row exposes no qualifying container', () => {
    const row = document.createElement('div')
    document.body.appendChild(row)
    expect(actionsContainerOf(row)).toBeUndefined()
  })
})
