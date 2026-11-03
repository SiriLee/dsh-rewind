/**
 * @vitest-environment jsdom
 *
 * Modes-step probes for `openPopover` (SiriLee/dsh-rewind#26). The background
 * impact probe resolves the "rewind conversation and files" entry: it must
 * ALWAYS settle the step. A failed host preview has to surface the reason — never
 * leave the step showing "checking file changes…" forever with a permanently
 * disabled entry, which is the invisible failure the issue reported.
 *
 * Compilation: typechecked by `tsconfig.client-test.json` (client surface +
 * JSX), excluded from `tsconfig.json` (host, no JSX) — see the neighbouring
 * `client-dom.test.ts` comment.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionFace } from '@deepseek-ai/dsh-api-session-controller/client'
import type { PreviewOutcome } from '../src/client/host-api.ts'
import { closePopover, openPopover, registerComposerFocuser, registerPreviewCall, type PopoverOptions } from '../src/client/popover.ts'
import { CLASS } from '../src/client/styles.ts'

/** A session face with the two reads `openPopover` needs at this level. */
function fakeSession(): SessionFace {
  return {
    sessionId: 's1',
    subscribe: vi.fn(() => () => {}),
    getSnapshot: vi.fn(() => ({ subagent: null })),
  } as unknown as SessionFace
}

/** Translator stub: embeds params so the host-supplied reason stays readable. */
const t = ((key: string, params?: Record<string, unknown>) =>
  params === undefined ? key : `${key}:${String(params['path'] ?? params['message'])}`) as unknown as PopoverOptions['t']

/** Open the durable popover with `preview` as its host query answer. */
function open(preview: () => Promise<PreviewOutcome> = async () => ({ kind: 'success', files: [], backupOff: false })): void {
  registerPreviewCall(() => preview())
  openPopover({
    session: fakeSession(),
    seq: 5,
    time: 0,
    preview: 'hello',
    anchor: document.body,
    t,
    onRewind: () => {},
  })
}

/** Flush the microtask chain of the background impact probe. */
async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

/** The rendered option hints (mode entries) of the current popover step. */
function optionHints(): (string | null | undefined)[] {
  return [...document.querySelectorAll(`.${CLASS.popoverOptionHint}`)].map(node => node.textContent)
}

afterEach(() => {
  closePopover()
  registerPreviewCall(null)
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('openPopover (a failed impact probe settles the modes step)', () => {
  it('shows the host reason when the preview request fails', async () => {
    open(async () => ({ kind: 'error', text: 'owned by subagent routing' }))
    await settle()
    expect(document.querySelector(`.${CLASS.popoverImpact}`)?.textContent)
      .toContain('owned by subagent routing')
    // The step resolved: the code-restore entry is hidden, not left "checking…".
    expect(optionHints()).not.toContain('popover.checking')
  })

  it('keeps the pending entry disabled while the probe is still in flight', () => {
    open(() => new Promise(() => {}))
    expect(optionHints()).toContain('popover.checking')
  })
})

describe('openPopover (the impact step reports checkpointing-off)', () => {
  /** Open, settle a successful preview, then enter the both-mode impact step. */
  async function impactText(files: readonly { path: string; action: 'restore' | 'delete' }[], backupOff: boolean): Promise<string> {
    open(async () => ({ kind: 'success', files, backupOff }))
    await settle()
    const both = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.includes('popover.both'))
    both?.click()
    await settle()
    return document.querySelector(`.${CLASS.popoverImpact}`)?.textContent ?? ''
  }

  it('appends the note when the host reports backupOff', async () => {
    const impact = await impactText([{ path: '/a', action: 'restore' }], true)
    expect(impact).toContain('popover.impact.restore:/a')
    expect(impact).toContain('popover.backupDisabled')
    const note = document.querySelector(`.${CLASS.popoverNote}`)
    expect(note?.textContent).toBe('popover.backupDisabled')
    expect(note?.closest(`.${CLASS.popoverImpact}`)).not.toBeNull()
  })

  it('omits the note when the host does not report it', async () => {
    const impact = await impactText([{ path: '/a', action: 'restore' }], false)
    expect(impact).toContain('popover.impact.restore:/a')
    expect(impact).not.toContain('popover.backupDisabled')
    expect(document.querySelector(`.${CLASS.popoverNote}`)).toBeNull()
  })
})

describe('closePopover (the unload teardown)', () => {
  /** Let the popover's deferred (0ms) listener attachment actually run. */
  const nextTick = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0) })

  /** Whether a document-level ArrowDown is still intercepted by the popover. */
  function stealsArrowDown(): boolean {
    const event = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
    document.dispatchEvent(event)
    return event.defaultPrevented
  }

  it('removes the DOM and stops stealing keys', async () => {
    open()
    await settle()
    await nextTick()
    // Open: the capture-phase handler owns ↑/↓/Esc away from the composer.
    expect(document.querySelector(`.${CLASS.popover}`)).not.toBeNull()
    expect(stealsArrowDown()).toBe(true)

    // The plugin's fiber disposer calls exactly this on unload.
    closePopover()
    expect(document.querySelector(`.${CLASS.popover}`)).toBeNull()
    expect(stealsArrowDown()).toBe(false)
  })

  it('marks the trigger expanded while open and clears it on close', () => {
    open()
    expect(document.body.getAttribute('aria-expanded')).toBe('true')
    closePopover()
    expect(document.body.getAttribute('aria-expanded')).toBe('false')
  })

  it('hands the keyboard back to the composer it took it from', async () => {
    const focus = vi.fn()
    registerComposerFocuser(focus)
    open()
    await settle()
    await nextTick()
    expect(focus).not.toHaveBeenCalled()
    closePopover()
    expect(focus).toHaveBeenCalledTimes(1)
    expect(focus).toHaveBeenCalledWith('s1')
  })

  it('is safe with nothing open and does not throw on a repeat call', () => {
    closePopover()
    closePopover()
    expect(stealsArrowDown()).toBe(false)
  })
})
