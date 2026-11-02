/**
 * @vitest-environment jsdom
 *
 * Pending-retract probes (`retractPending` in `portals.tsx`): withdrawing an
 * unread steering message must NOT stop the run (SiriLee/dsh-rewind#27), must
 * remove the target and its steering future through `updateQueue`, and must
 * restore its own images and text only when the target was actually removed.
 * The session face is a hand fake; `session.cancel` is asserted to stay
 * untouched.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionFace } from '@deepseek-ai/dsh-api-session-controller/client'
import { retractPending } from '../src/client/portals.tsx'

/** One inbox image reference (the fields the retract reads). */
interface ImageRef {
  readonly attachmentId: string
  readonly mediaType: string
  readonly bytes: number
  readonly width: number
  readonly height: number
}

/** The inbox projection row shape the retract reads (alpha.2). */
interface Row {
  readonly id: string
  readonly content: readonly { readonly type: string; readonly text?: string; readonly attachment?: ImageRef }[]
  readonly source?: { readonly kind?: string } | undefined
}

/** The `RemoteResult` the client's `updateQueue` resolves with. */
type QueueResult = { readonly ok: true; readonly value: { readonly accepted: true } } | { readonly ok: false; readonly error: { readonly code: string } }

/**
 * Build a fake session exposing the `inbox` projection and counting mutations.
 * @param nextStep - the projection's `next-step` rows (the steering inbox).
 * @param nextTurn - the projection's `next-turn` rows (queued; never retracted).
 */
function fakeSession(nextStep: readonly Row[], nextTurn: readonly Row[] = []) {
  const updateQueue = vi.fn(async (_id: string, _action: unknown): Promise<QueueResult> => ({ ok: true, value: { accepted: true } }))
  const cancel = vi.fn(async (): Promise<QueueResult> => ({ ok: true, value: { accepted: true } }))
  const inbox = { 'next-turn': nextTurn, 'next-step': nextStep }
  const session = {
    sessionId: 's1',
    projections: { faceOf: (key: string) => ({ getSnapshot: () => (key === 'inbox' ? inbox : undefined) }) },
    updateQueue,
    cancel,
  } as unknown as SessionFace
  return { session, updateQueue, cancel }
}

/** Steering inbox rows in host (FIFO) order (browser submissions are user rows). */
const steering = (ids: readonly string[]): Row[] =>
  ids.map(id => ({ id, source: { kind: 'user' }, content: [{ type: 'text', text: `text ${id}` }] }))

/** One injected (non-user) next-step row, which the host called `context`. */
const injected = (id: string): Row =>
  ({ id, source: { kind: 'plugin' }, content: [{ type: 'text', text: `injected ${id}` }] })

/** One image reference in the shape the host admits into an inbox row. */
const imageRef = (attachmentId: string): ImageRef =>
  ({ attachmentId, mediaType: 'image/png', bytes: 10, width: 2, height: 3 })

/** One user-sourced image-bearing steering row. */
const imageRow = (id: string): Row => ({
  id,
  source: { kind: 'user' },
  content: [{ type: 'image', attachment: imageRef(`${id}-image`) }],
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('retractPending (unread steering withdraw)', () => {
  it('removes the target and its future without cancelling the run', async () => {
    const { session, updateQueue, cancel } = fakeSession(steering(['a', 'b', 'c']))
    const setComposerText = vi.fn(() => true)
    await retractPending(session, 'b', 'text b', setComposerText)
    // #27: the message was still pending, so nothing needs stopping.
    expect(cancel).not.toHaveBeenCalled()
    expect(updateQueue.mock.calls.map(call => call[0])).toEqual(['b', 'c'])
    expect(setComposerText).toHaveBeenCalledWith('s1', 'text b')
  })

  it('never touches queued (next-turn) messages', async () => {
    const { session, updateQueue } = fakeSession(steering(['a']), [{ id: 'q', content: [{ type: 'text', text: 'queued' }] }])
    await retractPending(session, 'a', 'text a', vi.fn(() => true))
    expect(updateQueue.mock.calls.map(call => call[0])).toEqual(['a'])
  })

  it('never sweeps an injected (context) next-step row into a retract', async () => {
    // The list is `a`, an injected row, then `b`. A retract of `a` removes its
    // STEERING future only: the injected row was never the user's to withdraw,
    // and the host's own mapping classified it as `context`, not `steering`.
    const { session, updateQueue } = fakeSession([...steering(['a']), injected('p'), ...steering(['b'])])
    await retractPending(session, 'a', 'text a', vi.fn(() => true))
    expect(updateQueue.mock.calls.map(call => call[0])).toEqual(['a', 'b'])
  })

  it('does not refill when the target was already claimed (queue-item-not-found)', async () => {
    const { session, updateQueue } = fakeSession(steering(['a', 'b']))
    updateQueue.mockResolvedValueOnce({ ok: false, error: { code: 'session/queue-item-not-found' } })
    const restoreImages = vi.fn(async () => {})
    const setComposerText = vi.fn(() => true)
    await retractPending(session, 'a', 'text a', setComposerText, restoreImages)
    // A refill here would invite a duplicate send of an already-read message.
    expect(restoreImages).not.toHaveBeenCalled()
    expect(setComposerText).not.toHaveBeenCalled()
    // The batch was claimed atomically: no futile follow-up removals.
    expect(updateQueue).toHaveBeenCalledTimes(1)
  })

  it('swallows an assembly-fault throw instead of rejecting', async () => {
    const { session, updateQueue } = fakeSession(steering(['a']))
    // Carrier failures resolve as `{ok:false}`; only a call on an unmounted
    // scope rejects, and it must not escape the `void retractPending(...)` site.
    updateQueue.mockRejectedValueOnce(new Error('scope unmounted'))
    const warn = vi.spyOn(console, 'warn').mockReturnValue(undefined)
    const setComposerText = vi.fn(() => true)
    await expect(retractPending(session, 'a', 'text a', setComposerText)).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(setComposerText).not.toHaveBeenCalled()
  })

  it('keeps the empty-composer guard for text while restoring images', async () => {
    const editable = document.createElement('div')
    editable.setAttribute('data-composer-input', '')
    editable.textContent = 'draft in progress'
    document.body.appendChild(editable)
    const { session } = fakeSession([imageRow('a')])
    const restoreImages = vi.fn(async () => {})
    const setComposerText = vi.fn(() => true)
    await retractPending(session, 'a', 'text a', setComposerText, restoreImages)
    expect(restoreImages).toHaveBeenCalledWith('s1', [imageRef('a-image')])
    expect(setComposerText).not.toHaveBeenCalled()
  })

  it('restores the target images after a confirmed removal', async () => {
    const { session } = fakeSession([imageRow('a')])
    const restoreImages = vi.fn(async () => {})
    const setComposerText = vi.fn(() => true)
    await retractPending(session, 'a', 'text a', setComposerText, restoreImages)
    expect(restoreImages).toHaveBeenCalledWith('s1', [imageRef('a-image')])
    expect(setComposerText).toHaveBeenCalledWith('s1', 'text a')
  })

  it('keeps the text refill when the image restore fails', async () => {
    const { session } = fakeSession([imageRow('a')])
    const restoreImages = vi.fn(async () => { throw new Error('image store down') })
    const warn = vi.spyOn(console, 'warn').mockReturnValue(undefined)
    const setComposerText = vi.fn(() => true)
    await expect(retractPending(session, 'a', 'text a', setComposerText, restoreImages)).resolves.toBeUndefined()
    expect(setComposerText).toHaveBeenCalledWith('s1', 'text a')
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('restores only the target images, not the retracted future', async () => {
    const { session, updateQueue } = fakeSession([imageRow('a'), imageRow('b')])
    const restoreImages = vi.fn(async () => {})
    await retractPending(session, 'a', 'text a', vi.fn(), restoreImages)
    expect(updateQueue.mock.calls.map(call => call[0])).toEqual(['a', 'b'])
    expect(restoreImages).toHaveBeenCalledWith('s1', [imageRef('a-image')])
  })

})
