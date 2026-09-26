/**
 * @vitest-environment jsdom
 *
 * Refresh-trigger probe for the pending (retract) button: its container comes
 * from the DOM row, but its identity (the Host inbox occurrence id) comes from
 * the session's `inbox` projection — which lands without a DOM mutation, because
 * the visible bubble is the harness's local submission echo (see
 * `syncInboxSubscription` in portals.tsx). These cases pin the projection
 * subscription as a refresh trigger on its own, and the DOM observer as the
 * catch-up channel that masked its absence.
 *
 * Compilation: typechecked by `tsconfig.client-test.json` (client surface +
 * JSX), excluded from `tsconfig.json` (host, no JSX) — see the neighbouring
 * `client-contract.test.ts` comment.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { SessionFace } from '@deepseek-ai/dsh-api-session-controller/client'

// jsdom + React act: the environment must opt in so act() does not warn.
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
import { createRewindBridge, type RewindBridgeDeps } from '../src/client/portals.tsx'
import { CLASS } from '../src/client/styles.ts'

/** One `inbox` projection row (only the fields the matcher reads). */
interface Row {
  readonly id: string
  readonly content: readonly { readonly type: string; readonly text?: string }[]
  readonly source?: { readonly kind?: string; readonly rpcId?: string } | undefined
}

/**
 * A fake session whose `inbox` face behaves like the harness's
 * `ProjectionValueStore` face: identity-stable, `getSnapshot` reads the accepted
 * rows, `subscribe` fires per accepted value (synchronously here; the real
 * notifier only batches it into a microtask).
 * @param nextStep - the projection's `next-step` rows (steering).
 */
function fakeSession(nextStep: readonly Row[]) {
  let value = { 'next-turn': [] as readonly Row[], 'next-step': nextStep }
  const listeners = new Set<() => void>()
  const face = {
    getSnapshot: () => value,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  const session = {
    sessionId: 's1',
    getSnapshot: () => ({ subagent: null }),
    projections: {
      faceOf: (key: string) => (key === 'inbox' ? face : { getSnapshot: () => undefined, subscribe: () => () => {} }),
    },
  } as unknown as SessionFace
  return {
    session,
    /** One accepted Host frame: new value + invalidation, no DOM touch. */
    acceptInbox: (rows: readonly Row[]) => {
      value = { 'next-turn': [], 'next-step': rows }
      for (const listener of [...listeners]) listener()
    },
    /** A value change whose invalidation is not delivered (see the hover case). */
    setInboxSilently: (rows: readonly Row[]) => {
      value = { 'next-turn': [], 'next-step': rows }
    },
    subscriberCount: () => listeners.size,
  }
}

/** The bridge deps with every non-pending channel stubbed out. */
function depsFor(session: SessionFace): RewindBridgeDeps {
  return {
    sessionOf: () => session,
    chatOf: () => undefined,
    watchChat: () => () => {},
    isMainViewSession: () => true,
    t: (key: string) => key,
    subscribeLocale: () => () => {},
    setComposerText: () => true,
  }
}

/**
 * Append the harness's pending STEERING row shape: the local submission echo,
 * its `.userStack` bubble, and the actions container as the LAST child (the copy
 * `<button>`'s own container — where the plugin portals into).
 * @param text - the bubble text (must equal the inbox row's text to match).
 */
function addEchoRow(text: string): { readonly row: HTMLElement; readonly actions: HTMLElement } {
  const row = document.createElement('div')
  row.dataset.pendingSteering = ''
  row.dataset.submissionEcho = ''
  const stack = document.createElement('div')
  stack.className = 'userStack'
  const bubble = document.createElement('div')
  bubble.className = 'bubble'
  bubble.textContent = text
  stack.appendChild(bubble)
  const actions = document.createElement('div')
  actions.className = 'actions'
  const copy = document.createElement('button')
  copy.type = 'button'
  copy.setAttribute('aria-label', 'copy')
  actions.appendChild(copy)
  row.append(stack, actions)
  document.body.appendChild(row)
  return { row, actions }
}

/** The tooltip bubble a hover mounts into the actions container (harness Tooltip). */
function tooltipSpan(): HTMLElement {
  const tooltip = document.createElement('span')
  tooltip.setAttribute('role', 'tooltip')
  tooltip.textContent = 'copy'
  return tooltip
}

/** One user-sourced steering occurrence, opened by `requestId` (echo identity). */
const steeringRow = (id: string, text: string): Row => ({
  id,
  source: { kind: 'user', rpcId: 'req-1' },
  content: [{ type: 'text', text }],
})

let root: Root | undefined
let host: HTMLElement | undefined

/** Mount the session-scoped bridge over `document.body`. */
function mount(deps: RewindBridgeDeps): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => { root!.render(createElement(createRewindBridge(deps), { sessionId: 's1' }) as ReactNode) })
}

/** Flush React work plus every pending microtask (observer + coalesced refresh). */
async function settle(): Promise<void> {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}

/** The plugin's own button anywhere in the document. */
const button = (): HTMLElement | null => document.querySelector<HTMLElement>(`.${CLASS.button}`)

afterEach(() => {
  act(() => { root?.unmount() })
  root = undefined
  host?.remove()
  host = undefined
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('pending rewind button refresh triggers', () => {
  it('mounts the retract button when the inbox occurrence arrives without a DOM mutation', async () => {
    const { session, acceptInbox } = fakeSession([])
    const { actions } = addEchoRow('steer one')
    mount(depsFor(session))
    await settle()
    // The echo is on screen, but no occurrence is known yet: no button.
    expect(button()).toBeNull()

    // Host accepts the submission; the DOM does not change.
    act(() => { acceptInbox([steeringRow('occ-1', 'steer one')]) })
    await settle()

    // The button must follow its data, not the DOM.
    expect(actions.querySelector(`.${CLASS.button}`)).not.toBeNull()
  })

  it('withdraws the retract button when the occurrence is claimed without a DOM mutation', async () => {
    const { session, acceptInbox } = fakeSession([steeringRow('occ-1', 'steer one')])
    const { actions } = addEchoRow('steer one')
    mount(depsFor(session))
    await settle()
    expect(actions.querySelector(`.${CLASS.button}`)).not.toBeNull()

    // Claimed at the step boundary: the inbox row is gone while the durable node
    // has not rendered yet (no DOM mutation). A stale button retracts nothing.
    act(() => { acceptInbox([]) })
    await settle()

    expect(button()).toBeNull()
  })

  it('keeps the DOM-mutation path as the catch-up scan (the hover that masked the gap)', async () => {
    const { session, setInboxSilently } = fakeSession([])
    const { actions } = addEchoRow('steer one')
    mount(depsFor(session))
    await settle()
    expect(button()).toBeNull()

    // The occurrence is in the projection but its invalidation was missed (the
    // pre-fix state): the next observed mutation — the tooltip bubble a hover
    // mounts inside the actions container — must still catch the scan up.
    setInboxSilently([steeringRow('occ-1', 'steer one')])
    act(() => { actions.appendChild(tooltipSpan()) })
    await settle()
    expect(actions.querySelector(`.${CLASS.button}`)).not.toBeNull()
  })

  it('subscribes to the session inbox face and releases it on unmount', async () => {
    const { session, subscriberCount } = fakeSession([])
    addEchoRow('steer one')
    mount(depsFor(session))
    await settle()
    expect(subscriberCount()).toBe(1)

    act(() => { root?.unmount() })
    root = undefined
    expect(subscriberCount()).toBe(0)
  })
})
