/**
 * @vitest-environment jsdom
 *
 * DOM-level probe for the rewind button path (SiriLee/dsh-rewind#7). The
 * chat-channel fix reroutes the chat snapshot through `chatSnapshotOf`; these
 * cases pin the DOM→targets pairing (`collectTargets`) that turns a session's
 * chat nodes × action rows into the per-message ↶ portal targets — the one
 * piece the pure-function suites (`chat-channel`, `hidden`) do not reach.
 *
 * On the target line `actionsContainerOf` locates the actions container
 * structurally (the copy `<button>`'s own container), so the row shapes below
 * carry no `data-time-hover-root` marker.
 *
 * Compilation: typechecked by `tsconfig.client-test.json` (client surface +
 * JSX), excluded from `tsconfig.json` (host, no JSX) — see the neighbouring
 * `client-contract.test.ts` comment.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { ChatConversationViewNode } from '../src/client/hidden.ts'
import {
  actionsContainerOf, collectDurableTargets, collectTargets, hideWithdrawnSeats, isRewindInertSession,
  resolveSeatAnchorSeq,
} from '../src/client/portals.tsx'
import { hiddenSeqsOf, type HiddenChat } from '../src/client/hidden.ts'

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

/** Append a user/steering row whose LAST child is the actions container holding
 * the copy `<button>` — the structural shape the collector accepts. */
function addRow(kind: string, key: string, opts: { withButton?: boolean } = {}): HTMLElement {
  const { withButton = true } = opts
  const row = document.createElement('div')
  row.dataset.chatFlowKind = kind
  row.dataset.chatAnchorKey = key
  const bubble = document.createElement('div')
  bubble.textContent = 'bubble'
  const actions = document.createElement('div')
  actions.className = 'actions'
  if (withButton) {
    const button = document.createElement('button')
    button.textContent = 'Copy'
    actions.appendChild(button)
  }
  row.append(bubble, actions)
  document.body.appendChild(row)
  return actions
}

/** Append a pending steering row: the row itself carries `[data-pending-steering]`
 * and its LAST child is the actions container holding the copy `<button>`. */
function addPendingRow(key: string, withButton = true): HTMLElement {
  const row = document.createElement('div')
  row.dataset.pendingSteering = ''
  const bubble = document.createElement('div')
  bubble.textContent = 'bubble'
  const actions = document.createElement('div')
  actions.className = 'actions'
  if (withButton) {
    const button = document.createElement('button')
    button.textContent = 'Copy'
    actions.appendChild(button)
  }
  row.append(bubble, actions)
  document.body.appendChild(row)
  return actions
}

/** IMAGE seat shape: the media gallery mounts the thumbnail as a `<button>`
 * (MessageImage's `.frame`, ui-attachment) and sits in `.userStack` BEFORE
 * `.actions` in document order. The old "first <button> in the row" heuristic
 * portaled the ↶ button into the gallery; the actions container must still be
 * located by the LAST button-bearing element. */
function addRowImage(kind: string, key: string, opts: { ownButtonInActions?: boolean } = {}): HTMLElement {
  const { ownButtonInActions = false } = opts
  const row = document.createElement('div')
  row.dataset.chatFlowKind = kind
  row.dataset.chatAnchorKey = key
  const userRow = document.createElement('div')
  const userStack = document.createElement('div')
  const gallery = document.createElement('div')
  const frame = document.createElement('button')
  frame.textContent = 'image'
  gallery.appendChild(frame)
  const bubble = document.createElement('div')
  bubble.textContent = 'bubble'
  userStack.append(gallery, bubble)
  const actions = document.createElement('div')
  actions.className = 'actions'
  const copy = document.createElement('button')
  copy.textContent = 'Copy'
  actions.appendChild(copy)
  if (ownButtonInActions) {
    const own = document.createElement('button')
    own.className = 'dsh-rewind-btn'
    actions.appendChild(own)
  }
  userRow.append(userStack, actions)
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
    addRow('user', 'm3', { withButton: false })
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

describe('collectDurableTargets (subagent sessions are rewind-inert)', () => {
  it('classifies the session kind from the snapshot subagent cell', () => {
    expect(isRewindInertSession({ subagent: null })).toBe(false)
    expect(isRewindInertSession({ subagent: { address: { mode: 'continuable' } } })).toBe(true)
  })

  it('collects the plain-session targets', () => {
    addRow('user', 's1')
    const targets = collectDurableTargets({ subagent: null }, chatWith([['s1', userNode(11)]]), new Set())
    expect(targets).toHaveLength(1)
  })

  it('collects nothing for a subagent session, same DOM and chat as the positive case', () => {
    addRow('user', 's2')
    const chat = chatWith([['s2', userNode(12)]])
    // Discriminating: identical chat snapshot and identical rendered row; only
    // the session kind differs, and the subagent one must yield no button.
    expect(collectDurableTargets({ subagent: { address: { mode: 'continuable' } } }, chat, new Set())).toHaveLength(0)
    expect(collectDurableTargets({ subagent: null }, chat, new Set())).toHaveLength(1)
  })

  it('collects nothing while the chat view is unavailable', () => {
    addRow('user', 's3')
    expect(collectDurableTargets({ subagent: null }, undefined, new Set())).toHaveLength(0)
  })
})

describe('actionsContainerOf (structural finder)', () => {
  it('finds the actions container on a plain user row', () => {
    const actions = addRow('user', 'a1')
    expect(actionsContainerOf(document.querySelector('[data-chat-anchor-key="a1"]')!)).toBe(actions)
  })

  it('finds the actions container on a pending steering row', () => {
    const actions = addPendingRow('p1')
    const pendingRow = document.querySelector('[data-pending-steering]')!
    expect(pendingRow).toBeInstanceOf(HTMLElement)
    expect(actionsContainerOf(pendingRow as HTMLElement)).toBe(actions)
  })

  it('locates the actions container, NOT the media gallery, on an image row', () => {
    // The thumbnail `<button>` in `.gallery` precedes `.actions`; the finder
    // must skip it and land on the copy button's container (dsh-rewind#7 image
    // regression: the ↶ button was pinned at the image's top-right).
    const actions = addRowImage('user', 'img1')
    expect(actionsContainerOf(document.querySelector('[data-chat-anchor-key="img1"]')!)).toBe(actions)
  })

  it('still locates the actions container when this plugin own button is already portaled there', () => {
    const actions = addRowImage('user', 'img2', { ownButtonInActions: true })
    expect(actionsContainerOf(document.querySelector('[data-chat-anchor-key="img2"]')!)).toBe(actions)
  })

  it('returns undefined when the row exposes no qualifying container', () => {
    const row = document.createElement('div')
    document.body.appendChild(row)
    expect(actionsContainerOf(row)).toBeUndefined()
  })
})

describe('resolveSeatAnchorSeq (withdrawn-seat hiding)', () => {
  /** One assistant-message node (the seat the reasoning itself renders as). */
  const assistantNode = (seq: number) => ({
    kind: 'assistant',
    anchorSeq: seq,
    data: { turn: 1, step: 1, seq, content: [{ type: 'reasoning', text: 'thinking' }] },
  })

  /** A rewind marker node: the command carrying the cut, as the host logs it. */
  const markerCommand = (seq: number, target: number) => ({
    kind: 'command',
    anchorSeq: seq,
    data: { name: 'rewind', seq, args: `@${target} chat`, outcome: { kind: 'success', sourceEventSeq: seq } },
  })

  it('resolves a process seat through its composite anchor key', () => {
    // A step/process row renders with `data-chat-anchor-key` = ["<key>","<part>"]
    // and `data-chat-node-key` = the plain key. Reading only the flow key left
    // every such row unresolvable, so a withdrawn one survived the rewind.
    const chat = chatWith([['n1', assistantNode(7)]])
    const processed = document.createElement('div')
    processed.dataset.chatAnchorKey = JSON.stringify(['n1', 'process'])
    processed.dataset.chatNodeKey = 'n1'
    document.body.appendChild(processed)

    expect(chat.nodes.get(processed.dataset.chatAnchorKey)).toBeUndefined()
    expect(resolveSeatAnchorSeq(processed, chat)).toBe(7)
  })

  /** One step/process group shell in the shape the official ChatGroupSeat renders. */
  function appendShell(members: HTMLElement[]): HTMLElement {
    const shell = document.createElement('div')
    shell.dataset.chatAnchorKey = `group:${JSON.stringify(['process', 'a1', 'reasoning'])}`
    shell.dataset.chatTurn = '1'
    const body = document.createElement('div')
    for (const member of members) body.appendChild(member)
    shell.appendChild(body)
    document.body.appendChild(shell)
    return shell
  }

  /** A process member seat: composite flow key, plain node key. */
  function appendMember(nodeKey: string, part: string): HTMLElement {
    const seat = document.createElement('div')
    seat.dataset.chatAnchorKey = JSON.stringify([nodeKey, part])
    seat.dataset.chatNodeKey = nodeKey
    document.body.appendChild(seat)
    return seat
  }

  it('hides the withdrawn reasoning rows a rewind cut', () => {
    // End-to-end over the real hiding pass: the hidden set the marker produces,
    // the seat → anchorSeq resolution, and the DOM mutation itself.
    const chat = chatWith([
      ['u1', userNode(5)],
      ['a1', assistantNode(6)],
      ['m1', markerCommand(9, 5)],
    ])
    const hiddenSeqs = hiddenSeqsOf(chat)
    expect(hiddenSeqs).toEqual(new Set([5, 6, 9]))
    const userSeat = document.createElement('div')
    userSeat.dataset.chatAnchorKey = 'u1'
    document.body.appendChild(userSeat)
    const processSeat = appendMember('a1', 'reasoning')

    hideWithdrawnSeats(chat, document.querySelectorAll('[data-chat-anchor-key]'), hiddenSeqs, new WeakSet())

    expect(userSeat.style.display).toBe('none')
    // The pre-fix behaviour: a composite-key seat resolved to undefined and
    // stayed visible even though its node was withdrawn.
    expect(processSeat.style.display).toBe('none')
  })

  it('hides the group shell once every member is withdrawn', () => {
    // A fully withdrawn "analysis completed" group: its members hide, and the
    // shell around them has to go too, or it stays as an empty expandable row.
    const chat = chatWith([
      ['u1', userNode(5)],
      ['a1', assistantNode(6)],
      ['m1', markerCommand(9, 5)],
    ])
    const shell = appendShell([appendMember('a1', 'reasoning')])

    hideWithdrawnSeats(chat, document.querySelectorAll('[data-chat-anchor-key]'), hiddenSeqsOf(chat), new WeakSet())

    expect(shell.style.display).toBe('none')
    expect(shell.dataset.dshRewindHidden).toBe('true')
  })

  it('leaves a group shell alone when the batch carries no member of it', () => {
    // Conservative by design: a shell whose members are not in this batch cannot
    // be judged, and hiding it could take live content off screen. The measured
    // residue always renders its member seat, so only observed members decide.
    const chat = chatWith([['u1', userNode(5)], ['m1', markerCommand(9, 5)]])
    const shell = appendShell([])

    hideWithdrawnSeats(chat, document.querySelectorAll('[data-chat-anchor-key]'), hiddenSeqsOf(chat), new WeakSet())

    expect(shell.style.display).toBe('')
    expect(shell.dataset.dshRewindHidden).toBeUndefined()
  })

  it('keeps a group shell that still holds a member on the surface', () => {
    // The group's first member was withdrawn by the rewind; a later one is still
    // on the surface, so the shell must keep rendering it.
    const chat = chatWith([
      ['u1', userNode(5)],
      ['a1', assistantNode(6)],
      ['a2', assistantNode(12)],
      ['m1', markerCommand(9, 5)],
    ])
    const shell = appendShell([
      appendMember('a1', 'reasoning'),
      appendMember('a2', 'reasoning'),
    ])

    hideWithdrawnSeats(chat, document.querySelectorAll('[data-chat-anchor-key]'), hiddenSeqsOf(chat), new WeakSet())

    expect(shell.style.display).toBe('')
    expect(shell.dataset.dshRewindHidden).toBeUndefined()
  })

  it('shows a hidden shell again when its member is no longer withdrawn', () => {
    // The shell pass owns the shell in BOTH directions: hiding it when the last
    // member goes cannot make it impossible to show again when a member returns.
    const chat = chatWith([['a1', assistantNode(6)]])
    const shell = appendShell([appendMember('a1', 'reasoning')])
    const hidden = new WeakSet<HTMLElement>()

    hideWithdrawnSeats(chat, document.querySelectorAll('[data-chat-anchor-key]'), new Set([6]), hidden)
    expect(shell.style.display).toBe('none')
    expect(shell.dataset.dshRewindHidden).toBe('true')

    // The withdrawn span shrinks: the member is live again, so the shell it
    // emptied has to come back.
    hideWithdrawnSeats(chat, document.querySelectorAll('[data-chat-anchor-key]'), new Set(), hidden)
    expect(shell.style.display).toBe('')
    expect(shell.dataset.dshRewindHidden).toBeUndefined()
  })

  it('never lets the seat pass un-hide a shell the shell pass hid', () => {
    // Two passes over an unchanged all-withdrawn batch: the shell must end
    // hidden and no pass may write `display` back to ''. That write is what the
    // refresh's own MutationObserver (`style` on document.body) saw, which
    // re-entered refresh as a microtask and froze the renderer.
    const chat = chatWith([['a1', assistantNode(6)]])
    const shell = appendShell([appendMember('a1', 'reasoning')])
    const hidden = new WeakSet<HTMLElement>()
    const seats = document.querySelectorAll<HTMLElement>('[data-chat-anchor-key]')

    hideWithdrawnSeats(chat, seats, new Set([6]), hidden)
    const writes: string[] = []
    const spy = new Proxy(shell.style, {
      set: (target, prop, value: unknown) => {
        writes.push(`${String(prop)}=${String(value)}`)
        return Reflect.set(target, prop, value)
      },
    })
    Object.defineProperty(shell, 'style', { value: spy, configurable: true })
    hideWithdrawnSeats(chat, seats, new Set([6]), hidden)

    expect(shell.style.display).toBe('none')
    // A same-value `display = 'none'` write produces no mutation record, so it
    // cannot re-enter refresh; a write back to '' would.
    expect(writes.some(write => write === 'display=')).toBe(false)
  })
})

