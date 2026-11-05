/**
 * The per-message rewind action: the ↶ button the A2 mount injects into a
 * durable user/steering row's actions row.
 *
 * The action only records intent. A click opens the mode popover, which
 * confirms and runs the host command (see `popover.ts` / `rewind-flow.ts`);
 * whether the host admits the rewind stays its own decision.
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

/**
 * Build the mount's action renderer: one button per eligible row, nothing for
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
    <Tooltip label={t('button.title')} side="bottom">
      <button
        type="button"
        className={CLASS.action}
        aria-label={t('button.aria')}
        aria-haspopup="dialog"
        onClick={event => {
          event.stopPropagation()
          open(row, event.currentTarget)
        }}
      >
        {ICON}
      </button>
    </Tooltip>
  ) : null)
}
