/**
 * The rewind mode-selection popover (plain DOM, no React). Step two of the
 * interaction: the target is already fixed (the clicked message); the popover
 * offers the two modes. Choosing "both" first fetches the impact list through
 * the `/rewind preview @seq both` command and shows it before confirming.
 *
 * @module dsh-rewind/client/popover
 */

import type { SessionFace } from '@deepseek-ai/dsh-client-runtime/client'
import type { CommandNode } from '@deepseek-ai/dsh-client-runtime/client'
import type { RewindKey } from './locales.ts'
import { CLASS } from './styles.ts'

type Translate = (key: RewindKey, params?: Record<string, unknown>) => string

export interface PopoverOptions {
  readonly session: SessionFace
  readonly seq: number
  readonly time: number
  readonly preview: string
  /** The button that opened the popover (outside-click ignore target). */
  readonly anchor: HTMLElement
  readonly t: Translate
}

/** The single live popover element, or null when closed. */
let popoverEl: HTMLElement | null = null

let disposeOutside: (() => void) | null = null

/** Close the current popover, if any. */
export function closePopover(): void {
  if (popoverEl !== null) {
    popoverEl.remove()
    popoverEl = null
  }
  if (disposeOutside !== null) {
    disposeOutside()
    disposeOutside = null
  }
}

/** Format the target line (seq · HH:MM · preview). */
function formatTarget(seq: number, time: number, preview: string): string {
  const d = new Date(time)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const previewText = preview.length > 0 ? preview : '(no text)'
  return `seq ${seq} · ${hh}:${mm} · ${previewText}`
}

/** Find the newest rewind command node matching a predicate. */
function findCommand(snapshot: ReturnType<SessionFace['getSnapshot']>, match: (node: CommandNode) => boolean): CommandNode | undefined {
  let found: CommandNode | undefined
  for (const key of snapshot.chat.order) {
    const node = snapshot.chat.nodes.get(key)
    if (node !== undefined && node.kind === 'command') {
      const command = node.data as CommandNode
      if (match(command)) found = command
    }
  }
  return found
}

/**
 * Resolve the outcome of the newest matching rewind command by watching the
 * session snapshot (command/run + command/done land as one CommandNode).
 * @returns the outcome text-bearing node, or null on timeout.
 */
function waitForCommand(
  session: SessionFace,
  match: (node: CommandNode) => boolean,
  timeoutMs = 8000,
): Promise<{ kind: 'success' | 'error'; text?: string } | null> {
  return new Promise(resolve => {
    let settled = false
    const settle = (value: { kind: 'success' | 'error'; text?: string } | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      unsubscribe()
      resolve(value)
    }
    const check = (): void => {
      const node = findCommand(session.getSnapshot(), match)
      if (node?.outcome !== null && node?.outcome !== undefined) {
        settle({ kind: node.outcome.kind, text: node.outcome.text })
      }
    }
    const unsubscribe = session.subscribe(check)
    const timer = setTimeout(() => settle(null), timeoutMs)
    check()
  })
}

/** Element factory helpers (kept local so no framework is involved). */
function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag)
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function modeOption(label: string, hint: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = CLASS.popoverOption
  const labelEl = el('span', CLASS.popoverOptionLabel, label)
  const hintEl = el('span', CLASS.popoverOptionHint, hint)
  button.append(labelEl, hintEl)
  button.addEventListener('click', onClick)
  return button
}

/** Render the impact step: fetch the preview outcome, then confirm/back. */
function renderImpactStep(root: HTMLElement, opts: PopoverOptions, back: () => void): void {
  const { session, seq, t } = opts
  const impact = el('div', CLASS.popoverImpact, t('popover.impact.loading'))
  const actions = el('div', CLASS.popoverActions)
  const backButton = document.createElement('button')
  backButton.type = 'button'
  backButton.className = CLASS.popoverGhost
  backButton.textContent = t('popover.back')
  backButton.addEventListener('click', back)
  actions.append(backButton)

  const confirm = document.createElement('button')
  confirm.type = 'button'
  confirm.className = CLASS.popoverPrimary
  confirm.textContent = t('popover.confirm')
  confirm.disabled = true
  actions.append(confirm)
  root.replaceChildren(impact, actions)

  let outcome: { kind: 'success' | 'error'; text?: string } | null = null
  void (async () => {
    const result = await session.command(`/rewind preview @${seq} both`)
    if (!result.ok || result.value?.matched !== true) {
      impact.textContent = t('popover.impact.failed', {
        message: result.ok ? 'command not matched' : (result.error?.message ?? 'unknown error'),
      })
      return
    }
    outcome = await waitForCommand(
      session,
      node => {
        const args = node.args ?? ''
        return node.name === 'rewind' && args.includes('preview') && args.includes(`@${seq}`)
      },
    )
    if (outcome === null) {
      impact.textContent = t('popover.impact.failed', { message: 'timeout' })
      return
    }
    if (outcome.kind === 'error') {
      impact.textContent = t('popover.impact.failed', { message: outcome.text ?? 'unknown error' })
      return
    }
    impact.textContent = outcome.text ?? t('popover.impact.none')
    confirm.disabled = false
    confirm.addEventListener('click', () => {
      closePopover()
      void session.command(`/rewind @${seq} both`)
    })
  })().catch(() => {
    impact.textContent = t('popover.impact.failed', { message: 'unexpected error' })
  })
}

/** Open the mode-selection popover anchored near the given button. */
export function openPopover(opts: PopoverOptions): void {
  closePopover()
  const { session, seq, time, preview, anchor, t } = opts

  const root = el('div', CLASS.popover)
  root.setAttribute('role', 'dialog')
  root.setAttribute('aria-label', t('popover.title'))
  root.append(
    el('div', CLASS.popoverTitle, t('popover.title')),
    el('div', CLASS.popoverTarget, formatTarget(seq, time, preview)),
  )

  const renderModes = (): void => {
    root.replaceChildren(
      el('div', CLASS.popoverTitle, t('popover.title')),
      el('div', CLASS.popoverTarget, formatTarget(seq, time, preview)),
      modeOption(t('popover.chat'), t('popover.chat.hint'), () => {
        closePopover()
        void session.command(`/rewind @${seq} chat`)
      }),
      modeOption(t('popover.both'), t('popover.both.hint'), () => {
        renderImpactStep(root, opts, renderModes)
      }),
      (() => {
        const actions = el('div', CLASS.popoverActions)
        const cancel = document.createElement('button')
        cancel.type = 'button'
        cancel.className = CLASS.popoverGhost
        cancel.textContent = t('popover.cancel')
        cancel.addEventListener('click', closePopover)
        actions.append(cancel)
        return actions
      })(),
    )
  }
  renderModes()
  document.body.append(root)

  // Position: below the anchor, right-aligned; flip above near the viewport edge.
  const rect = anchor.getBoundingClientRect()
  const gap = 4
  const height = root.offsetHeight
  const top = rect.bottom + gap + height <= window.innerHeight - 8
    ? rect.bottom + gap
    : Math.max(8, rect.top - gap - height)
  root.style.top = `${Math.round(top)}px`
  root.style.left = `${Math.round(Math.min(rect.right, window.innerWidth - 8 - root.offsetWidth))}px`

  popoverEl = root

  const onPointerDown = (event: PointerEvent): void => {
    const target = event.target as Node | null
    if (root.contains(target) || anchor.contains(target)) return
    closePopover()
  }
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') closePopover()
  }
  // Defer the first outside-click check so the opening click is not swallowed.
  const deferred = setTimeout(() => {
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
  }, 0)
  disposeOutside = () => {
    clearTimeout(deferred)
    document.removeEventListener('pointerdown', onPointerDown)
    document.removeEventListener('keydown', onKeyDown)
  }
}
