/**
 * @vitest-environment jsdom
 *
 * Composer-refill probes (SiriLee/dsh-rewind#9). v0.6.1's refill only wrote to
 * the rc.2 `<textarea>`; harness 0.1.2-alpha.1 replaced the composer with a
 * Lexical `contenteditable` div, so the withdrawn target text silently never
 * reached the editor. These cases pin the dual-channel `fillComposer` /
 * `writeComposer` / `composerText` so both channels restore the text and the
 * facade path stays correct.
 *
 * Compilation: typechecked by `tsconfig.client-test.json` (client surface +
 * JSX), excluded from `tsconfig.json` (host, no JSX) — see the neighbouring
 * `client-dom.test.ts` comment.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { composerText, fillComposer, writeComposer } from '../src/client/portals.tsx'

/** Build the rc.2 `<textarea>` inside a `[data-input-scroll]` container. */
function addTextarea(value = ''): HTMLTextAreaElement {
  const scroll = document.createElement('div')
  scroll.setAttribute('data-input-scroll', '')
  const textarea = document.createElement('textarea')
  textarea.value = value
  scroll.appendChild(textarea)
  document.body.appendChild(scroll)
  return textarea
}

/** Build the alpha.1 `[data-composer-input]` contenteditable div. */
function addEditable(text = ''): HTMLElement {
  const editable = document.createElement('div')
  editable.setAttribute('data-composer-input', '')
  editable.setAttribute('contenteditable', 'true')
  editable.textContent = text
  document.body.appendChild(editable)
  return editable
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('fillComposer (dual-channel DOM write)', () => {
  it('writes the rc.2 <textarea> through the native setter, dispatches input, focuses', () => {
    const textarea = addTextarea('old')
    const onInput = vi.fn()
    textarea.addEventListener('input', () => onInput())
    const ok = fillComposer('rewound text')
    expect(ok).toBe(true)
    expect(textarea.value).toBe('rewound text')
    expect(onInput).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(textarea)
  })

  it('writes the alpha.1 contenteditable through execCommand insertText', () => {
    const editable = addEditable('old')
    if (typeof document.execCommand !== 'function') {
      Object.defineProperty(document, 'execCommand', { value: () => false, configurable: true })
    }
    const exec = vi.spyOn(document, 'execCommand').mockReturnValue(true)
    const ok = fillComposer('rewound text')
    expect(ok).toBe(true)
    expect(exec).toHaveBeenCalledWith('insertText', false, 'rewound text')
    expect(document.activeElement).toBe(editable)
  })

  it('falls back to a direct text write when execCommand is unavailable', () => {
    const editable = addEditable('old')
    if (typeof document.execCommand !== 'function') {
      Object.defineProperty(document, 'execCommand', { value: () => false, configurable: true })
    }
    vi.spyOn(document, 'execCommand').mockReturnValue(false)
    const onInput = vi.fn()
    editable.addEventListener('input', () => onInput())
    const ok = fillComposer('rewound text')
    expect(ok).toBe(true)
    expect(editable.textContent).toBe('rewound text')
    expect(onInput).toHaveBeenCalledTimes(1)
  })

  it('throws nothing and returns false when no composer exists', () => {
    expect(fillComposer('x')).toBe(false)
  })
})

describe('writeComposer (facade-aware dual channel)', () => {
  it('prefers the harness facade setDraft when reachable', () => {
    const setDraft = vi.fn()
    const ok = writeComposer('rewound text', { setDraft })
    expect(ok).toBe(true)
    expect(setDraft).toHaveBeenCalledTimes(1)
    expect(setDraft).toHaveBeenCalledWith('rewound text')
  })

  it('degrades to the DOM channel when no facade is given', () => {
    const textarea = addTextarea()
    const ok = writeComposer('rewound text', undefined)
    expect(ok).toBe(true)
    expect(textarea.value).toBe('rewound text')
  })

  it('degrades to the DOM channel when the facade throws (session teardown)', () => {
    const textarea = addTextarea()
    const ok = writeComposer('rewound text', { setDraft: () => { throw new Error('teardown') } })
    expect(ok).toBe(true)
    expect(textarea.value).toBe('rewound text')
  })
})

describe('composerText (dual-channel draft read)', () => {
  it('reads the rc.2 textarea value', () => {
    addTextarea('draft')
    expect(composerText()).toBe('draft')
  })

  it('reads the alpha.1 contenteditable textContent', () => {
    addEditable('draft')
    expect(composerText()).toBe('draft')
  })

  it('returns empty when the composer is absent', () => {
    expect(composerText()).toBe('')
  })
})
