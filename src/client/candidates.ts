/**
 * Candidate row mapping for the `/rewind` popupSelect: the host supplies the
 * targets; this module formats their clock and row copy.
 *
 * @module dsh-rewind/client/candidates
 */

import type { SelectOption } from '@deepseek-ai/dsh-client-ui-commands/client'
import type { RewindKey } from './locales.ts'

type Translate = (key: RewindKey, params?: Record<string, unknown>) => string

/** One selectable rewind target. */
export interface RewindCandidate {
  /** Absolute log seq of the `user/message` event. */
  readonly seq: number
  /** Unix epoch ms of the event. */
  readonly time: number
  /** Plain-text preview supplied by the host. */
  readonly preview: string
}

/** Format a candidate row's clock time (`HH:MM`), matching the host format. */
function formatCandidateTime(time: number): string {
  const d = new Date(time)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

/** Map typed candidates to popupSelect rows. */
export function rewindOptionsFromCandidates(candidates: readonly RewindCandidate[], t: Translate): SelectOption[] {
  return candidates.map(candidate => ({
    id: String(candidate.seq),
    label: candidate.preview || t('popover.noText'),
    detail: formatCandidateTime(candidate.time),
  }))
}
