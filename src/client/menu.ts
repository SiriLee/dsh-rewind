/**
 * The manual `/rewind` rewind menu (plain DOM, no React). Step one of the
 * text-driven flow: typing a bare `/rewind` in the composer opens this menu
 * instead of submitting the command — Claude Code's rewind menu, triggered by
 * the command line. The menu lists the selectable user messages (most recent
 * first, numbered 1..N); picking one hands the target to the SAME mode
 * popover the per-message ↶ button opens (`openPopover`), so the rest of the
 * flow — mode choice, both-impact confirmation, execution, row hiding and the
 * composer refill — is byte-identical to the button path.
 *
 * The candidate listing is a pure function of the session chat snapshot
 * (`rewindCandidatesOf`) so it stays unit-testable in a node environment,
 * mirroring the host's `listRewindCandidates` semantics: surface user/steering
 * messages only, withdrawn (hidden) rows excluded, most recent first.
 *
 * @module dsh-rewind/client/menu
 */

import type { SessionFace } from '@deepseek-ai/dsh-client-runtime/client'
import { hiddenSeqsOf, type HiddenChat } from './hidden.ts'
import type { RewindKey } from './locales.ts'
import { CLASS } from './styles.ts'

type Translate = (key: RewindKey, params?: Record<string, unknown>) => string

/** Preview length cap for candidate rows (matches the host's candidate list). */
export const MENU_PREVIEW_CHARS = 80

/** One selectable candidate row. */
export interface MenuCandidate {
  /** Absolute log seq of the `user/message` event. */
  readonly seq: number
  /** Unix epoch ms of the event. */
  readonly time: number
  /** Truncated plain-text preview of the message content. */
  readonly preview: string
  /** 1-based recency index (1 = most recent). */
  readonly index: number
}

/** A chat snapshot subset the candidate listing reads (structural). */
export interface MenuChat {
  readonly order: readonly string[]
  readonly nodes: { get(key: string): MenuUserNode | undefined }
}

/** A user/steering row subset; only fields the menu reads are real. */
export interface MenuUserNode {
  readonly kind: string
  readonly anchorSeq?: number
  readonly data: {
    readonly seq: number
    readonly time: number
    readonly content: readonly { type: string; text?: unknown }[]
  }
}

/** Join the text blocks of a user message into one plain preview. */
export function messagePreviewOf(message: { readonly content: readonly { type: string; text?: unknown }[] }): string {
  const text = message.content
    .map(block => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length <= MENU_PREVIEW_CHARS
    ? text
    : `${text.slice(0, MENU_PREVIEW_CHARS - 1)}…`
}

/** The composer textarea dsh renders for the current session's input. */
const COMPOSER_SELECTOR = '[data-input-scroll] textarea, textarea[data-phase]'

/**
 * List the selectable rewind candidates of a session chat snapshot: user and
 * steering rows still on the surface (not hidden by a previous rewind), most
 * recent first, numbered 1..N — the same candidate set and ordering the host's
 * `listRewindCandidates` produces for the same surface.
 * @param snap - the session chat snapshot.
 * @param hidden - anchor seqs withdrawn by rewinds (from `hiddenSeqsOf`).
 * @param limit - maximum number of candidates to return.
 */
export function rewindCandidatesOf(snap: MenuChat, hidden: ReadonlySet<number>, limit = 10): MenuCandidate[] {
  const candidates: MenuCandidate[] = []
  for (let i = snap.order.length - 1; i >= 0 && candidates.length < limit; i--) {
    const key = snap.order[i]
    if (key === undefined) continue
    const node = snap.nodes.get(key)
    if (node === undefined || (node.kind !== 'user' && node.kind !== 'steering')) continue
    if (hidden.has(node.anchorSeq ?? node.data.seq)) continue
    candidates.push({
      seq: node.data.seq,
      time: node.data.time,
      preview: messagePreviewOf(node.data),
      index: candidates.length + 1,
    })
  }
  return candidates
}

/** The single live menu element, or null when closed. */
let menuEl: HTMLElement | null = null

let disposeMenu: (() => void) | null = null

/** Close the current rewind menu, if any. */
export function closeRewindMenu(): void {
  if (menuEl !== null) {
    menuEl.remove()
    menuEl = null
  }
  if (disposeMenu !== null) {
    disposeMenu()
    disposeMenu = null
  }
}

/** Element factory helpers (kept local so no framework is involved). */
function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag)
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** Format a candidate row's clock time (`HH:MM`), matching the host format. */
function formatTime(time: number): string {
  const d = new Date(time)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

/** Capabilities the menu needs from the plugin apply() (see src/client/index.ts). */
export interface RewindMenuDeps {
  /** Resolve a session id to its live face. */
  readonly sessionOf: (sessionId: string) => SessionFace | undefined
  /** The session switch check: the menu closes when the user leaves its session. */
  readonly currentSessionId: () => string | undefined
  readonly t: Translate
  /**
   * Pick one candidate: close the menu and continue the SAME flow as the
   * per-message ↶ button (the mode popover, impact confirmation, execution
   * and composer refill). `anchor` is the element the popover positions near.
   */
  readonly onPick: (candidate: MenuCandidate, anchor: HTMLElement) => void
}

/**
 * Open the rewind menu above the composer. The candidate list is read from the
 * CURRENT session's chat snapshot at open time; the menu closes itself when
 * the user leaves that session (checked on every interaction).
 */
export function openRewindMenu(deps: RewindMenuDeps): void {
  closeRewindMenu()
  const { sessionOf, currentSessionId, t, onPick } = deps
  const sessionId = currentSessionId()
  const session = sessionId !== undefined ? sessionOf(sessionId) : undefined
  if (session === undefined) return

  const snap = session.getSnapshot().chat as unknown as MenuChat
  const hidden = hiddenSeqsOf(snap as unknown as HiddenChat)
  const candidates = rewindCandidatesOf(snap, hidden)

  const root = el('div', CLASS.menu)
  root.setAttribute('role', 'dialog')
  root.setAttribute('aria-label', t('menu.title'))
  root.tabIndex = -1

  const list = el('div', CLASS.menuList)
  let active = 0

  const pick = (candidate: MenuCandidate, anchor: HTMLElement): void => {
    // The user may have switched sessions while the menu was open — refuse to
    // rewind a session they are no longer looking at.
    if (currentSessionId() !== sessionId) {
      closeRewindMenu()
      return
    }
    closeRewindMenu()
    onPick(candidate, anchor)
  }

  const buildList = (): void => {
    list.replaceChildren()
    if (candidates.length === 0) {
      list.append(el('div', CLASS.menuEmpty, t('menu.empty')))
      return
    }
    candidates.forEach((candidate, index) => {
      const row = document.createElement('button')
      row.type = 'button'
      row.className = CLASS.menuRow
      row.append(
        el('span', CLASS.menuRowIndex, String(candidate.index)),
        el('span', CLASS.menuRowTime, formatTime(candidate.time)),
        el('span', CLASS.menuRowText, candidate.preview || t('popover.noText')),
      )
      row.addEventListener('click', () => pick(candidate, row))
      row.addEventListener('mouseenter', () => setActive(index))
      list.append(row)
    })
    if (candidates.length >= 10) {
      list.append(el('div', CLASS.menuMore, t('menu.more', { count: 10 })))
    }
    setActive(0)
  }

  const setActive = (index: number): void => {
    active = Math.max(0, Math.min(index, candidates.length - 1))
    const rows = list.querySelectorAll<HTMLElement>(`.${CLASS.menuRow}`)
    rows.forEach((row, i) => {
      row.classList.toggle(CLASS.menuRowActive, i === active)
      if (i === active) row.scrollIntoView({ block: 'nearest' })
    })
  }

  buildList()

  const actions = el('div', CLASS.menuActions)
  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.className = CLASS.menuPrimary
  cancel.textContent = t('menu.cancel')
  cancel.addEventListener('click', closeRewindMenu)
  actions.append(cancel)

  root.append(
    el('div', CLASS.menuTitle, t('menu.title')),
    el('div', CLASS.menuHint, t('menu.hint')),
    list,
    actions,
  )

  // Position above the composer (bottom-anchored, left-aligned): the menu grows
  // upward from the input, never covering it, like the old guard hint.
  const textarea = document.querySelector<HTMLTextAreaElement>(COMPOSER_SELECTOR)
  const card = textarea?.closest('[data-composer-card]')
  const rect = card instanceof HTMLElement ? card.getBoundingClientRect() : textarea?.getBoundingClientRect()
  if (rect !== undefined) {
    root.style.left = `${Math.round(rect.left)}px`
    root.style.bottom = `${Math.round(window.innerHeight - rect.top + 8)}px`
  }

  document.body.append(root)
  root.focus()

  const onKeyDown = (event: KeyboardEvent): void => {
    if (candidates.length === 0) {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        closeRewindMenu()
      }
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      event.stopPropagation()
      setActive(active + 1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      event.stopPropagation()
      setActive(active - 1)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      const candidate = candidates[active]
      if (candidate !== undefined) pick(candidate, root)
    } else if (/^[1-9]$/.test(event.key)) {
      const index = Number(event.key) - 1
      const candidate = candidates[index]
      if (candidate !== undefined) {
        event.preventDefault()
        event.stopPropagation()
        pick(candidate, root)
      }
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeRewindMenu()
    }
  }

  const onPointerDown = (event: PointerEvent): void => {
    const target = event.target as Node | null
    if (root.contains(target)) return
    closeRewindMenu()
  }

  // Capture phase on document: fires before the harness's React handlers, so
  // the menu owns ↑/↓/Enter/digits while it is open (ArrowUp in the composer
  // is input-history recall — the menu must steal it).
  document.addEventListener('keydown', onKeyDown, true)
  const deferred = setTimeout(() => {
    document.addEventListener('pointerdown', onPointerDown)
  }, 0)

  menuEl = root
  disposeMenu = () => {
    document.removeEventListener('keydown', onKeyDown, true)
    document.removeEventListener('pointerdown', onPointerDown)
    clearTimeout(deferred)
  }
}
