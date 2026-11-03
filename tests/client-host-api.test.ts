/**
 * Transport probes for the two read-only host queries: request shape
 * (document-relative URL, flat JSON) and the outcome mapping the popover and
 * picker rely on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { candidatesOverApi, previewOverApi } from '../src/client/host-api.ts'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** Stub the browser fetch carrier and return the mock for call assertions. */
function stubFetch(
  impl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): ReturnType<typeof vi.fn> {
  const mock = vi.fn(impl)
  vi.stubGlobal('fetch', mock)
  return mock
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockReturnValue(undefined)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('previewOverApi', () => {
  it('posts the flat query payload to the document-relative preview route', async () => {
    const fetchMock = stubFetch(async () => jsonResponse({
      ok: true,
      value: { files: [{ path: '/a.txt', action: 'restore' }], uncovered: [], backupOff: false },
    }))

    await expect(previewOverApi('s1', 7)).resolves.toEqual({
      kind: 'success',
      files: [{ path: '/a.txt', action: 'restore' }],
      backupOff: false,
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('./api/dsh-rewind/preview')
    expect(init).toMatchObject({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1', seq: 7 }),
    })
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('keeps the host reason for a business failure', async () => {
    stubFetch(async () => jsonResponse({
      ok: false,
      error: { code: 'rewind/session-not-found', message: 'session s1 is not attached', details: {} },
    }))

    await expect(previewOverApi('s1', 7)).resolves.toEqual({
      kind: 'error',
      text: 'session s1 is not attached',
    })
  })

  it('reports a non-2xx response as a transport failure', async () => {
    stubFetch(async () => new Response('', { status: 405 }))

    await expect(previewOverApi('s1', 7)).resolves.toEqual({
      kind: 'error',
      text: 'transport failure for preview: HTTP 405',
    })
  })

  it('settles a timeout as null, not an error message', async () => {
    stubFetch(async () => { throw new DOMException('timed out', 'TimeoutError') })

    await expect(previewOverApi('s1', 7)).resolves.toBeNull()
  })

  it('rejects a malformed value at the transport boundary', async () => {
    stubFetch(async () => jsonResponse({ ok: true, value: { files: 'no', backupOff: false } }))

    await expect(previewOverApi('s1', 7)).resolves.toEqual({
      kind: 'error',
      text: 'invalid preview response',
    })
  })

  it('rejects a malformed envelope before value mapping', async () => {
    stubFetch(async () => jsonResponse({ nope: true }))

    await expect(previewOverApi('s1', 7)).resolves.toEqual({
      kind: 'error',
      text: 'invalid response for preview',
    })
  })
})

describe('candidatesOverApi', () => {
  it('posts the flat session id and returns the candidate list', async () => {
    const candidates = [{ seq: 4, time: 1_000, preview: 'hello' }]
    const fetchMock = stubFetch(async () => jsonResponse({ ok: true, value: { candidates } }))

    await expect(candidatesOverApi('s1')).resolves.toEqual(candidates)

    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('./api/dsh-rewind/candidates')
    expect(init).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ sessionId: 's1' }),
    })
  })

  it('collapses a business failure, a transport failure and an invalid value to undefined', async () => {
    stubFetch(async () => jsonResponse({
      ok: false,
      error: { code: 'rewind/session-not-found', message: 'missing', details: {} },
    }))
    await expect(candidatesOverApi('s1')).resolves.toBeUndefined()

    stubFetch(async () => new Response('', { status: 500 }))
    await expect(candidatesOverApi('s1')).resolves.toBeUndefined()

    stubFetch(async () => jsonResponse({ ok: true, value: { candidates: [{ seq: 'x' }] } }))
    await expect(candidatesOverApi('s1')).resolves.toBeUndefined()
  })
})
