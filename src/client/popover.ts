/**
 * The rewind mode-selection popover (plain DOM, no React). Step two of the
 * interaction: the target is already fixed (the clicked message); the popover
 * offers the two modes. Choosing "both" first fetches the impact list through
 * the `/rewind preview @seq both` command and shows it before confirming.
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

import type { SessionFace, CommandNode } from './dsh-types.ts'
import { hasFileImpact, type ChatOf, type ChatWatch, type HiddenChat } from './hidden.ts'
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
  /**
   * Chat reader on the 0.1.2-rc.1 `uiConversation` "chat" view: the durable
   * variant's command probes scan the chat through it. Unused by the
   * pending-retract variant.
   */
  readonly chatOf: ChatOf
  /**
   * Subscribe to one session's live chat-update signal, so a probe waiting on
   * a command's chat node can be woken when the chat snapshot changes. Passed
   * straight through to `waitForCommand`.
   */
  readonly watchChat: ChatWatch
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

/**
 * Parse the host's machine-readable impact trailer from a preview outcome text
 * (the trailing lines of formatPlan in src/index.ts): `impact=<n>` plus one
 * `restore:<path>` / `delete:<path>` line per file. Locale-independent — the
 * human copy above the trailer is ignored; the popover renders its own
 * localized list from these tokens.
 */
function parseImpactList(text: string): { restores: string[]; deletes: string[] } {
  const restores: string[] = []
  const deletes: string[] = []
  for (const line of text.split('\n')) {
    if (line.startsWith('restore:')) restores.push(line.slice('restore:'.length))
    else if (line.startsWith('delete:')) deletes.push(line.slice('delete:'.length))
  }
  return { restores, deletes }
}

/** Find the newest rewind command node matching a predicate. */
function findCommand(chat: HiddenChat | undefined, match: (node: CommandNode) => boolean): CommandNode | undefined {
  if (chat === undefined) return undefined
  let found: CommandNode | undefined
  for (const key of chat.order) {
    const node = chat.nodes.get(key)
    if (node !== undefined && node.kind === 'command') {
      const command = node.data as CommandNode
      if (match(command)) found = command
    }
  }
  return found
}

/**
 * Seqs of the command nodes currently matching `match`. Sample BEFORE issuing
 * a new command of the same shape so the subsequent wait can exclude them: a
 * repeated preview/rewind of the same target must not settle on the previous
 * command's stale outcome (e.g. an older preview that found file changes,
 * after those changes were already restored).
 */
export function knownCommandSeqs(session: SessionFace, chatOf: ChatOf, match: (node: CommandNode) => boolean): Set<number> {
  const known = new Set<number>()
  const chat = chatOf(session)
  if (chat === undefined) return known
  for (const key of chat.order) {
    const node = chat.nodes.get(key)
    if (node !== undefined && node.kind === 'command') {
      const command = node.data as CommandNode
      if (match(command)) known.add(command.seq)
    }
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
    // The chat-update signal: on 0.1.2-rc.1 the session face's `subscribe` does
    // not fire when the chat snapshot changes (the chat moved to the
    // `uiConversation` view), so the waiting caller passes a watch bound to
    // that view.
    const unsubscribe = watch(check)
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
async function previewImpact(
  session: SessionFace,
  chatOf: ChatOf,
  seq: number,
  watch: (cb: () => void) => () => void,
): Promise<PreviewOutcome> {
  // Exclude preview nodes that already exist: a second popover on the same
  // message must wait for THIS command's node, not settle on the previous
  // preview's outcome (which may predate a restore).
  const known = knownCommandSeqs(session, chatOf, node => isPreviewFor(node, seq))
  const result = await session.command(`/rewind preview @${seq} both`)
  if (!result.ok || result.value?.matched !== true) return null
  return waitForCommand(session, chatOf, node => isPreviewFor(node, seq) && !known.has(node.seq), 8000, watch)
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
  readonly chatOf: ChatOf
  readonly watchChat: ChatWatch
  readonly onRewind: (mode: 'chat' | 'both') => void
}

/**
 * Render the impact step: show the impact outcome, then confirm/back.
 * Reuses the outcome already fetched when the popover opened (the "both"
 * option is only clickable after that fetch settles) — running a second
 * preview command here would re-run the probe and emit a second (now-hidden)
 * command row; a fresh preview is only fetched when the popover-open probe
 * never resolved.
 */
function renderImpactStep(root: HTMLElement, opts: DurablePopoverOptions, back: () => void, cached?: PreviewOutcome): void {
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

  void (async () => {
    const outcome = cached ?? await previewImpact(session, opts.chatOf, seq, cb => opts.watchChat(session.sessionId, cb))
    if (outcome === null) {
      impact.textContent = t('popover.impact.failed', { message: 'preview command failed or timed out' })
      return
    }
    if (outcome.kind === 'error') {
      impact.textContent = t('popover.impact.failed', { message: outcome.text ?? 'unknown error' })
      return
    }
    if (outcome.text === undefined) {
      impact.textContent = t('popover.impact.none')
    } else {
      // Render the localized file list from the host's machine trailer
      // (restore:/delete: lines), never from the host's human copy.
      const { restores, deletes } = parseImpactList(outcome.text)
      if (restores.length === 0 && deletes.length === 0) {
        impact.textContent = t('popover.impact.none')
      } else {
        const lines = [
          ...restores.map(path => t('popover.impact.restore', { path })),
          ...deletes.map(path => t('popover.impact.delete', { path })),
        ]
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
  })
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
  const dispose = (): void => {
    clearTimeout(deferred)
    document.removeEventListener('pointerdown', onPointerDown)
    document.removeEventListener('keydown', onKeyDown, true)
  }

  document.body.append(root)
  position()
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
  // Pending retract variant: a single-confirm dialog, no rewind modes.
  if (opts.retract !== undefined) {
    openRetractPopover(opts)
    return
  }
  const { session, seq, time, preview, anchor, t, chatOf } = opts
  const onRewind = opts.onRewind
  if (seq === undefined || time === undefined || onRewind === undefined) return
  // Narrowed durable identity: the pending variant never reaches this flow.
  const durableOpts: DurablePopoverOptions = { session, seq, time, preview, anchor, t, chatOf, watchChat: opts.watchChat, onRewind }

  const root = el('div', CLASS.popover)
  root.setAttribute('role', 'dialog')
  root.setAttribute('aria-label', t('popover.title'))

  /** Availability of the "rewind conversation and code" mode, resolved from a preview. */
  type BothState =
    | { state: 'loading' }
    | { state: 'hasChanges' }
    | { state: 'noChanges' }
    | { state: 'error'; message: string }
  let bothState: BothState = { state: 'loading' }
  /** Impact outcome fetched at open; reused by the both-step (no second command row). */
  let impactOutcome: PreviewOutcome = null

  /** Current step: Esc acts as cancel on the modes step, as back on impact. */
  let step: 'modes' | 'impact' = 'modes'

  const renderModes = (): void => {
    step = 'modes'
    const children: HTMLElement[] = [
      el('div', CLASS.popoverTitle, t('popover.title')),
      el('div', CLASS.popoverTarget, formatTarget(t, seq, time, preview)),
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
    const actions = el('div', CLASS.popoverActions)
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = CLASS.popoverGhost
    cancel.textContent = t('popover.cancel')
    cancel.addEventListener('click', closePopover)
    actions.append(cancel)
    children.push(actions)
    root.replaceChildren(...children)
    focusFirst(root)
  }

  /** Move to the impact step (its back/Esc returns to the modes step). */
  const renderImpact = (): void => {
    step = 'impact'
    renderImpactStep(root, durableOpts, renderModes, impactOutcome)
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
  popoverEl = root
  disposeOutside = shell.dispose

  // Resolve the "both" mode's availability up front (Claude Code hides the
  // code-restore options when the checkpoint has no tracked file changes).
  // `hasFileImpact` reads only the host's machine-readable `impact=<n>`
  // trailer (locale-independent). An unknown outcome (preview failed/timeout)
  // keeps "both" enabled — degrade to always-shown rather than hiding a
  // working option.
  void (async () => {
    const outcome = await previewImpact(session, chatOf, seq, cb => opts.watchChat(session.sessionId, cb))
    impactOutcome = outcome
    if (outcome !== null && outcome.kind === 'success') {
      bothState = { state: hasFileImpact(outcome.text) ? 'hasChanges' : 'noChanges' }
    } else if (outcome !== null && outcome.kind === 'error') {
      // Surface the host's rejection (e.g. "no longer in the model context
      // (shadowed by compaction)") instead of leaving the modes step stuck on
      // "checking file changes…" with a permanently disabled both entry.
      bothState = { state: 'error', message: outcome.text ?? 'unknown error' }
    }
    renderModes()
    shell.position()
  })().catch(() => {
    bothState = { state: 'hasChanges' }
    renderModes()
    shell.position()
  })
}
