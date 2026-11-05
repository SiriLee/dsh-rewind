/**
 * The pending (unclaimed) rewind: withdraw one pre-sent steering message and
 * every steering message after it — the rollback point's "future" — WITHOUT
 * interrupting the run.
 *
 * The message is still in the agent's next-step inbox, so the loop has not
 * claimed it into any request: removing it cannot change what the model is
 * generating. Stopping the run first (the durable-rewind rule) would throw away
 * in-flight work for an edit the model can never observe. Only the durable
 * rewind needs a stop, because it cuts the model-visible surface.
 *
 * The realistic failure is `queue-item-not-found`: a step boundary claimed the
 * whole batch a moment ago, so the message is durable now and the durable row's
 * rewind action takes over with no gap. Nothing is removed then, and the
 * composer is NOT refilled — that would invite a duplicate send of a message
 * the model has already received.
 *
 * @module dsh-rewind/client/retract
 */

import type { SessionFace } from '@deepseek-ai/dsh-api-session-controller/client'
import type { MessageImageRef } from './hidden.ts'
import { rewindLog } from './log.ts'
import { inboxOf, retractSpan, steeringItemsOf } from './pending.ts'
import { composerText } from './rewind-flow.ts'

/**
 * Withdraw one pending steering message and its steering future through the
 * session's own `updateQueue` channel, then put the target's images and text
 * back into the composer.
 * @param session - the session holding the pending occurrence.
 * @param itemId - the target's inbox occurrence id.
 * @param text - the target's complete text (null when it has no text block).
 * @param setComposerText - writes one session's composer draft.
 * @param restoreImages - restores the target's images into the composer draft.
 */
export async function retractPending(
  session: SessionFace,
  itemId: string,
  text: string | null,
  setComposerText: (sessionId: string, text: string) => boolean,
  restoreImages?: (sessionId: string, images: readonly MessageImageRef[]) => Promise<void>,
): Promise<void> {
  const steering = steeringItemsOf(inboxOf(session)?.['next-step'])
  const images = steering.find(item => item.id === itemId)?.images ?? []
  let removedTarget = false
  for (const id of retractSpan(steering, itemId)) {
    let accepted = false
    try {
      // Carrier failures resolve as `{ok:false}`; only an assembly fault on an
      // unmounted scope rejects. That must not become an unhandled rejection on
      // the `void retractPending(...)` call site.
      const result = await session.updateQueue(id as Parameters<SessionFace['updateQueue']>[0], { kind: 'remove' })
      accepted = result.ok
      // A lost race is expected, not an anomaly: the message is durable now.
      if (!result.ok) rewindLog.info('retract', `pending retract lost the race for ${id}`, result.error)
    } catch (error) {
      rewindLog.warn('retract', `pending retract remove threw for ${id}`, error)
    }
    // retractSpan is oldest-first: the first failure means the rest was claimed
    // together, so a follow-up removal would only be futile.
    if (!accepted) break
    if (id === itemId) removedTarget = true
  }
  // Refill only on a confirmed removal (see the failure note above).
  if (!removedTarget) return
  if (images.length > 0 && restoreImages !== undefined) {
    try {
      await restoreImages(session.sessionId, images)
    } catch (error) {
      rewindLog.warn('retract', `image restore for ${itemId} threw`, error)
    }
  }
  // Empty-composer guard: never clobber a draft the user is already editing.
  if (text !== null && text !== '' && composerText().trim() === '') {
    setComposerText(session.sessionId, text)
  }
}
