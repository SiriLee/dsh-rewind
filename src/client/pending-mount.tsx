/**
 * The pending-steering retract layer: the pre-admission counterpart of the A2
 * action, attached through the DOM.
 *
 * An unclaimed steering bubble is not a slot entry — `ChatFlow` constructs it
 * from the owner's `pendingInputs` — so there is no component identity to take
 * over. While the session's inbox holds user steering rows this layer finds their
 * bubbles inside the session's own content region and portals one retract button
 * into each matched actions row; when the inbox holds none it removes the
 * buttons and disconnects the observer. Outside that window there is no observer
 * and no DOM query — only the inbox subscription, which fires on inbox changes.
 *
 * @module dsh-rewind/client/pending-mount
 */

import { useLayoutEffect, useReducer, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { SessionFace } from '@deepseek-ai/dsh-api-session-controller/client'
import { RewindActionButton } from './action.tsx'
import type { MessageImageRef } from './hidden.ts'
import type { RewindKey } from './locales.ts'
import { rewindLog } from './log.ts'
import { inboxOf, matchPendingRows, steeringItemsOf, type PendingRow, type PendingSteeringItem } from './pending.ts'
import { openPopover } from './popover.ts'
import { isRewindInertSession } from './rewind-flow.ts'
import { retractPending } from './retract.ts'

/** The pending steering bubble row (Host-authoritative pre-admission projection). */
const PENDING_SEAT_SELECTOR = '[data-pending-steering]'

/** The message-attachment block shared by user, steering and pending bubbles. */
const MESSAGE_ATTACHMENT_SELECTOR = '[data-message-attachments]'

/** One session's content region: the chat surface this layer scans and observes. */
const SESSION_CONTENT_SELECTOR = '[data-conversation-session]'

type Translate = (key: RewindKey, params?: Record<string, unknown>) => string

/** The closed-gate target set: a stable reference, so re-clearing never re-renders. */
const NO_TARGETS: readonly PendingTarget[] = []

/** One portaled retract button and the inbox occurrence it addresses. */
interface PendingTarget {
  readonly container: HTMLElement
  readonly itemId: string
  readonly text: string | null
}

/** The capability inputs the bridge closes over (all identity-stable). */
export interface PendingBridgeDeps {
  sessionOf(sessionId: string): SessionFace | undefined
  setComposerText(sessionId: string, text: string): boolean
  restoreImages?(sessionId: string, images: readonly MessageImageRef[]): Promise<void>
  t: Translate
  subscribeLocale(cb: () => void): () => void
}

/**
 * The pending bubble row's compared text and its message-attachment block count,
 * read from a CLONE (the live row is never touched).
 *
 * The actions container is dropped because the Copy button mounts its hover
 * label inside itself, and the attachment block is dropped for the same reason
 * (a file name, an image's loading label) and counted instead — the count is the
 * match key's attachment half.
 * @param row - one rendered `[data-pending-steering]` row.
 */
function bubbleTextOf(row: HTMLElement): PendingRow {
  const clone = row.cloneNode(true) as HTMLElement
  clone.lastElementChild?.remove()
  const attachments = row.querySelectorAll(MESSAGE_ATTACHMENT_SELECTOR).length
  for (const block of clone.querySelectorAll(MESSAGE_ATTACHMENT_SELECTOR)) block.remove()
  return { text: clone.textContent ?? '', attachments }
}

/**
 * Locate a pending bubble's actions container: the holder of its Copy button.
 * The last button-bearing element is that action row; this layer's own portaled
 * button is skipped so a refresh never re-targets itself.
 * @param row - one rendered pending bubble row.
 */
function actionsContainerOf(row: HTMLElement): HTMLElement | undefined {
  const buttons = [...row.querySelectorAll<HTMLButtonElement>('button')]
    .filter(button => button.dataset['pendingRetract'] === undefined)
  const structural = buttons.at(-1)?.parentElement
  return structural instanceof HTMLElement && structural.querySelector('button') !== null ? structural : undefined
}

/**
 * Pair the rendered bubbles of every content root with the session's steering
 * items. Roots are matched independently, so a session rendered in two views gets
 * a button in each while other sessions are never touched.
 */
function collectTargets(roots: readonly HTMLElement[], steering: readonly PendingSteeringItem[]): PendingTarget[] {
  const targets: PendingTarget[] = []
  for (const root of roots) {
    const rows = [...root.querySelectorAll<HTMLElement>(PENDING_SEAT_SELECTOR)]
    const matched = matchPendingRows(rows.map(bubbleTextOf), steering)
    for (const [index, row] of rows.entries()) {
      const itemId = matched[index]
      const item = steering[index]
      const container = actionsContainerOf(row)
      if (itemId === null || itemId === undefined || item === undefined || container === undefined) continue
      targets.push({ container, itemId, text: item.text })
    }
  }
  return targets
}

/** Whether two target lists describe the same portals (order-sensitive). */
function sameTargets(left: readonly PendingTarget[], right: readonly PendingTarget[]): boolean {
  return left.length === right.length && left.every((target, index) => {
    const other = right[index]
    return other !== undefined && target.container === other.container && target.itemId === other.itemId
  })
}

/** The session's own content regions (usually one); other sessions' regions are excluded. */
function contentRootsOf(sessionId: string): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(SESSION_CONTENT_SELECTOR)]
    .filter(element => element.dataset['conversationSession'] === sessionId)
}

/**
 * Whether one mutation record involves a pending bubble: the bubble was added or
 * removed, or the change happened inside one (e.g. its actions row remounted).
 * Everything else — streaming markdown, tool cards, the composer — is ignored
 * without a query.
 */
function involvesPending(record: MutationRecord): boolean {
  const target = record.target
  if (target instanceof Element && target.closest(PENDING_SEAT_SELECTOR) !== null) return true
  for (const node of [...record.addedNodes, ...record.removedNodes]) {
    if (node instanceof Element && (node.matches(PENDING_SEAT_SELECTOR) || node.querySelector(PENDING_SEAT_SELECTOR) !== null)) {
      return true
    }
  }
  return false
}

/** Resolve the session, treating a teardown throw as "no session". */
function resolveSession(deps: PendingBridgeDeps, sessionId: string): SessionFace | undefined {
  try {
    return deps.sessionOf(sessionId)
  } catch {
    return undefined
  }
}

/** The session's inbox projection face, or undefined before it is registered. */
function inboxFaceOf(session: SessionFace): { subscribe?(cb: () => void): () => void } | undefined {
  try {
    return session.projections.faceOf('inbox')
  } catch {
    return undefined
  }
}

/** One portaled retract button. */
function RetractButton({ target, sessionId, deps }: {
  target: PendingTarget
  sessionId: string
  deps: PendingBridgeDeps
}): ReactNode {
  const onOpen = (anchor: HTMLElement): void => {
    const session = resolveSession(deps, sessionId)
    if (session === undefined) {
      rewindLog.warn('retract', 'pending retract clicked with no session binding')
      return
    }
    openPopover({
      session,
      preview: target.text ?? '',
      anchor,
      t: deps.t,
      retract: { itemId: target.itemId, text: target.text },
      onRetract: () => { void retractPending(session, target.itemId, target.text, deps.setComposerText, deps.restoreImages) },
    })
  }
  return (
    <RewindActionButton
      t={deps.t}
      titleKey="button.title"
      ariaKey="button.retract.aria"
      pending
      onOpen={onOpen}
    />
  )
}

/** The session-scoped layer: inbox-gated refresh, scoped observer, and the portals. */
function PendingRetractLayer({ sessionId, deps }: { sessionId: string; deps: PendingBridgeDeps }): ReactNode {
  const [targets, setTargets] = useState<readonly PendingTarget[]>(NO_TARGETS)
  const [, forceRender] = useReducer((count: number) => count + 1, 0)
  // The labels are read at render; a locale switch re-renders the portaled buttons.
  useLayoutEffect(() => deps.subscribeLocale(() => { forceRender() }), [deps])

  useLayoutEffect(() => {
    let stopped = false
    let queued = false
    let observer: MutationObserver | null = null
    let observed: readonly HTMLElement[] = []

    const stopObserver = (): void => {
      observer?.disconnect()
      observer = null
      observed = []
    }

    /** (Re)attach the observer when the content roots moved, and only then. */
    const observe = (roots: readonly HTMLElement[]): void => {
      if (observer !== null && observed.length === roots.length && observed.every((root, index) => root === roots[index])) return
      stopObserver()
      observed = roots
      observer = new MutationObserver((records) => {
        if (stopped) return
        // A content region replaced wholesale takes the observer with it.
        if (observed.some(root => !root.isConnected)) { refresh(); return }
        if (records.some(involvesPending)) schedule()
      })
      for (const root of observed) observer.observe(root, { childList: true, subtree: true })
    }

    /** The gate: read the inbox, then attach, refresh or tear down accordingly. */
    const refresh = (): void => {
      if (stopped) return
      const session = resolveSession(deps, sessionId)
      const steering = session === undefined ? [] : steeringItemsOf(inboxOf(session)?.['next-step'])
      if (session === undefined || steering.length === 0 || isRewindInertSession(session.getSnapshot())) {
        setTargets(NO_TARGETS)
        stopObserver()
        return
      }
      const roots = contentRootsOf(sessionId)
      if (roots.length === 0) {
        setTargets(NO_TARGETS)
        stopObserver()
        return
      }
      observe(roots)
      const next = collectTargets(roots, steering)
      setTargets(current => (sameTargets(current, next) ? current : next))
    }

    /** Coalesce mutation bursts into one refresh per microtask window. */
    const schedule = (): void => {
      if (queued || stopped) return
      queued = true
      queueMicrotask(() => {
        queued = false
        refresh()
      })
    }

    refresh()
    const session = resolveSession(deps, sessionId)
    const unsubscribe = session === undefined ? undefined : inboxFaceOf(session)?.subscribe?.(schedule)
    return () => {
      stopped = true
      unsubscribe?.()
      stopObserver()
    }
  }, [sessionId, deps])

  return targets.map(target => createPortal(
    <RetractButton key={target.itemId} target={target} sessionId={sessionId} deps={deps} />,
    target.container,
    target.itemId,
  ))
}

/**
 * Build the session-scoped slot entry that runs the pending layer. It renders
 * portals only — never header UI.
 * @param deps - session resolution, composer write, image restore, copy and locale.
 */
export function createPendingBridge(deps: PendingBridgeDeps): (props: { readonly sessionId: string }) => ReactNode {
  return function PendingBridge({ sessionId }: { readonly sessionId: string }): ReactNode {
    return <PendingRetractLayer sessionId={sessionId} deps={deps} />
  }
}
