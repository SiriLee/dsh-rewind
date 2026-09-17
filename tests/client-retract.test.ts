/**
 * @vitest-environment jsdom
 *
 * Pending-retract probes (`retractPending` in `portals.tsx`): withdrawing an
 * unread steering message must NOT stop the run (SiriLee/dsh-rewind#27), must
 * remove the target and its steering future through `updateQueue`, and must
 * refill the composer only when the target was actually removed. The session
 * face is a hand fake; `session.cancel` is asserted to stay untouched.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionFace } from '@deepseek-ai/dsh-api-session-controller/client'
import { retractPending } from '../src/client/portals.tsx'

/** The inbox projection row shape the retract reads (alpha.2). */
interface Row {
  readonly id: string
  readonly content: readonly { readonly type: string; readonly text?: string }[]
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

/** Steering inbox rows in host (FIFO) order. */
const steering = (ids: readonly string[]): Row[] => ids.map(id => ({ id, content: [{ type: 'text', text: `text ${id}` }] }))

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

  it('does not refill when the target was already claimed (queue-item-not-found)', async () => {
    const { session, updateQueue } = fakeSession(steering(['a', 'b']))
    updateQueue.mockResolvedValueOnce({ ok: false, error: { code: 'session/queue-item-not-found' } })
    const setComposerText = vi.fn(() => true)
    await retractPending(session, 'a', 'text a', setComposerText)
    // A refill here would invite a duplicate send of an already-read message.
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

  it('honours the empty-composer guard', async () => {
    const editable = document.createElement('div')
    editable.setAttribute('data-composer-input', '')
    editable.textContent = 'draft in progress'
    document.body.appendChild(editable)
    const { session } = fakeSession(steering(['a']))
    const setComposerText = vi.fn(() => true)
    await retractPending(session, 'a', 'text a', setComposerText)
    expect(setComposerText).not.toHaveBeenCalled()
  })
})
