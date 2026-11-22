/**
 * The shared ↶ glyph: the inline row action and the client `/rewind` command
 * row draw the same artwork.
 *
 * @module dsh-rewind/client/icon
 */

import type { ReactNode } from 'react'
import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * The ↶ glyph, drawn inline because the product icon set has no rewind
 * artwork. It renders at the row's glyph scale by default (the neighbouring
 * Copy/branch icons are 15px) with a 1.25 stroke; at 1 the single open stroke
 * reads thinner than their dense outlines.
 * @param props - shared icon props (`size`, `className`).
 */
export function RewindIcon({ size = 15, className }: IconProps): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <path d="M6.5 2.5 2.5 6.5l4 4" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M2.5 6.5h7a4 4 0 0 1 4 4v1.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  )
}
