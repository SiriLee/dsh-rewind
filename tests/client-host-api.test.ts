/**
 * Transport probes for the v1 contract client: exact paths and payloads, the
 * success envelope mapping, and the stable failure codes the callers branch on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { candidatesOverApi, commitOverApi, healthOverApi, previewOverApi } from '../src/client/host-api.ts'

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

const previewValue = {
  headSeq: 12,
  withdraw: { text: 'hello', attachments: [] },
  files: {
    available: true,
    changes: [{ path: '/a.txt', action: 'restore' }],
    skipped: [],
  },
}

const commitValue = {
  conversation: { rewound: true },
  files: { applied: true, restored: ['/a.txt'], deleted: [], skipped: [], failed: [] },
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockReturnValue(undefined)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('healthOverApi', () => {
  it('reads the contract major over GET', async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ ok: true, value: { contract: 1 } }))
    await expect(healthOverApi()).resolves.toEqual({ contract: 1 })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('./api/dsh-rewind/v1/health')
    expect(init).toMatchObject({ method: 'GET' })
  })

  it('treats a 404, an invalid body or a transport fault as an absent engine', async () => {
    stubFetch(async () => new Response('', { status: 404 }))
    await expect(healthOverApi()).resolves.toBeNull()
    stubFetch(async () => jsonResponse({ ok: true, value: { contract: 'one' } }))
    await expect(healthOverApi()).resolves.toBeNull()
    stubFetch(async () => { throw new Error('offline') })
    await expect(healthOverApi()).resolves.toBeNull()
  })
})

describe('previewOverApi', () => {
  it('posts the flat query payload to the v1 preview route', async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ ok: true, value: previewValue }))
    await expect(previewOverApi('s1', 7)).resolves.toEqual({ kind: 'success', value: previewValue })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('./api/dsh-rewind/v1/preview')
    expect(init).toMatchObject({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1', seq: 7 }),
    })
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('keeps the stable failure code', async () => {
    stubFetch(async () => jsonResponse({
      ok: false,
      error: { code: 'target-missing', message: 'no user message at seq 7' },
    }, 404))
    await expect(previewOverApi('s1', 7)).resolves.toEqual({
      kind: 'error',
      code: 'target-missing',
      message: 'no user message at seq 7',
    })
  })

  it('settles a timeout as null, not an error message', async () => {
    stubFetch(async () => { throw new DOMException('timed out', 'TimeoutError') })
    await expect(previewOverApi('s1', 7)).resolves.toBeNull()
  })

  it('rejects a malformed value at the transport boundary', async () => {
    stubFetch(async () => jsonResponse({ ok: true, value: { headSeq: 'x' } }))
    await expect(previewOverApi('s1', 7)).resolves.toEqual({
      kind: 'error',
      code: 'internal',
      message: 'invalid preview response',
    })
  })

  it('rejects a malformed envelope before value mapping', async () => {
    stubFetch(async () => jsonResponse({ nope: true }))
    await expect(previewOverApi('s1', 7)).resolves.toEqual({
      kind: 'error',
      code: 'internal',
      message: 'invalid response for preview',
    })
  })
})

describe('candidatesOverApi (internal picker read)', () => {
  const candidates = [
    { seq: 3, time: 1, preview: 'first' },
    { seq: 8, time: 2, preview: 'second' },
  ]

  it('posts the session id to the internal route and returns the full surface', async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ ok: true, value: { candidates } }))
    await expect(candidatesOverApi('s1')).resolves.toEqual(candidates)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('./api/dsh-rewind/candidates')
    expect(init).toMatchObject({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1' }),
    })
  })

  it('returns undefined when the internal read is unavailable or malformed', async () => {
    stubFetch(async () => new Response('', { status: 404 }))
    await expect(candidatesOverApi('s1')).resolves.toBeUndefined()
    stubFetch(async () => jsonResponse({ ok: false, error: { code: 'rewind/failed', message: 'no' } }))
    await expect(candidatesOverApi('s1')).resolves.toBeUndefined()
    stubFetch(async () => jsonResponse({ ok: true, value: { candidates: [{ seq: 'x' }] } }))
    await expect(candidatesOverApi('s1')).resolves.toEqual([])
  })
})

describe('commitOverApi', () => {
  it('posts the bound commit payload and maps the result', async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ ok: true, value: commitValue }))
    await expect(commitOverApi('s1', 7, 12, 'both')).resolves.toEqual({ kind: 'success', value: commitValue })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('./api/dsh-rewind/v1/commit')
    expect(init).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ sessionId: 's1', seq: 7, headSeq: 12, mode: 'both' }),
    })
  })

  it('keeps a stable conflict code', async () => {
    stubFetch(async () => jsonResponse({
      ok: false,
      error: { code: 'head-changed', message: 'session head is 14, expected 12' },
    }, 409))
    await expect(commitOverApi('s1', 7, 12, 'conversation')).resolves.toEqual({
      kind: 'error',
      code: 'head-changed',
      message: 'session head is 14, expected 12',
    })
  })

  it('rejects a malformed commit value', async () => {
    stubFetch(async () => jsonResponse({ ok: true, value: { files: { applied: true, restored: 'no' } } }))
    await expect(commitOverApi('s1', 7, 12, 'files')).resolves.toEqual({
      kind: 'error',
      code: 'internal',
      message: 'invalid commit response',
    })
  })
})
