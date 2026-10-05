/**
 * Which Turn rail marks a rewind withdrew.
 *
 * The harness's Turn rail (the per-turn ladder beside the transcript) is fed by
 * the host's `turnOutline` projection: a pure `turn/start` fold over the event
 * log that ignores `surfaceOp` entirely and exposes NO removal API. A rewind
 * therefore leaves its marks on screen while the transcript below correctly
 * drops the same Turns' rows — the two views disagree, and only the client can
 * reconcile them.
 *
 * Reconciling the rail is constrained by three harness facts:
 *
 * - A mark carries only `data-index`, its position in the rail ARRAY — never the
 *   Turn number — and the array is React state the DOM does not expose.
 * - Marks are VIRTUALIZED: scrolling mounts and unmounts them, so a mark that is
 *   off screen cannot be hidden by index and hiding must re-apply as marks mount.
 * - The rail's own array is the `turnOutline` projection merged with the loaded
 *   window (`mergeTurnRailItems`, sorted ascending by Turn).
 *
 * So the Turn list is read from that same projection instead of guessed from the
 * DOM: a withdrawn Turn's rank in the merged, ascending array IS its mark's
 * `data-index`. That mapping is exact for every mounted mark and needs no
 * assumption about the rail's markup beyond the one `data-index` attribute.
 *
 * @module dsh-rewind/client/turn-rail
 */

import type { HiddenChat } from './hidden.ts'

/**
 * The attribute the harness writes on a Turn footer row. The transcript-side
 * pass hides these by Turn number; they need no index indirection.
 */
export const TURN_FOOTER_ATTR = 'data-turn-tail'

/**
 * A rail mark's only stable hook: its position in the rail array.
 *
 * A `TurnMark` writes `data-index` and nothing else identifying — no Turn
 * number, no key (the React key is never emitted as an attribute).
 */
export const TURN_MARK_INDEX_ATTR = 'data-index'

/** Chat node kinds that carry a Turn number in their payload. */
const TURN_SCOPED_KINDS: ReadonlySet<string> = new Set([
  'turn-tail',
  'turn-process',
  'turn-error',
  'turn-max-tokens',
])

/**
 * Turn numbers whose chat rows a rewind withdrew.
 *
 * Only Turn-scoped kinds are read: a user bubble or a tool row belongs to no
 * single Turn for rail purposes, and its Turn is already covered by that Turn's
 * own footer/process row. A Turn is reported when ANY of its rows fell into a
 * cut, so a Turn that ended before the rewind target keeps its mark even when a
 * later Turn was withdrawn.
 *
 * @param chat - the session chat snapshot (undefined before the view registers).
 * @param hidden - anchor seqs withdrawn by rewinds, from `hiddenSeqsOf`.
 * @returns the withdrawn Turn numbers; empty when nothing was rewound.
 */
export function withdrawnTurnsOf(
  chat: HiddenChat | undefined,
  hidden: ReadonlySet<number>,
): ReadonlySet<number> {
  const turns = new Set<number>()
  if (chat === undefined || hidden.size === 0) return turns
  for (const key of chat.order) {
    const node = chat.nodes.get(key)
    if (node === undefined || !TURN_SCOPED_KINDS.has(node.kind ?? '')) continue
    if (!hidden.has(node.anchorSeq)) continue
    const turn = (node.data as { turn?: unknown } | undefined)?.turn
    if (typeof turn === 'number' && Number.isSafeInteger(turn) && turn >= 0) turns.add(turn)
  }
  return turns
}

/**
 * The Turn numbers of the host's `turnOutline` projection, ascending.
 *
 * The projection is wire data (an unknown-shaped value), so it is read
 * defensively: any array of `{ turn }` records is accepted, in whatever shape
 * the projection nests them, and a value that is not that shape yields an empty
 * list — never a throw. Order is normalized here because the RANK in this list
 * is what addresses a mark.
 *
 * @param outline - the `turnOutline` projection value, treated as wire data.
 * @returns the Turn numbers, ascending and de-duplicated.
 */
export function outlineTurnsOf(outline: unknown): readonly number[] {
  const turns: number[] = []
  collectTurns(outline, turns, 0)
  return [...new Set(turns)].sort((left, right) => left - right)
}

/** Depth-limited walk collecting every `{ turn: <number> }` record. */
function collectTurns(value: unknown, into: number[], depth: number): void {
  if (depth > 3 || value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) collectTurns(item, into, depth + 1)
    return
  }
  const turn = (value as { turn?: unknown }).turn
  if (typeof turn === 'number' && Number.isSafeInteger(turn) && turn >= 0) into.push(turn)
  for (const nested of Object.values(value as Record<string, unknown>)) collectTurns(nested, into, depth + 1)
}

/**
 * Build the resolver mapping a withdrawn Turn to the rail index addressing it.
 *
 * The rail array is `mergeTurnRailItems(loaded, outline)`: every outline Turn
 * plus every loaded Turn, ascending by Turn. The outline list alone therefore
 * gives each Turn a RANK that matches its mark's `data-index` whenever the two
 * sides agree — which is the case for the Turns a rewind can withdraw, since
 * those Turns necessarily have loaded nodes (their rows were rendered). When a
 * Turn is absent from the outline (never persisted, or the projection has not
 * loaded), the resolver returns undefined and that Turn's mark is simply not
 * hidden this pass — degraded, never wrong.
 *
 * @param outline - the `turnOutline` projection value, treated as wire data.
 * @returns the Turn → rail index resolver for this pass.
 */
export function railIndexResolverOf(outline: unknown): (turn: number) => number | undefined {
  const turns = outlineTurnsOf(outline)
  const rank = new Map(turns.map((turn, index) => [turn, index]))
  return turn => rank.get(turn)
}

/**
 * Hide the footers and rail marks of every withdrawn Turn.
 *
 * Footers are addressed by Turn number (`[data-turn-tail="n"]`). Marks are
 * addressed by INDEX, resolved through the caller-supplied Turn → rank mapping.
 * Splitting that mapping out keeps this function free of any assumption about
 * how the rail array is built, and lets a caller with no projection (offline,
 * projection unavailable) hide footers alone.
 *
 * Best-effort by design: both attributes are harness-internal, so a renamed or
 * removed one degrades to "nothing is hidden" rather than throwing.
 *
 * @param turns - withdrawn Turn numbers, from `withdrawnTurnsOf`.
 * @param indexOf - maps a withdrawn Turn to its rail index, or undefined.
 * @param root - the subtree holding the rows and the rail; defaults to the document.
 * @param mark - apply the observation attribute (a test seam: pass a no-op).
 */
export function hideWithdrawnTurnMarks(
  turns: ReadonlySet<number>,
  indexOf: (turn: number) => number | undefined,
  root: ParentNode = document,
  mark: (element: HTMLElement) => void = element => { element.setAttribute('data-dsh-rewind-hidden', 'true') },
): void {
  if (turns.size === 0) return
  const indexes = new Set<number>()
  for (const turn of turns) {
    for (const element of root.querySelectorAll<HTMLElement>(`[${TURN_FOOTER_ATTR}="${turn}"]`)) hide(element, mark)
    const index = indexOf(turn)
    if (index !== undefined) indexes.add(index)
  }
  if (indexes.size === 0) return
  for (const element of root.querySelectorAll<HTMLElement>(`[${TURN_MARK_INDEX_ATTR}]`)) {
    const index = Number(element.getAttribute(TURN_MARK_INDEX_ATTR))
    if (Number.isSafeInteger(index) && indexes.has(index)) hide(element, mark)
  }
}

/** Hide one element once, recording the observation attribute. */
function hide(element: HTMLElement, mark: (element: HTMLElement) => void): void {
  if (element.style.display === 'none') return
  element.style.display = 'none'
  mark(element)
}
