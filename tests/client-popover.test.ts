/**
 * @vitest-environment jsdom
 *
 * Modes-step probes for `openPopover` (SiriLee/dsh-rewind#26). The background
 * impact probe resolves the "rewind conversation and code" entry: it must
 * ALWAYS settle the step. A rejected admission (`ok:false`, e.g. a
 * subagent-owned identity) or an unmatched command line has to surface the
 * reason — never leave the step showing "checking file changes…" forever with
 * a permanently disabled entry, which is the invisible failure the issue
 * reported.
 *
 * Compilation: typechecked by `tsconfig.client-test.json` (client surface +
 * JSX), excluded from `tsconfig.json` (host, no JSX) — see the neighbouring
 * `client-dom.test.ts` comment.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionFace } from '@deepseek-ai/dsh-api-session-controller/client'
import { closePopover, openPopover, type PopoverOptions } from '../src/client/popover.ts'
import { CLASS } from '../src/client/styles.ts'

/** A session face whose `command` resolves to `result` (or never, for `null`). */
function fakeSession(result: unknown): SessionFace {
  return {
    sessionId: 's1',
    command: vi.fn(() => (result === 'pending' ? new Promise(() => {}) : Promise.resolve(result))),
    subscribe: vi.fn(() => () => {}),
    getSnapshot: vi.fn(() => ({ subagent: null })),
  } as unknown as SessionFace
}

/** Translator stub: embeds params so the host-supplied reason stays readable. */
const t = ((key: string, params?: Record<string, unknown>) =>
  params === undefined ? key : `${key}:${String(params['message'])}`) as unknown as PopoverOptions['t']

/** Open the durable popover against `session` (no DOM rows needed). */
function open(session: SessionFace): void {
  openPopover({
    session,
    seq: 5,
    time: 0,
    preview: 'hello',
    chatOf: () => undefined,
    watchChat: () => () => {},
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
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('openPopover (a failed impact probe settles the modes step)', () => {
  it('shows the host reason when the host rejects the preview command (ok:false)', async () => {
    const warn = vi.spyOn(console, 'warn').mockReturnValue(undefined)
    const session = fakeSession({
      ok: false,
      error: { code: 'session/agent-busy', message: 'owned by subagent routing', details: {} },
    })
    open(session)
    await settle()
    expect(document.querySelector(`.${CLASS.popoverImpact}`)?.textContent)
      .toContain('session/agent-busy: owned by subagent routing')
    // The step resolved: the code-restore entry is hidden, not left "checking…".
    expect(optionHints()).not.toContain('popover.checking')
    expect(warn).toHaveBeenCalled()
  })

  it('shows a reason when the command line is not matched by the host', async () => {
    const warn = vi.spyOn(console, 'warn').mockReturnValue(undefined)
    open(fakeSession({ ok: true, value: { matched: false } }))
    await settle()
    expect(document.querySelector(`.${CLASS.popoverImpact}`)?.textContent)
      .toContain('the rewind command is not registered on this host')
    expect(optionHints()).not.toContain('popover.checking')
    expect(warn).toHaveBeenCalled()
  })

  it('keeps the pending entry disabled while the probe is still in flight', () => {
    open(fakeSession('pending'))
    expect(optionHints()).toContain('popover.checking')
  })
})
