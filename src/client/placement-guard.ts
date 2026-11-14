/**
 * Viewport guard for the popover's CSS-anchor placement.
 *
 * Effect: after mount and after each content render, if the panel sits outside
 * the viewport, pin it with inline insets derived from the trigger's rect and
 * detach it from the anchor machinery. While the official CSS keeps the panel
 * inside the viewport this module writes nothing.
 *
 * Why: Firefox resolves `anchor()` for a fixed panel in the anchor scroller's
 * content space (measured: top 5444 = scrollTop 5201 + trigger bottom 239 + 4,
 * instead of 243). The guard asserts the official CSS's own contract — the
 * panel stays inside the viewport — instead of duplicating its placement rules.
 *
 * Tradeoffs: a pinned panel no longer follows scroll/resize, and the official
 * five-way fallback list becomes preferred side, opposite side, clamp. Gated to
 * Gecko so healthy engines never enter the check; only the plugin's two
 * popovers are covered. Remove this module and its call in `mountShell` once
 * Firefox or the host fixes the substrate.
 *
 * @module dsh-rewind/client/placement-guard
 */

/** The 12px viewport inset the official panel uses. */
const SIDE_INSET = 12
/** The gap between the trigger and the panel, matching the popover CSS. */
const GAP = 4
/** Sub-pixel tolerance so a correctly placed panel never counts as outside. */
const EPSILON = 0.5

/**
 * Temporary engine gate. The check is pointless on engines that place the
 * panel correctly, and keeping it off them makes the guard a literal no-op.
 */
const IS_GECKO = typeof navigator !== 'undefined' && /\bFirefox\//.test(navigator.userAgent)

interface AnchorEdges {
  readonly top: number
  readonly bottom: number
  readonly left: number
}

interface PanelSize {
  readonly width: number
  readonly height: number
}

interface ViewportSize {
  readonly width: number
  readonly height: number
}

/** Pure pin math, kept separate from the DOM read/write. */
function pinnedPosition(
  anchor: AnchorEdges,
  size: PanelSize,
  viewport: ViewportSize,
  placement: 'above' | 'below',
  topInset: number,
): { left: number; top: number } {
  const maxLeft = Math.max(SIDE_INSET, viewport.width - size.width - SIDE_INSET)
  const left = Math.min(Math.max(anchor.left, SIDE_INSET), maxLeft)

  const above = anchor.top - size.height - GAP
  const below = anchor.bottom + GAP
  const preferred = placement === 'above' ? above : below
  const opposite = placement === 'above' ? below : above
  const maxTop = Math.max(topInset, viewport.height - size.height - SIDE_INSET)
  const fits = (top: number): boolean => top >= topInset && top <= maxTop

  const chosen = !fits(preferred) && fits(opposite) ? opposite : preferred
  return { left, top: Math.min(Math.max(chosen, topInset), maxTop) }
}

/** The official top inset also reserves the host's frame overlay. */
function readTopInset(panel: HTMLElement): number {
  const raw = Number.parseFloat(getComputedStyle(panel).getPropertyValue('--dsh-frame-overlay-top'))
  return Number.isFinite(raw) ? Math.max(SIDE_INSET, raw) : SIDE_INSET
}

/** One guard per mounted popover: inert until the panel leaves the viewport. */
export function guardPlacement(
  panel: HTMLElement,
  anchor: HTMLElement,
  placement: 'above' | 'below',
): () => void {
  if (!IS_GECKO) return () => {}

  let pinned = false
  let topInset = SIDE_INSET
  let insetResolved = false

  return (): void => {
    if (!panel.isConnected || !anchor.isConnected) return
    const rect = panel.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return
    const viewport = {
      width: document.documentElement.clientWidth,
      height: document.documentElement.clientHeight,
    }
    const inside = rect.left >= -EPSILON
      && rect.top >= -EPSILON
      && rect.right <= viewport.width + EPSILON
      && rect.bottom <= viewport.height + EPSILON
    if (!pinned && inside) return

    if (!insetResolved) {
      insetResolved = true
      topInset = readTopInset(panel)
    }
    const position = pinnedPosition(anchor.getBoundingClientRect(), rect, viewport, placement, topInset)
    pinned = true
    panel.style.setProperty('position-anchor', 'none')
    panel.style.setProperty('position-try-fallbacks', 'none')
    panel.style.setProperty('right', 'auto')
    panel.style.setProperty('bottom', 'auto')
    panel.style.setProperty('left', `${Math.round(position.left)}px`)
    panel.style.setProperty('top', `${Math.round(position.top)}px`)
  }
}
