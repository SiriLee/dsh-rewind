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
function formatTarget(t: Translate, seq: number, time: number, preview: string): string {
  const d = new Date(time)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const previewText = preview.length > 0 ? preview : t('popover.noText')
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

/** Outcome of a `/rewind preview` command, or null when it never settled. */
type PreviewOutcome = { kind: 'success' | 'error'; text?: string } | null

/** True for the `/rewind preview @<seq> both` command node of one target. */
function isPreviewFor(node: CommandNode, seq: number): boolean {
  const args = node.args ?? ''
  return node.name === 'rewind' && args.includes('preview') && new RegExp(`(?:^|\\s)@${seq}(?=\\s|$)`).test(args)
}

/**
 * Run `/rewind preview @seq both` and await its outcome. Returns null when the
 * command was not matched or timed out.
 */
async function previewImpact(session: SessionFace, seq: number): Promise<PreviewOutcome> {
  const result = await session.command(`/rewind preview @${seq} both`)
  if (!result.ok || result.value?.matched !== true) return null
  return waitForCommand(session, node => isPreviewFor(node, seq))
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

/**
 * Render the impact step: show the impact outcome, then confirm/back.
 * Reuses the outcome already fetched when the popover opened (the "both"
 * option is only clickable after that fetch settles) — running a second
 * preview command here would duplicate its command row in the transcript; a
 * fresh preview is only fetched when the popover-open probe never resolved.
 */
function renderImpactStep(root: HTMLElement, opts: PopoverOptions, back: () => void, cached?: PreviewOutcome): void {
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

  void (async () => {
    const outcome = cached ?? await previewImpact(session, seq)
    if (outcome === null) {
      impact.textContent = t('popover.impact.failed', { message: 'preview command failed or timed out' })
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

  /** Availability of the "rewind conversation and code" mode, resolved from a preview. */
  type BothState = { state: 'loading' } | { state: 'hasChanges' } | { state: 'noChanges' }
  let bothState: BothState = { state: 'loading' }
  /** Impact outcome fetched at open; reused by the both-step (no second command row). */
  let impactOutcome: PreviewOutcome = null

  const renderModes = (): void => {
    const children: HTMLElement[] = [
      el('div', CLASS.popoverTitle, t('popover.title')),
      el('div', CLASS.popoverTarget, formatTarget(t, seq, time, preview)),
      modeOption(t('popover.chat'), t('popover.chat.hint'), () => {
        closePopover()
        void session.command(`/rewind @${seq} chat`)
      }),
    ]
    if (bothState.state === 'noChanges') {
      // Claude Code shows the code-restore options only when the checkpoint has
      // tracked file changes; a muted note keeps the layout stable.
      children.push(el('div', CLASS.popoverImpact, t('popover.noChanges')))
    } else {
      const option = modeOption(
        t('popover.both'),
        bothState.state === 'loading' ? t('popover.checking') : t('popover.both.hint'),
        () => {
          renderImpactStep(root, opts, renderModes, impactOutcome)
        },
      )
      if (bothState.state === 'loading') option.disabled = true
      children.push(option)
    }
    const actions = el('div', CLASS.popoverActions)
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = CLASS.popoverGhost
    cancel.textContent = t('popover.cancel')
    cancel.addEventListener('click', closePopover)
    actions.append(cancel)
    children.push(actions)
    root.replaceChildren(...children)
  }

  /** Position below the anchor (right-aligned), flipping above near the edge. */
  const position = (): void => {
    const rect = anchor.getBoundingClientRect()
    const gap = 4
    const height = root.offsetHeight
    const top = rect.bottom + gap + height <= window.innerHeight - 8
      ? rect.bottom + gap
      : Math.max(8, rect.top - gap - height)
    root.style.top = `${Math.round(top)}px`
    root.style.left = `${Math.round(Math.min(rect.right, window.innerWidth - 8 - root.offsetWidth))}px`
  }

  renderModes()
  document.body.append(root)
  position()

  // Resolve the "both" mode's availability up front (Claude Code hides the
  // code-restore options when the checkpoint has no tracked file changes).
  // An unknown outcome (preview failed/timeout) keeps "both" enabled — degrade
  // to always-shown rather than hiding a working option.
  const hasFileImpact = (text: string | undefined): boolean => text === undefined || text.includes('将影响')
  void (async () => {
    const outcome = await previewImpact(session, seq)
    impactOutcome = outcome
    if (outcome !== null && outcome.kind === 'success') {
      bothState = { state: hasFileImpact(outcome.text) ? 'hasChanges' : 'noChanges' }
    }
    renderModes()
    position()
  })().catch(() => {
    bothState = { state: 'hasChanges' }
    renderModes()
    position()
  })

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
