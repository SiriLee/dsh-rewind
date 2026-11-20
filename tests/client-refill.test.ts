/**
 * @vitest-environment jsdom
 *
 * Composer-refill probes for the v1 rewind flow (`runRewindAndFill`): the
 * preview/commit sequence, refill from `preview.withdraw`, image restore, the
 * empty-draft guard, and code-based failure hints. The transport is a stubbed
 * `fetch`; the session face and composer are hand fakes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionFace } from '@deepseek-ai/dsh-api-session-controller/client'
import { runRewindAndFill } from '../src/client/rewind-flow.ts'
import type { PreviewValue } from '../src/client/host-api.ts'
import { CLASS } from '../src/client/styles.ts'

const TEXT = 'hello world'
const IMAGE = {
  attachmentId: 'sha256:abc',
  mediaType: 'image/png',
  bytes: 12,
  width: 3,
  height: 4,
  name: 'shot.png',
}

function previewValue(overrides: Partial<PreviewValue> = {}): PreviewValue {
  return {
    headSeq: 11,
    withdraw: { text: TEXT, attachments: [] },
    files: { available: true, changes: [], skipped: [] },
    ...overrides,
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

interface FetchCall {
  readonly url: string
  readonly body: Record<string, unknown>
}

/** Stub fetch; `preview`/`commit` answer the two contract calls. */
function stubContract(options: {
  preview?: () => Response | Promise<Response>
  commit?: () => Response | Promise<Response>
}): FetchCall[] {
  const calls: FetchCall[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> })
    if (url.endsWith('/preview')) return await (options.preview?.() ?? jsonResponse({ ok: true, value: previewValue() }))
    return await (options.commit?.() ?? jsonResponse({ ok: true, value: { conversation: { rewound: true } } }))
  }))
  return calls
}

/** The fake session face the flow reads. */
function fakeSession(): SessionFace {
  return { sessionId: 's1' } as unknown as SessionFace
}

/** Put a composer element in the DOM and return its current draft text. */
function composer(): HTMLElement {
  const element = document.createElement('div')
  element.setAttribute('data-composer-input', '')
  document.body.append(element)
  return element
}

/** The last rendered status hint. */
function hintText(): string | null {
  return document.querySelector<HTMLElement>(`.${CLASS.guardHint}`)?.textContent ?? null
}

async function run(overrides: {
  seq?: number
  mode?: 'conversation' | 'both'
  mainView?: boolean
  setComposerText?: (sessionId: string, text: string) => boolean
  restoreImages?: (sessionId: string, images: readonly { attachmentId: string }[]) => Promise<void>
  failureText?: (code: string) => string
} = {}): Promise<void> {
  await runRewindAndFill(
    fakeSession(),
    overrides.seq ?? 5,
    overrides.mode ?? 'conversation',
    () => overrides.mainView ?? true,
    overrides.setComposerText ?? vi.fn(() => true),
    overrides.restoreImages,
    overrides.failureText ?? (code => `E:${code}`),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('runRewindAndFill', () => {
  it('previews, commits the bound head, then refills the withdrawn text', async () => {
    composer()
    const calls = stubContract({})
    const setText = vi.fn(() => true)
    await run({ mode: 'both', setComposerText: setText })
    expect(calls.map(call => call.url)).toEqual([
      './api/dsh-rewind/v1/preview',
      './api/dsh-rewind/v1/commit',
    ])
    expect(calls[0]?.body).toEqual({ sessionId: 's1', seq: 5 })
    expect(calls[1]?.body).toEqual({ sessionId: 's1', seq: 5, headSeq: 11, mode: 'both' })
    expect(setText).toHaveBeenCalledWith('s1', TEXT)
    expect(hintText()).toBeNull()
  })

  it('restores images from withdraw.attachments before the text', async () => {
    composer()
    stubContract({
      preview: () => jsonResponse({
        ok: true,
        value: previewValue({
          withdraw: { text: TEXT, attachments: [{ type: 'image', attachment: IMAGE }] },
        }),
      }),
    })
    const restored: Array<readonly { attachmentId: string }[]> = []
    const restoreImages = vi.fn(async (_sessionId: string, images: readonly { attachmentId: string }[]) => {
      restored.push(images)
    })
    await run({ restoreImages })
    expect(restored).toHaveLength(1)
    expect(restored[0]?.[0]?.attachmentId).toBe(IMAGE.attachmentId)
  })

  it('does not clobber an in-progress draft', async () => {
    composer().textContent = 'draft'
    stubContract({})
    const setText = vi.fn(() => true)
    await run({ setComposerText: setText })
    expect(setText).not.toHaveBeenCalled()
  })

  it('does not refill after the user switched sessions', async () => {
    composer()
    stubContract({})
    const setText = vi.fn(() => true)
    await run({ mainView: false, setComposerText: setText })
    expect(setText).not.toHaveBeenCalled()
  })

  it('shows the localized commit failure and leaves the composer alone', async () => {
    composer()
    stubContract({
      commit: () => jsonResponse({
        ok: false,
        error: { code: 'head-changed', message: 'session head is 12, expected 11' },
      }, 409),
    })
    const setText = vi.fn(() => true)
    await run({ setComposerText: setText })
    expect(setText).not.toHaveBeenCalled()
    expect(hintText()).toBe('E:head-changed')
  })

  it('shows the localized preview failure and never commits', async () => {
    composer()
    const calls = stubContract({
      preview: () => jsonResponse({
        ok: false,
        error: { code: 'target-missing', message: 'no user message at seq 5' },
      }, 404),
    })
    const setText = vi.fn(() => true)
    await run({ setComposerText: setText })
    expect(calls).toHaveLength(1)
    expect(setText).not.toHaveBeenCalled()
    expect(hintText()).toBe('E:target-missing')
  })

  it('still refills when a both-mode file effect is unavailable', async () => {
    composer()
    stubContract({
      commit: () => jsonResponse({
        ok: true,
        value: {
          conversation: { rewound: true },
          files: { applied: false, reason: 'no-checkpoint' },
        },
      }),
    })
    const setText = vi.fn(() => true)
    await run({ mode: 'both', setComposerText: setText })
    expect(setText).toHaveBeenCalledWith('s1', TEXT)
  })

  it('turns a transport timeout into a generic hint instead of an unhandled rejection', async () => {
    composer()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('timed out', 'TimeoutError') }))
    const setText = vi.fn(() => true)
    await run({ setComposerText: setText })
    expect(setText).not.toHaveBeenCalled()
    expect(hintText()).toBe('E:internal')
  })
})
