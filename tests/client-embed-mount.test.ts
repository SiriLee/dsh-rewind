/**
 * @vitest-environment jsdom
 *
 * DOM probe for the embedded-Conversation mount
 * (`embeddedSessionIds` in `client/portals.tsx`).
 *
 * A Conversation rendered outside the main frame renders no
 * `conversation.session.header.actions`, so the header bridge never mounts
 * there and its user rows carry no ↶ button. The embedded bridge finds those
 * Conversations by the harness-readable `data-conversation-content` +
 * `data-conversation-session` attributes and mounts one portal set per session.
 * These cases pin the discovery rules that keep the two mounts from colliding:
 *
 *  - the main view's frame (`data-phase`) is never claimed twice;
 *  - one session yields one mount, however many bodies carry it;
 *  - a body without a session (hero/blank) is skipped;
 *  - an attribute rename degrades to "no embedded sessions", never a throw.
 *
 * Compilation: typechecked by `tsconfig.client-test.json` (client surface +
 * JSX), excluded from `tsconfig.json` (host, no JSX).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { embeddedSessionIds } from '../src/client/portals.tsx'

/** Append a Conversation body the way the harness marks one. */
function addConversation(sessionId: string | null, opts: { inMainFrame?: boolean } = {}): HTMLElement {
  const { inMainFrame = false } = opts
  const body = document.createElement('div')
  body.dataset.conversationContent = ''
  if (sessionId !== null) body.dataset.conversationSession = sessionId
  if (inMainFrame) {
    // The main view's frame owns an ancestor carrying `data-phase`; the header
    // bridge already covers that Conversation.
    const frame = document.createElement('div')
    frame.setAttribute('data-phase', 'active')
    frame.appendChild(body)
    document.body.appendChild(frame)
    return body
  }
  document.body.appendChild(body)
  return body
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('embeddedSessionIds', () => {
  it('reports an embedded Conversation by its session', () => {
    addConversation('session-a')
    expect(embeddedSessionIds()).toEqual(['session-a'])
  })

  it('never claims the main view, which the header bridge already covers', () => {
    addConversation('session-main', { inMainFrame: true })
    expect(embeddedSessionIds()).toEqual([])
  })

  it('reports the embedded one and drops the main view when both are open', () => {
    addConversation('session-main', { inMainFrame: true })
    addConversation('session-embed')
    expect(embeddedSessionIds()).toEqual(['session-embed'])
  })

  it('de-duplicates a session carried by more than one body', () => {
    addConversation('session-a')
    addConversation('session-a')
    expect(embeddedSessionIds()).toEqual(['session-a'])
  })

  it('keeps document order across distinct sessions', () => {
    addConversation('session-a')
    addConversation('session-b')
    expect(embeddedSessionIds()).toEqual(['session-a', 'session-b'])
  })

  it('skips a body with no session (hero / blank Conversation)', () => {
    addConversation(null)
    addConversation('session-a')
    expect(embeddedSessionIds()).toEqual(['session-a'])
  })

  it('reports nothing when no embed is mounted', () => {
    expect(embeddedSessionIds()).toEqual([])
  })

  it('degrades to an empty list when the harness renames the attributes', () => {
    // A Conversation rendered without the readable markers: the bridge must find
    // nothing rather than throw, leaving the header path untouched.
    const bare = document.createElement('div')
    bare.textContent = 'conversation without markers'
    document.body.appendChild(bare)
    expect(embeddedSessionIds()).toEqual([])
  })
})
