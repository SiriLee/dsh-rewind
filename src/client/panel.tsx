/**
 * The rewind popover panel: the target line, the mode rows, the impact step,
 * and the retract variant — all rendered through the harness's own `Menu`
 * primitive, which owns the whole keyboard contract (↑↓/Home/End walk, Enter,
 * Escape, Tab/Shift+Tab, outside click, window blur) and marks the card
 * `role="menu"` so the shell's modal scoping sees it.
 *
 * The plugin therefore defines NO shortcut of its own. The only focus the panel
 * asks for is the deliberate one the shell documents for command surfaces:
 * closing hands the keyboard back to the composer (the client plugin's
 * `composerFocuser`), never to the trigger — the anchor here is an empty span
 * placed by `getAnchorRect`, so `Menu`'s own trigger refocus is a no-op.
 *
 * Also owns the command-wait helpers the panel needs (`knownCommandSeqs`,
 * `waitForCommand`) and the `/rewind preview` probe; `popover.ts` re-exports
 * them so the public module path stays `./popover.ts`.
 *
 * @module dsh-rewind/client/panel
 */

import { useEffect, useRef, useState, type ReactElement } from 'react'
import { Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionFace } from '@deepseek-ai/dsh-api-session-controller/client'
import type { CommandNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { hasFileImpact, type ChatOf, type ChatWatch, type HiddenChat } from './hidden.ts'
import { rewindLog } from './log.ts'
import type { RewindKey } from './locales.ts'
import { CLASS } from './styles.ts'

export type Translate = (key: RewindKey, params?: Record<string, unknown>) => string

/** Outcome of a `/rewind preview` command, or null when it never settled. */
export type PreviewOutcome = { kind: 'success' | 'error'; text?: string } | null

/** Sentinel for "the open probe never settled", distinct from a resolved null. */
const UNSET = Symbol('unset')

/** Availability of the "rewind conversation and code" mode. */
type BothState =
  | { state: 'loading' }
  | { state: 'hasChanges' }
  | { state: 'noChanges' }
  | { state: 'error'; message: string }

export interface RewindPanelProps {
  readonly session: SessionFace
  /** Durable variant: the target message seq (mode-selection flow). */
  readonly seq?: number
  /** Durable variant: the target message time. */
  readonly time?: number
  /** Pending variant: retract a pre-sent steering message (single-confirm flow). */
  readonly retract?: { readonly itemId: string; readonly text: string | null }
  /** Pending variant: executed after the retract confirm closes the panel. */
  readonly onRetract?: () => void
  readonly preview: string
  readonly chatOf: ChatOf
  readonly watchChat: ChatWatch
  /** The control that opened the panel: positioning anchor and outside-click exclusion. */
  readonly anchor: HTMLElement
  readonly t: Translate
  /** Execute one rewind in the given mode; the panel closes first. */
  readonly onRewind?: (mode: 'chat' | 'both') => void
  /** Close the panel and return the keyboard to the composer. */
  readonly onClose: () => void
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
 * Seqs of the command nodes currently matching `match`. Sampled BEFORE issuing
 * a new command of the same shape so the subsequent wait can exclude them: a
 * repeated preview/rewind of the same target must not settle on the previous
 * command's stale outcome.
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
    const unsubscribe = watch(check)
    const timer = setTimeout(() => settle(null), timeoutMs)
    check()
  })
}

/** True for the `/rewind preview @<seq> both` command node of one target. */
function isPreviewFor(node: CommandNode, seq: number): boolean {
  const args = node.args ?? ''
  return node.name === 'rewind' && args.includes('preview') && new RegExp(`(?:^|\\s)@${seq}(?=\\s|$)`).test(args)
}

/**
 * Run `/rewind preview @seq both` and await its outcome.
 *
 * `null` means ONLY "admitted but never settled" (the outcome wait timed out).
 * An ADMISSION failure is a settled error outcome carrying the reason: the call
 * was rejected before any handler ran (e.g. `session/agent-busy` for a
 * subagent-owned identity) or no handler matched the line. Reporting those as
 * `null` left the modes step stuck on "checking file changes…" with a
 * permanently disabled code-restore entry and the cause invisible
 * (SiriLee/dsh-rewind#26).
 */
async function previewImpact(
  session: SessionFace,
  chatOf: ChatOf,
  seq: number,
  watch: (cb: () => void) => () => void,
): Promise<PreviewOutcome> {
  const known = knownCommandSeqs(session, chatOf, node => isPreviewFor(node, seq))
  let result: Awaited<ReturnType<SessionFace['command']>>
  try {
    result = await session.command(`/rewind preview @${seq} both`)
  } catch (error) {
    rewindLog.warn('preview', `preview command threw for @${seq}`, error)
    return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
  }
  if (!result.ok) {
    rewindLog.warn('preview', `preview command rejected for @${seq}`, result.error)
    return { kind: 'error', text: `${result.error.code}: ${result.error.message}` }
  }
  if (result.value?.matched !== true) {
    rewindLog.warn('preview', `preview command was not matched for @${seq}`)
    return { kind: 'error', text: 'the rewind command is not registered on this host' }
  }
  return waitForCommand(session, chatOf, node => isPreviewFor(node, seq) && !known.has(node.seq), 8000, watch)
}

/** Format the target line (seq · HH:MM · preview). */
function formatTarget(t: Translate, seq: number, time: number, preview: string): string {
  const d = new Date(time)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `seq ${seq} · ${hh}:${mm} · ${preview.length > 0 ? preview : t('popover.noText')}`
}

/**
 * Parse the host's machine-readable impact trailer (`impact=<n>` plus one
 * `restore:<path>` / `delete:<path>` line per file) and render the localized
 * list. Locale-independent — the host's human copy is ignored.
 */
function impactCopy(t: Translate, outcome: PreviewOutcome): string {
  if (outcome === null) return t('popover.impact.failed', { message: 'preview command failed or timed out' })
  if (outcome.kind === 'error') return t('popover.impact.failed', { message: outcome.text ?? 'unknown error' })
  if (outcome.text === undefined) return t('popover.impact.none')
  const restores: string[] = []
  const deletes: string[] = []
  for (const line of outcome.text.split('\n')) {
    if (line.startsWith('restore:')) restores.push(line.slice('restore:'.length))
    else if (line.startsWith('delete:')) deletes.push(line.slice('delete:'.length))
  }
  if (restores.length === 0 && deletes.length === 0) return t('popover.impact.none')
  return [
    ...restores.map(path => t('popover.impact.restore', { path })),
    ...deletes.map(path => t('popover.impact.delete', { path })),
  ].join('\n')
}

/** One mode row: a `role="menuitem"` button the Menu's keyboard walk reaches. */
function PanelRow({ label, hint, disabled = false, onSelect, className }: {
  readonly label: string
  readonly hint: string
  readonly disabled?: boolean
  readonly onSelect: () => void
  readonly className?: string
}): ReactElement {
  return (
    <button type="button" role="menuitem" disabled={disabled}
      className={className ?? CLASS.popoverOption} onClick={onSelect}>
      <span className={CLASS.popoverOptionLabel}>{label}</span>
      <span className={CLASS.popoverOptionHint}>{hint}</span>
    </button>
  )
}

/**
 * The panel body. Mounted per open by `openPopover`; unmounting is the close.
 * @param props - panel identity, anchor, translator, and the two completions.
 * @returns the harness `Menu` carrying this panel's content.
 */
export function RewindPanel(props: RewindPanelProps): ReactElement {
  const { t, anchor, onClose, retract, onRetract, onRewind } = props
  // The one-shot probe reads the FIRST render's identity: re-renders never
  // re-run it, matching the imperative panel's per-open probe.
  const first = useRef(props)
  const cached = useRef<PreviewOutcome | typeof UNSET>(UNSET)
  const [both, setBoth] = useState<BothState>({ state: 'loading' })
  const [step, setStep] = useState<'modes' | 'impact'>('modes')
  const [impactBody, setImpactBody] = useState<string | null>(null)
  const [impactReady, setImpactReady] = useState(false)
  const confirmRef = useRef<HTMLButtonElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)

  // The anchor is an empty span, so the Menu's keyboard guard (`the menu owns
  // the keyboard when it holds a row or sits on its anchor region`) passes only
  // once a row holds focus: without this the arrow walk and Enter do nothing
  // while Escape still closes. Claim the first enabled row one microtask late —
  // the caller that opened the panel (the command shell) restores the composer's
  // focus as it dismisses, and the panel must win.
  useEffect(() => {
    const host = contentRef.current
    if (host === null) return
    queueMicrotask(() => {
      if (!host.isConnected) return
      const active = document.activeElement
      if (active instanceof HTMLElement && host.contains(active)) return
      host.querySelector<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')?.focus()
    })
  }, [step])

  useEffect(() => {
    const p = first.current
    if (p.retract !== undefined || p.seq === undefined) return
    let cancelled = false
    void previewImpact(p.session, p.chatOf, p.seq, cb => p.watchChat(p.session.sessionId, cb))
      .then((outcome) => {
        if (cancelled) return
        cached.current = outcome
        setBoth(outcome !== null && outcome.kind === 'success'
          ? { state: hasFileImpact(outcome.text) ? 'hasChanges' : 'noChanges' }
          : { state: 'error', message: outcome?.text ?? 'preview command timed out' })
      })
      .catch(() => {
        if (!cancelled) setBoth({ state: 'error', message: 'unexpected error' })
      })
    return () => { cancelled = true }
  }, [])

  // The impact step reuses the open probe; a fresh one runs only when that
  // probe never settled (a second preview would emit another hidden row).
  useEffect(() => {
    if (step !== 'impact' || impactReady) return
    const p = first.current
    let cancelled = false
    void (async () => {
      const outcome = cached.current === UNSET && p.seq !== undefined
        ? await previewImpact(p.session, p.chatOf, p.seq, cb => p.watchChat(p.session.sessionId, cb))
        : cached.current === UNSET ? null : cached.current
      if (cancelled) return
      setImpactBody(impactCopy(t, outcome))
      setImpactReady(true)
    })().catch(() => {
      if (!cancelled) {
        setImpactBody(t('popover.impact.failed', { message: 'unexpected error' }))
        setImpactReady(true)
      }
    })
    return () => { cancelled = true }
  }, [step, impactReady, t])

  // The confirm is the impact step's only action; focus it as it becomes
  // enabled so a direct Enter confirms (native row activation).
  useEffect(() => {
    if (step === 'impact' && impactReady) confirmRef.current?.focus()
  }, [step, impactReady])

  const enterImpact = (): void => {
    const current = cached.current
    setImpactReady(current !== UNSET)
    setImpactBody(current === UNSET ? null : impactCopy(t, current))
    setStep('impact')
  }

  const target = props.preview.length > 0 ? props.preview : t('popover.noText')
  const header = (
    <>
      <div className={CLASS.popoverTitle}>{retract === undefined ? t('popover.title') : t('popover.retract.title')}</div>
      <div className={CLASS.popoverTarget}>
        {retract === undefined
          ? props.seq !== undefined && props.time !== undefined ? formatTarget(t, props.seq, props.time, props.preview) : ''
          : t('popover.retract.target', { preview: target })}
      </div>
    </>
  )

  const close = (then?: () => void): void => {
    onClose()
    then?.()
  }

  const body = retract !== undefined
    ? (
      <>
        {header}
        <div className={CLASS.popoverImpact}>{t('popover.retract.hint')}</div>
        <div className={CLASS.popoverActions}>
          <button type="button" role="menuitem" className={CLASS.popoverPrimary}
            onClick={() => { close(onRetract) }}>{t('popover.retract.confirm')}</button>
          <button type="button" role="menuitem" className={CLASS.popoverGhost}
            onClick={() => { close() }}>{t('popover.cancel')}</button>
        </div>
      </>
    )
    : step === 'modes'
      ? (
        <>
          {header}
          <PanelRow label={t('popover.chat')} hint={t('popover.chat.hint')}
            onSelect={() => { close(() => { onRewind?.('chat') }) }} />
          {both.state === 'noChanges' || both.state === 'error'
            ? <div className={CLASS.popoverImpact}>{both.state === 'noChanges' ? t('popover.noChanges') : t('popover.impact.failed', { message: both.message })}</div>
            : (
              <PanelRow label={t('popover.both')}
                hint={both.state === 'loading' ? t('popover.checking') : t('popover.both.hint')}
                disabled={both.state === 'loading'} onSelect={enterImpact} />
            )}
          <div className={CLASS.popoverActions}>
            <button type="button" role="menuitem" className={CLASS.popoverGhost}
              onClick={() => { close() }}>{t('popover.cancel')}</button>
          </div>
        </>
      )
      : (
        <>
          {header}
          <div className={CLASS.popoverImpact}>{impactBody ?? t('popover.impact.loading')}</div>
          <div className={CLASS.popoverActions}>
            <button type="button" role="menuitem" className={CLASS.popoverGhost}
              onClick={() => { setStep('modes') }}>{t('popover.back')}</button>
            <button type="button" role="menuitem" ref={confirmRef} disabled={!impactReady}
              className={CLASS.popoverPrimary}
              onClick={() => { close(() => { onRewind?.('both') }) }}>{t('popover.confirm')}</button>
          </div>
        </>
      )

  return (
    <Menu
      open
      anchor={<span />}
      portal
      autoFocus
      listClassName={CLASS.popover}
      getAnchorRect={() => anchor.isConnected ? anchor.getBoundingClientRect() : null}
      onClose={onClose}
    >
      {<div ref={contentRef}>{body}</div>}
    </Menu>
  )
}
