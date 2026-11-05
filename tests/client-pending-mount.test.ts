/**
 * @vitest-environment jsdom
 *
 * Pending-retract layer probes (`pending-mount.tsx`). The layer is the plugin's
 * one DOM path: an unclaimed steering bubble has no slot entry, so the retract
 * button is portaled into the bubble's actions row. These cases pin the two
 * contracts that matter — the inbox gate (no observer, no query and no button
 * while nothing is pending) and the render-time matching (wrong row → no button,
 * other session → untouched) — plus the click → confirm → queue-removal wiring.
 *
 * The observer is a fake: it lets a case drive one mutation batch synchronously
 * and assert the marker filter, instead of racing jsdom's real delivery.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { SessionFace } from '@deepseek-ai/dsh-api-session-controller/client'

// jsdom + React act: the environment must opt in so act() does not warn.
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { createPendingBridge } from '../src/client/pending-mount.tsx'
import type { InboxMessageLike } from '../src/client/pending.ts'
import { CLASS } from '../src/client/styles.ts'

const PENDING = '[data-pending-steering]'
const CONTENT = '[data-conversation-session]'

/** One fake mutation observer, created by the layer. */
interface FakeObserver {
  readonly cb: MutationCallback
  readonly observe: ReturnType<typeof vi.fn>
  readonly disconnect: ReturnType<typeof vi.fn>
}

/** Replace the global observer with a recording fake; returns the created list. */
function fakeObservers(): FakeObserver[] {
  const created: FakeObserver[] = []
  class Fake {
    readonly observe = vi.fn()
    readonly disconnect = vi.fn()
    constructor(readonly cb: MutationCallback) {
      created.push(this as unknown as FakeObserver)
    }
  }
  vi.stubGlobal('MutationObserver', Fake)
  return created
}

/** One user-sourced steering inbox row. */
function steeringRow(id: string, text: string): InboxMessageLike {
  return { id, source: { kind: 'user' }, content: [{ type: 'text', text }] }
}

/** A fake session exposing the inbox projection face the layer subscribes to. */
function fakeSession(options: { readonly nextStep?: readonly InboxMessageLike[]; readonly subagent?: unknown } = {}) {
  let value = { 'next-turn': [] as readonly InboxMessageLike[], 'next-step': options.nextStep ?? [] }
  const listeners = new Set<() => void>()
  const face = {
    getSnapshot: () => value,
    subscribe: (cb: () => void) => {
      listeners.add(cb)
      return () => { listeners.delete(cb) }
    },
  }
  const updateQueue = vi.fn(async (_id: string, _action: unknown) => ({ ok: true as const, value: { accepted: true as const } }))
  const session = {
    sessionId: 's1',
    getSnapshot: () => ({ subagent: options.subagent ?? null }),
    projections: { faceOf: (key: string) => (key === 'inbox' ? face : { getSnapshot: () => undefined }) },
    updateQueue,
  } as unknown as SessionFace
  return {
    session,
    updateQueue,
    /** One accepted Host frame: new value + invalidation, no DOM touch. */
    acceptInbox(rows: readonly InboxMessageLike[]) {
      value = { 'next-turn': [], 'next-step': rows }
      for (const cb of [...listeners]) cb()
    },
  }
}

/** The session's content region the layer scans and observes. */
function contentRoot(sessionId = 's1'): HTMLElement {
  const root = document.createElement('div')
  root.setAttribute('data-conversation-session', sessionId)
  document.body.append(root)
  return root
}

/** One rendered pending steering bubble: content text, then the Copy action row. */
function pendingBubble(text: string, options: { readonly attachments?: number; readonly actions?: boolean; readonly attachmentButtons?: boolean } = {}): HTMLElement {
  const row = document.createElement('div')
  row.setAttribute('data-pending-steering', '')
  const content = document.createElement('div')
  content.textContent = text
  for (let index = 0; index < (options.attachments ?? 0); index++) {
    const block = document.createElement('div')
    block.setAttribute('data-message-attachments', '')
    block.textContent = 'attachment'
    if (options.attachmentButtons === true) {
      // An image thumbnail renders as a `<button>` inside the attachment block,
      // before the actions row (MessageImage's frame).
      const thumbnail = document.createElement('button')
      thumbnail.type = 'button'
      thumbnail.textContent = 'image'
      block.append(thumbnail)
    }
    row.append(block)
  }
  row.append(content)
  if (options.actions !== false) {
    const actions = document.createElement('div')
    actions.setAttribute('data-actions', '')
    const copy = document.createElement('button')
    copy.type = 'button'
    copy.textContent = 'copy'
    actions.append(copy)
    row.append(actions)
  }
  return row
}

/** The layer deps over one fake session. */
function depsFor(session: SessionFace) {
  return {
    sessionOf: () => session,
    setComposerText: vi.fn(() => true),
    restoreImages: vi.fn(async () => {}),
    t: (key: string) => key,
    subscribeLocale: () => () => {},
  }
}

/** An empty composer, so the retract refill's empty-draft guard passes. */
function composer(): void {
  const editable = document.createElement('div')
  editable.setAttribute('data-composer-input', '')
  document.body.append(editable)
}

/** Render the bridge for one session and return its container + root. */
async function mountBridge(session: SessionFace) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const Bridge = createPendingBridge(depsFor(session))
  await act(async () => { root.render(createElement(Bridge, { sessionId: 's1' })) })
  return { root, container }
}

/** Count the layer's pending queries on one root (the observer-driven refresh). */
function countPendingQueries(root: HTMLElement): () => number {
  const spy = vi.spyOn(root, 'querySelectorAll')
  return () => spy.mock.calls.filter(([selector]) => selector === PENDING).length
}

/** Drive one fake observer batch and flush the coalesced refresh. */
async function mutate(observer: FakeObserver | undefined, record: MutationRecord): Promise<void> {
  act(() => { observer?.cb([record], {} as MutationObserver) })
  await act(async () => { await Promise.resolve() })
}

/** A synthetic childList record (only the fields the marker filter reads). */
function record(target: Node, added: Node[] = [], removed: Node[] = []): MutationRecord {
  return { target, addedNodes: added, removedNodes: removed } as unknown as MutationRecord
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('pending layer (the inbox gate)', () => {
  it('installs no observer and runs no query while nothing is pending', async () => {
    const observers = fakeObservers()
    const roots = vi.spyOn(document, 'querySelectorAll')
    const inbox = fakeSession()
    await mountBridge(inbox.session)
    expect(observers).toHaveLength(0)
    expect(roots.mock.calls.filter(([selector]) => selector === CONTENT)).toHaveLength(0)
    expect(document.querySelectorAll(`[${'data-pending-retract'}]`)).toHaveLength(0)
  })

  it('portals the button once the inbox holds the steering row', async () => {
    const inbox = fakeSession()
    await mountBridge(inbox.session)
    const root = contentRoot()
    const bubble = pendingBubble('hello there')
    root.append(bubble)
    inbox.acceptInbox([steeringRow('a', 'hello there')])
    await act(async () => { await Promise.resolve() })
    const button = bubble.querySelector<HTMLButtonElement>('button[data-pending-retract]')
    expect(button).not.toBeNull()
    expect(button?.getAttribute('aria-label')).toBe('button.retract.aria')
    expect(button?.closest('[data-actions]')).not.toBeNull()
  })

  it('attaches the button to a bubble mounted after the gate opened', async () => {
    const observers = fakeObservers()
    const inbox = fakeSession()
    await mountBridge(inbox.session)
    const root = contentRoot()
    inbox.acceptInbox([steeringRow('a', 'later')])
    await act(async () => { await Promise.resolve() })
    expect(observers).toHaveLength(1)

    const bubble = pendingBubble('later')
    root.append(bubble)
    await mutate(observers[0], record(root, [bubble]))
    expect(bubble.querySelector('button[data-pending-retract]')).not.toBeNull()
  })

  it('ignores a mutation batch without a pending bubble', async () => {
    const observers = fakeObservers()
    const inbox = fakeSession()
    await mountBridge(inbox.session)
    const root = contentRoot()
    const bubble = pendingBubble('streaming neighbor')
    root.append(bubble)
    inbox.acceptInbox([steeringRow('a', 'streaming neighbor')])
    await act(async () => { await Promise.resolve() })
    const pendingQueries = countPendingQueries(root)
    const before = pendingQueries()

    // Assistant streaming (a plain node added to the same content region).
    await mutate(observers[0], record(root, [document.createElement('span')]))
    expect(pendingQueries()).toBe(before)
  })

  it('removes the button and disconnects once the inbox is empty', async () => {
    const observers = fakeObservers()
    const inbox = fakeSession()
    await mountBridge(inbox.session)
    const root = contentRoot()
    const bubble = pendingBubble('claimed soon')
    root.append(bubble)
    inbox.acceptInbox([steeringRow('a', 'claimed soon')])
    await act(async () => { await Promise.resolve() })
    expect(bubble.querySelector('button[data-pending-retract]')).not.toBeNull()

    inbox.acceptInbox([])
    await act(async () => { await Promise.resolve() })
    expect(bubble.querySelector('button[data-pending-retract]')).toBeNull()
    expect(observers[0]?.disconnect).toHaveBeenCalled()
  })

  it('closes the gate for a rewind-inert (subagent) session', async () => {
    const observers = fakeObservers()
    const inbox = fakeSession({ nextStep: [steeringRow('a', 'child input')], subagent: { address: { mode: 'continuable' } } })
    await mountBridge(inbox.session)
    const root = contentRoot()
    root.append(pendingBubble('child input'))
    await act(async () => { await Promise.resolve() })
    expect(observers).toHaveLength(0)
    expect(root.querySelector('button[data-pending-retract]')).toBeNull()
  })
})

describe('pending layer (matching and scope)', () => {
  it('leaves a bubble unmatched by text or attachment count without a button', async () => {
    const inbox = fakeSession()
    await mountBridge(inbox.session)
    const root = contentRoot()
    const textMismatch = pendingBubble('edited text')
    // The item carries two non-text blocks; the rendered row three.
    const attachmentMismatch = pendingBubble('with attachments', { attachments: 3 })
    root.append(textMismatch, attachmentMismatch)
    inbox.acceptInbox([
      steeringRow('a', 'original text'),
      { id: 'b', source: { kind: 'user' }, content: [{ type: 'text', text: 'with attachments' }, { type: 'image' }, { type: 'file' }] },
    ])
    await act(async () => { await Promise.resolve() })
    expect(textMismatch.querySelector('button[data-pending-retract]')).toBeNull()
    expect(attachmentMismatch.querySelector('button[data-pending-retract]')).toBeNull()
  })

  it('pairs an attachment-bearing bubble by count', async () => {
    const inbox = fakeSession()
    await mountBridge(inbox.session)
    const root = contentRoot()
    const bubble = pendingBubble('look at this', { attachments: 2 })
    root.append(bubble)
    inbox.acceptInbox([{ id: 'img', source: { kind: 'user' }, content: [{ type: 'text', text: 'look at this' }, { type: 'image' }, { type: 'file' }] }])
    await act(async () => { await Promise.resolve() })
    expect(bubble.querySelector('button[data-pending-retract]')).not.toBeNull()
  })

  it('never touches another session\'s content region', async () => {
    const inbox = fakeSession()
    await mountBridge(inbox.session)
    const mine = contentRoot('s1')
    const other = contentRoot('s2')
    const myBubble = pendingBubble('mine')
    const otherBubble = pendingBubble('mine')
    mine.append(myBubble)
    other.append(otherBubble)
    inbox.acceptInbox([steeringRow('a', 'mine')])
    await act(async () => { await Promise.resolve() })
    expect(myBubble.querySelector('button[data-pending-retract]')).not.toBeNull()
    expect(otherBubble.querySelector('button[data-pending-retract]')).toBeNull()
  })

  it('targets the actions row, not an attachment thumbnail, when the bubble shows an image', async () => {
    const inbox = fakeSession()
    await mountBridge(inbox.session)
    const root = contentRoot()
    const bubble = pendingBubble('look', { attachments: 1, attachmentButtons: true })
    root.append(bubble)
    inbox.acceptInbox([
      { id: 'img', source: { kind: 'user' }, content: [{ type: 'text', text: 'look' }, { type: 'image' }] },
    ])
    await act(async () => { await Promise.resolve() })

    const actions = bubble.querySelector('[data-actions]')!
    expect([...actions.children].some(child => child.matches('button[data-pending-retract]'))).toBe(true)
    expect(bubble.querySelector('[data-message-attachments] button[data-pending-retract]')).toBeNull()
  })

  it('keeps targeting the actions row when its own button is already there', async () => {
    const inbox = fakeSession()
    await mountBridge(inbox.session)
    const root = contentRoot()
    const bubble = pendingBubble('again')
    // A previously portaled button, wrapped: the finder must skip it instead of
    // re-targeting its wrapper on the next refresh.
    const wrapper = document.createElement('span')
    const own = document.createElement('button')
    own.setAttribute('data-pending-retract', '')
    wrapper.append(own)
    bubble.querySelector('[data-actions]')!.append(wrapper)
    root.append(bubble)
    inbox.acceptInbox([steeringRow('a', 'again')])
    await act(async () => { await Promise.resolve() })

    const actions = bubble.querySelector('[data-actions]')!
    expect([...actions.children].some(child => child.matches('button[data-pending-retract]'))).toBe(true)
    expect(wrapper.children).toHaveLength(1)
  })

  it('refuses a bubble without an actions row', async () => {
    const inbox = fakeSession()
    await mountBridge(inbox.session)
    const root = contentRoot()
    const bubble = pendingBubble('no actions', { actions: false })
    root.append(bubble)
    inbox.acceptInbox([steeringRow('a', 'no actions')])
    await act(async () => { await Promise.resolve() })
    expect(bubble.querySelector('button[data-pending-retract]')).toBeNull()
  })
})

describe('pending layer (click → confirm → queue removal)', () => {
  it('opens the retract dialog and removes the target on confirm', async () => {
    composer()
    const inbox = fakeSession()
    const deps = depsFor(inbox.session)
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const Bridge = createPendingBridge(deps)
    await act(async () => { root.render(createElement(Bridge, { sessionId: 's1' })) })
    const region = contentRoot()
    const bubble = pendingBubble('rewrite me')
    region.append(bubble)
    inbox.acceptInbox([steeringRow('a', 'rewrite me')])
    await act(async () => { await Promise.resolve() })

    const button = bubble.querySelector<HTMLButtonElement>('button[data-pending-retract]')
    act(() => { button!.click() })
    expect(document.querySelector(`.${CLASS.popover}`)?.getAttribute('aria-label')).toBe('popover.retract.title')

    const confirm = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find(candidate => candidate.textContent === 'popover.confirm')
    await act(async () => {
      confirm?.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(inbox.updateQueue).toHaveBeenCalledTimes(1)
    expect(inbox.updateQueue.mock.calls[0]?.[0]).toBe('a')
    expect(deps.setComposerText).toHaveBeenCalledWith('s1', 'rewrite me')
  })
})
