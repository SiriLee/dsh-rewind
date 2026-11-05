/**
 * The ↶ action button: the one message-action control this plugin renders.
 *
 * The A2 mount injects it as a React child of a durable row's actions row; the
 * pending layer (`pending-mount.tsx`) portals the same button, with the retract
 * copy and a marker, into an unclaimed steering bubble.
 *
 * The action only records intent: a click opens the popover variant, which
 * confirms and runs the host command / queue mutation (see `popover.ts`,
 * `rewind-flow.ts`, `retract.ts`); the host's admission stays the authority.
 *
 * @module dsh-rewind/client/action
 */

import type { ReactNode } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RewindKey } from './locales.ts'
import type { RowAction, RowActionRenderer } from './mount.tsx'
import { CLASS } from './styles.ts'

type Translate = (key: RewindKey, params?: Record<string, unknown>) => string

/**
 * The ↶ glyph, drawn inline because the product icon set has no rewind
 * artwork. It renders at the row's glyph scale (the neighbouring Copy/branch
 * icons are 15px) with a 1.25 stroke; at 1 the single open stroke reads thinner
 * than their dense outlines.
 */
const ICON = (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M6.5 2.5 2.5 6.5l4 4" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M2.5 6.5h7a4 4 0 0 1 4 4v1.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
  </svg>
)

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
        {ICON}
      </button>
    </Tooltip>
  )
}

/**
 * Build the A2 mount's action renderer: one button per eligible row, nothing for
 * the rest.
 * @param t - the plugin's own translate function (the action's copy).
 * @param eligible - render-time gate: whether a row's session may offer a rewind at all.
 * @param open - opens the mode popover for one row, anchored at the button.
 * @returns the renderer the mount calls for every user/steering row.
 */
export function rewindActionRenderer(
  t: Translate,
  eligible: (sessionId: string) => boolean,
  open: (row: RowAction, anchor: HTMLElement) => void,
): RowActionRenderer {
  return row => (eligible(row.sessionId) ? (
    <RewindActionButton
      t={t}
      titleKey="button.title"
      ariaKey="button.aria"
      onOpen={anchor => open(row, anchor)}
    />
  ) : null)
}
