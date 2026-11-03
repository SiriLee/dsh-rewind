/**
 * The rewind mode-selection popover (plain DOM, no React). Step two of the
 * interaction: the target is already fixed (the clicked message); the popover
 * offers the two modes. Choosing "both" fetches the impact list over the host
 * `/api` preview route and shows it before confirming.
 *
 * Keyboard: ↑/↓ move focus across the step's ACTION buttons only (the two
 * modes, or the confirm button on the impact step), Enter activates the
 * focused button (native), Esc is the keyboard twin of the ghost back/cancel
 * buttons — cancel on the modes step, back on the impact step; the ghosts are
 * never in the arrow cycle. The listener runs in the document capture phase
 * so the keys are stolen from the composer while the popover is open.
 *
 * @module dsh-rewind/client/popover
 */

import type { SessionFace } from '@deepseek-ai/dsh-api-session-controller/client'
import type { CommandNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { chatNodesOf, type ChatOf, type ChatWatch, type HiddenChat } from './hidden.ts'
import type { PreviewCall, PreviewOutcome } from './host-api.ts'
import type { RewindKey } from './locales.ts'
import { CLASS } from './styles.ts'

type Translate = (key: RewindKey, params?: Record<string, unknown>) => string

export interface PopoverOptions {
  readonly session: SessionFace
  /** Durable variant: the target message seq (mode-selection flow). */
  readonly seq?: number
  /** Durable variant: the target message time. */
  readonly time?: number
  /** Pending variant: retract a pre-sent steering message (single-confirm flow). */
  readonly retract?: { readonly itemId: string; readonly text: string | null }
  /** Pending variant: executed after the retract confirm closes the popover. */
  readonly onRetract?: () => void
  readonly preview: string
  /** The button that opened the popover (outside-click ignore target). */
  readonly anchor: HTMLElement
  readonly t: Translate
  /**
   * Execute one rewind in the given mode. The popover closes itself first;
   * the callback owns the command + composer-refill lifecycle (see
   * runRewindAndFill in index.ts).
   */
  readonly onRewind?: (mode: 'chat' | 'both') => void
}

/** The single live popover element, or null when closed. */
let popoverEl: HTMLElement | null = null

/** The trigger of the live popover, so its `aria-expanded` can be cleared. */
let popoverAnchor: HTMLElement | null = null

let disposeOutside: (() => void) | null = null

/** The session whose popover currently holds the keyboard, or null. */
let liveSessionId: string | null = null

/** The plugin's composer focus channel; the harness's own `focusComposer` shape. */
let composerFocuser: ((sessionId: string) => void) | null = null

/**
 * Register the composer focus channel (called once by the client plugin).
 * @param focus - returns the keyboard to one session's composer, caret included.
 */
export function registerComposerFocuser(focus: (sessionId: string) => void): void {
  composerFocuser = focus
}

/** Announce that `anchor` now owns the popover. */
function markOpen(anchor: HTMLElement): void {
  popoverAnchor = anchor
  anchor.setAttribute('aria-expanded', 'true')
}

/** Clear the trigger's expanded state; safe when nothing is open. */
function markClosed(): void {
  popoverAnchor?.setAttribute('aria-expanded', 'false')
  popoverAnchor = null
}

/** Close the current popover, if any, handing the keyboard back to its composer. */
export function closePopover(): void {
  if (popoverEl !== null) {
    popoverEl.remove()
    popoverEl = null
  }
  if (disposeOutside !== null) {
    disposeOutside()
    disposeOutside = null
  }
  markClosed()
  const sessionId = liveSessionId
  liveSessionId = null
  if (sessionId !== null) {
    try {
      composerFocuser?.(sessionId)
    } catch {
      // Focus is presentation; the popover is already gone.
    }
  }
}

/** Find the newest rewind command node matching a predicate. */
function findCommand(chat: HiddenChat | undefined, match: (node: CommandNode) => boolean): CommandNode | undefined {
  if (chat === undefined) return undefined
  let found: CommandNode | undefined
  // `nodes.values()` includes command rows the visibility layer hid, and its
  // order is store insertion order — not anchor order. Compare seq so a hidden
  // command still settles the wait instead of being missed.
  for (const node of chatNodesOf(chat)) {
    if (node.kind !== 'command') continue
    const command = node.data as CommandNode
    if (!match(command)) continue
    if (found === undefined || command.seq >= found.seq) found = command
  }
  return found
}

/**
 * Seqs of the command nodes currently matching `match`. Sample BEFORE issuing
 * a new command of the same shape so the subsequent wait can exclude them: a
 * repeated rewind of the same target must not settle on the previous command's
 * stale outcome.
 */
export function knownCommandSeqs(session: SessionFace, chatOf: ChatOf, match: (node: CommandNode) => boolean): Set<number> {
  const known = new Set<number>()
  const chat = chatOf(session)
  if (chat === undefined) return known
  for (const node of chatNodesOf(chat)) {
    if (node.kind !== 'command') continue
    const command = node.data as CommandNode
    if (match(command)) known.add(command.seq)
  }
  return known
}

/**
 * Resolve the outcome of the newest matching rewind command by watching the
 * session snapshot (command/run + command/done land as one CommandNode).
 * @returns the outcome text-bearing node, or null on timeout.
 */
export function waitForCommand(
  session: SessionFace,
  chatOf: ChatOf,
  match: (node: CommandNode) => boolean,
  timeoutMs = 8000,
  watch: (cb: () => void) => () => void,
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
      const node = findCommand(chatOf(session), match)
      if (node?.outcome !== null && node?.outcome !== undefined) {
        settle({ kind: node.outcome.kind, text: node.outcome.text })
      }
    }
    // The chat-update signal: the session face's `subscribe` does
    // not fire when the chat snapshot changes (the chat moved to the
    // `uiConversation` view), so the waiting caller passes a watch bound to
    // that view.
    const unsubscribe = watch(check)
    const timer = setTimeout(() => settle(null), timeoutMs)
    check()
  })
}

/** The preview transport before registration and after unload. */
const UNAVAILABLE: PreviewCall = () =>
  Promise.resolve({ kind: 'error', text: 'host query is unavailable' })

/** The registered host call; the unavailable default until apply registers one. */
let previewCall: PreviewCall = UNAVAILABLE

/** Register the host preview call; null restores the unavailable default. */
export function registerPreviewCall(call: PreviewCall | null): void {
  previewCall = call ?? UNAVAILABLE
}

/** Resolve one target's impact through the host preview route. */
function previewImpact(sessionId: string, seq: number): Promise<PreviewOutcome> {
  return previewCall(sessionId, seq)
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
 * The enabled, focusable buttons of the current popover step, in DOM order.
 * The ghost back/cancel buttons are deliberately excluded: they are Esc-only
 * (never in the ↑/↓ cycle).
 */
function focusableButtons(root: HTMLElement): HTMLButtonElement[] {
  return Array.from(root.querySelectorAll<HTMLButtonElement>('button'))
    .filter(button => !button.disabled && !button.classList.contains(CLASS.popoverGhost))
}

/** Focus the first enabled button of the current step (no-op when none). */
function focusFirst(root: HTMLElement): void {
  focusableButtons(root)[0]?.focus()
}

/** Move focus across the step's buttons, wrapping around at the ends. */
function moveFocus(root: HTMLElement, dir: 1 | -1): void {
  const buttons = focusableButtons(root)
  if (buttons.length === 0) return
  const active = document.activeElement
  const index = active instanceof HTMLButtonElement ? buttons.indexOf(active) : -1
  const next = index === -1 ? (dir === 1 ? 0 : buttons.length - 1) : (index + dir + buttons.length) % buttons.length
  buttons[next]?.focus()
}

/** The durable variant's narrowed identity (guarded before the mode flow). */
interface DurablePopoverOptions {
  readonly session: SessionFace
  readonly seq: number
  readonly time: number
  readonly preview: string
  readonly anchor: HTMLElement
  readonly t: Translate
  readonly onRewind: (mode: 'chat' | 'both') => void
}

/**
 * Render the impact step: show the impact outcome, then confirm/back.
 * Reuses the outcome already fetched when the popover opened — running the
 * probe again here would repeat the disk comparison.
 */
function renderImpactStep(root: HTMLElement, opts: DurablePopoverOptions, back: () => void, reposition: () => void, cached?: PreviewOutcome): void {
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
  focusFirst(root)
  reposition()

  void (async () => {
    const outcome = cached ?? await previewImpact(session.sessionId, seq)
    if (outcome === null) {
      impact.textContent = t('popover.impact.failed', { message: 'preview request timed out' })
      return
    }
    if (outcome.kind === 'error') {
      impact.textContent = t('popover.impact.failed', { message: outcome.text })
      return
    }
    const restores = outcome.files.filter(file => file.action === 'restore').map(file => file.path)
    const deletes = outcome.files.filter(file => file.action === 'delete').map(file => file.path)
    if (restores.length === 0 && deletes.length === 0) {
      impact.textContent = t('popover.impact.none')
    } else {
      const lines = [
        ...restores.map(path => t('popover.impact.restore', { path })),
        ...deletes.map(path => t('popover.impact.delete', { path })),
      ]
      if (outcome.backupOff) {
        const list = document.createElement('div')
        list.textContent = lines.join('\n')
        impact.replaceChildren(list, el('div', CLASS.popoverNote, t('popover.backupDisabled')))
      } else {
        impact.textContent = lines.join('\n')
      }
    }
    confirm.disabled = false
    // The confirm is the step's only action; focus it as it becomes enabled
    // so a direct Enter confirms (native button activation).
    confirm.focus()
    confirm.addEventListener('click', () => {
      closePopover()
      opts.onRewind('both')
    })
  })().catch(() => {
    impact.textContent = t('popover.impact.failed', { message: 'unexpected error' })
  }).finally(() => { reposition() })
}

/**
 * One mounted popover shell: append, position, outside-click close, and the
 * capture-phase ↑/↓/Esc keys (Esc is delegated to the caller's handler so the
 * durable flow keeps its step-aware back/cancel behavior).
 */
interface PopoverShell {
  /** Re-run positioning after the content re-renders. */
  readonly position: () => void
  /** Remove the popover and its listeners (closePopover also does this). */
  readonly dispose: () => void
}

/** Mount the shared popover chrome around `root` (durable and pending variants). */
function mountShell(root: HTMLElement, anchor: HTMLElement, onKeyDown: (event: KeyboardEvent) => void): PopoverShell {
  const margin = 12
  const gap = 4

  /** Which side was chosen on open; later movement must not make it jump across. */
  let flippedAbove: boolean | null = null

  /** Position below the anchor (right-aligned), or above when that side fits. */
  const position = (): void => {
    if (!root.isConnected) return
    if (!anchor.isConnected) {
      if (popoverEl === root) closePopover()
      return
    }
    const rect = anchor.getBoundingClientRect()
    const height = root.offsetHeight
    if (flippedAbove === null) {
      flippedAbove = rect.bottom + gap + height > window.innerHeight - margin
    }
    const top = flippedAbove
      ? Math.max(margin, rect.top - gap - height)
      : Math.min(Math.max(margin, rect.bottom + gap), Math.max(margin, window.innerHeight - margin - height))
    root.style.top = `${Math.round(top)}px`
    root.style.left = `${Math.round(Math.max(margin, Math.min(rect.right, window.innerWidth - margin - root.offsetWidth)))}px`
  }

  let frame = 0
  /** Coalesce scroll/resize/observer bursts into one position write per frame. */
  const schedule = (): void => {
    if (typeof requestAnimationFrame !== 'function') {
      position()
      return
    }
    if (frame !== 0) return
    frame = requestAnimationFrame(() => {
      frame = 0
      position()
    })
  }
  /** The impact list scrolls on its own; only page movement moves the anchor. */
  const onScroll = (event: Event): void => {
    if (event.target instanceof Node && root.contains(event.target)) return
    schedule()
  }

  const onPointerDown = (event: PointerEvent): void => {
    const target = event.target as Node | null
    if (root.contains(target) || anchor.contains(target)) return
    closePopover()
  }
  // Capture phase on document: fires before the harness's React handlers, so
  // ↑/↓/Esc are stolen from the composer while the popover is open (ArrowUp
  // is input-history recall). Enter needs no handling: a focused button
  // activates natively.
  const deferred = setTimeout(() => {
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown, true)
  }, 0)

  document.body.append(root)
  position()
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => { schedule() })
  observer?.observe(root)
  window.addEventListener('scroll', onScroll, true)
  window.addEventListener('resize', schedule)

  const dispose = (): void => {
    clearTimeout(deferred)
    document.removeEventListener('pointerdown', onPointerDown)
    document.removeEventListener('keydown', onKeyDown, true)
    window.removeEventListener('scroll', onScroll, true)
    window.removeEventListener('resize', schedule)
    observer?.disconnect()
    if (frame !== 0) cancelAnimationFrame(frame)
  }
  return { position, dispose }
}

/**
 * Open the pending-retract popover: a single-confirm dialog for one pre-sent
 * steering message. No mode selection and no impact preview — the message has
 * never been processed, so there are no files to restore and nothing to
 * choose. Confirm closes the popover and hands off to `onRetract` (the
 * `updateQueue remove` + composer-refill lifecycle in portals.tsx).
 */
function openRetractPopover(opts: PopoverOptions): void {
  closePopover()
  const { preview, anchor, t, retract, onRetract } = opts
  if (retract === undefined || onRetract === undefined) return
  markOpen(anchor)

  const root = el('div', CLASS.popover)
  root.setAttribute('role', 'dialog')
  root.setAttribute('aria-label', t('popover.retract.title'))

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      event.stopPropagation()
      moveFocus(root, 1)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      event.stopPropagation()
      moveFocus(root, -1)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closePopover()
    }
  }

  const previewText = preview.length > 0 ? preview : t('popover.noText')
  const actions = el('div', CLASS.popoverActions)
  const confirm = document.createElement('button')
  confirm.type = 'button'
  confirm.className = CLASS.popoverPrimary
  confirm.textContent = t('popover.retract.confirm')
  confirm.addEventListener('click', () => {
    closePopover()
    onRetract()
  })
  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.className = CLASS.popoverGhost
  cancel.textContent = t('popover.cancel')
  cancel.addEventListener('click', closePopover)
  actions.append(confirm, cancel)
  root.replaceChildren(
    el('div', CLASS.popoverTitle, t('popover.retract.title')),
    el('div', CLASS.popoverTarget, t('popover.retract.target', { preview: previewText })),
    el('div', CLASS.popoverImpact, t('popover.retract.hint')),
    actions,
  )

  const shell = mountShell(root, anchor, onKeyDown)
  popoverEl = root
  disposeOutside = shell.dispose
  focusFirst(root)
}

/** Open the mode-selection popover anchored near the given button. */
export function openPopover(opts: PopoverOptions): void {
  closePopover()
  liveSessionId = opts.session.sessionId
  // Pending retract variant: a single-confirm dialog, no rewind modes.
  if (opts.retract !== undefined) {
    openRetractPopover(opts)
    return
  }
  const { session, seq, time, preview, anchor, t } = opts
  const onRewind = opts.onRewind
  if (seq === undefined || time === undefined || onRewind === undefined) return
  markOpen(anchor)
  // Narrowed durable identity: the pending variant never reaches this flow.
  const durableOpts: DurablePopoverOptions = { session, seq, time, preview, anchor, t, onRewind }

  const root = el('div', CLASS.popover)
  root.setAttribute('role', 'dialog')
  root.setAttribute('aria-label', t('popover.title'))

  /** Availability of the "rewind conversation and files" mode, resolved from a preview. */
  type BothState =
    | { state: 'loading' }
    | { state: 'hasChanges' }
    | { state: 'noChanges' }
    | { state: 'error'; message: string }
  let bothState: BothState = { state: 'loading' }
  /** Impact outcome fetched at open; reused by the both-step. */
  let impactOutcome: PreviewOutcome = null

  /** Current step: Esc acts as cancel on the modes step, as back on impact. */
  let step: 'modes' | 'impact' = 'modes'
  /** Assigned once the shell mounts; the first render runs before that. */
  let reposition = (): void => {}

  const renderModes = (): void => {
    step = 'modes'
    const previewText = preview.length > 0 ? preview : t('popover.noText')
    const children: HTMLElement[] = [
      el('div', CLASS.popoverTitle, t('popover.title')),
      el('div', CLASS.popoverTarget, previewText),
      modeOption(t('popover.chat'), t('popover.chat.hint'), () => {
        closePopover()
        durableOpts.onRewind('chat')
      }),
    ]
    if (bothState.state === 'noChanges') {
      // Claude Code shows the code-restore options only when the checkpoint has
      // tracked file changes; a muted note keeps the layout stable.
      children.push(el('div', CLASS.popoverImpact, t('popover.noChanges')))
    } else if (bothState.state === 'error') {
      // The preview failed (e.g. the target was shadowed by compaction): show
      // the host's reason instead of hanging on "checking…" forever, and keep
      // the both-mode entry hidden — it can never succeed for an unreachable
      // target.
      children.push(el('div', CLASS.popoverImpact, t('popover.impact.failed', { message: bothState.message })))
    } else {
      const option = modeOption(
        t('popover.both'),
        bothState.state === 'loading' ? t('popover.checking') : t('popover.both.hint'),
        renderImpact,
      )
      if (bothState.state === 'loading') option.disabled = true
      children.push(option)
    }
    root.replaceChildren(...children)
    focusFirst(root)
    reposition()
  }

  /** Move to the impact step (its back/Esc returns to the modes step). */
  const renderImpact = (): void => {
    step = 'impact'
    renderImpactStep(root, durableOpts, renderModes, reposition, impactOutcome)
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      event.stopPropagation()
      moveFocus(root, 1)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      event.stopPropagation()
      moveFocus(root, -1)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      // Esc is the keyboard twin of the step's ghost button: cancel on the
      // modes step, back on the impact step.
      if (step === 'impact') renderModes()
      else closePopover()
    }
  }

  renderModes()
  const shell = mountShell(root, anchor, onKeyDown)
  reposition = shell.position
  popoverEl = root
  disposeOutside = shell.dispose

  // Resolve "both" availability up front (Claude Code hides the code-restore
  // options when no tracked file changes exist). EVERY settled probe resolves
  // the modes step: success decides has/no changes, any failure (rejected
  // admission, unmatched line, never-settled wait) becomes the error state that
  // shows the reason and hides the entry — never a step stuck on "checking…".
  void (async () => {
    const outcome = await previewImpact(session.sessionId, seq)
    impactOutcome = outcome
    if (outcome !== null && outcome.kind === 'success') {
      bothState = { state: outcome.files.length > 0 ? 'hasChanges' : 'noChanges' }
    } else {
      // Surface the reason (host rejection — e.g. "no longer in the model
      // context (shadowed by compaction)" — or a never-settled wait) instead
      // of leaving the modes step stuck with a permanently disabled entry.
      bothState = { state: 'error', message: outcome?.kind === 'error' ? outcome.text : 'preview request timed out' }
    }
    renderModes()
  })().catch(() => {
    bothState = { state: 'error', message: 'unexpected error' }
    renderModes()
  })
}
