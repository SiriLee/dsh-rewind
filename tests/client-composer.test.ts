/**
 * @vitest-environment jsdom
 *
 * Composer-refill probes (SiriLee/dsh-rewind#9). On the 0.1.2 line the
 * composer is a Lexical `contenteditable` div, so the withdrawn target text is
 * written through the harness `setDraft` facade when reachable, else the DOM
 * `contenteditable` fill. These cases pin `fillComposer` / `writeComposer` /
 * `composerText` on that single 0.1.2 channel.
 *
 * Compilation: typechecked by `tsconfig.client-test.json` (client surface +
 * JSX), excluded from `tsconfig.json` (host, no JSX) — see the neighbouring
 * `client-dom.test.ts` comment.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { composerText, fillComposer, writeComposer } from '../src/client/portals.tsx'

/** Build the 0.1.2 `[data-composer-input]` contenteditable div. */
function addEditable(text = ''): HTMLElement {
  const editable = document.createElement('div')
  editable.setAttribute('data-composer-input', '')
  editable.setAttribute('contenteditable', 'true')
  editable.textContent = text
  document.body.appendChild(editable)
  return editable
}

/** Make sure `document.execCommand` exists (jsdom may omit it) and return `ok`. */
function mockExecCommand(ok: boolean) {
  if (typeof document.execCommand !== 'function') {
    Object.defineProperty(document, 'execCommand', { value: () => false, configurable: true })
  }
  return vi.spyOn(document, 'execCommand').mockReturnValue(ok)
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('fillComposer (0.1.2 contenteditable DOM write)', () => {
  it('writes the contenteditable through execCommand insertText', () => {
    const editable = addEditable('old')
    const exec = mockExecCommand(true)
    const ok = fillComposer('rewound text')
    expect(ok).toBe(true)
    expect(exec).toHaveBeenCalledWith('insertText', false, 'rewound text')
    expect(document.activeElement).toBe(editable)
  })

  it('falls back to a direct text write when execCommand is unavailable', () => {
    const editable = addEditable('old')
    mockExecCommand(false)
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

describe('writeComposer (facade-aware write)', () => {
  it('prefers the harness facade setDraft when reachable', () => {
    const setDraft = vi.fn()
    const ok = writeComposer('rewound text', { setDraft })
    expect(ok).toBe(true)
    expect(setDraft).toHaveBeenCalledTimes(1)
    expect(setDraft).toHaveBeenCalledWith('rewound text')
  })

  it('degrades to the DOM channel when no facade is given', () => {
    const editable = addEditable()
    // execCommand fails -> the contenteditable path writes textContent directly.
    mockExecCommand(false)
    const ok = writeComposer('rewound text', undefined)
    expect(ok).toBe(true)
    expect(editable.textContent).toBe('rewound text')
  })

  it('degrades to the DOM channel when the facade throws (session teardown)', () => {
    const editable = addEditable()
    mockExecCommand(false)
    const ok = writeComposer('rewound text', { setDraft: () => { throw new Error('teardown') } })
    expect(ok).toBe(true)
    expect(editable.textContent).toBe('rewound text')
  })
})

describe('composerText (0.1.2 draft read)', () => {
  it('reads the contenteditable textContent', () => {
    addEditable('draft')
    expect(composerText()).toBe('draft')
  })

  it('returns empty when the composer is absent', () => {
    expect(composerText()).toBe('')
  })
})
