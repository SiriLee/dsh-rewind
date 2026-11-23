/**
 * The ↶ action button: the one message-action control this plugin renders.
 *
 * The A2 mount injects it as a React child of a durable row's actions row; the
 * pending layer (`pending-mount.tsx`) portals the same button, with the retract
 * copy and a marker, into an unclaimed steering bubble.
 *
 * The action only records intent: a click opens the popover variant, which
 * confirms and runs the v1 commit or the queue mutation (see `popover.ts`,
 * `rewind-flow.ts`, `retract.ts`); the host remains the authority.
 *
 * @module dsh-rewind/client/action
 */

import { useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TakeoverStore } from './claim.ts'
import { RewindIcon } from './icon.tsx'
import type { RewindKey } from './locales.ts'
import type { RowAction, RowActionRenderer } from './mount.tsx'
import { CLASS } from './styles.ts'

type Translate = (key: RewindKey, params?: Record<string, unknown>) => string

/** The shared button's inputs. */
export interface RewindActionButtonProps {
  readonly t: Translate
  /** Dictionary keys of the tooltip and the aria label. */
  readonly titleKey: RewindKey
  readonly ariaKey: RewindKey
  /** Mark the pre-admission variant: the pending layer uses it to skip its own button. */
  readonly pending?: boolean
  /** Open the action's popover variant, anchored at the button. */
  readonly onOpen: (anchor: HTMLElement) => void
}

/** The row's action chrome, matching the official Copy/branch buttons. */
export function RewindActionButton({ t, titleKey, ariaKey, pending = false, onOpen }: RewindActionButtonProps): ReactNode {
  return (
    <Tooltip label={t(titleKey)} side="bottom">
      <button
        type="button"
        className={CLASS.action}
        aria-label={t(ariaKey)}
        aria-haspopup="dialog"
        data-pending-retract={pending || undefined}
        onClick={event => {
          event.stopPropagation()
          onOpen(event.currentTarget)
        }}
      >
        <RewindIcon size={15} />
      </button>
    </Tooltip>
  )
}

/**
 * One row's action, gated on the live takeover claim: a third-party claimant
 * removes the button from the document, and releasing the claim restores it.
 */
function ClaimedRowAction(props: {
  readonly takeover: TakeoverStore
  readonly t: Translate
  readonly open: (anchor: HTMLElement) => void
  readonly titleKey: RewindKey
  readonly ariaKey: RewindKey
}): ReactNode {
  const takeover = useSyncExternalStore(props.takeover.subscribe, props.takeover.getSnapshot, props.takeover.getSnapshot)
  if (takeover.claimed) return null
  return <RewindActionButton t={props.t} titleKey={props.titleKey} ariaKey={props.ariaKey} onOpen={props.open} />
}

/**
 * Build the A2 mount's action renderer: one button per eligible row, nothing for
 * the rest or while a third-party claim owns the action interface.
 * @param t - the plugin's own translate function (the action's copy).
 * @param eligible - render-time gate: whether a row's session may offer a rewind at all.
 * @param open - opens the mode popover for one row, anchored at the button.
 * @param takeover - the live takeover claim.
 * @returns the renderer the mount calls for every user/steering row.
 */
export function rewindActionRenderer(
  t: Translate,
  eligible: (sessionId: string) => boolean,
  open: (row: RowAction, anchor: HTMLElement) => void,
  takeover: TakeoverStore,
): RowActionRenderer {
  return row => (eligible(row.sessionId) ? (
    <ClaimedRowAction
      takeover={takeover}
      t={t}
      titleKey="button.title"
      ariaKey="button.aria"
      open={anchor => open(row, anchor)}
    />
  ) : null)
}
