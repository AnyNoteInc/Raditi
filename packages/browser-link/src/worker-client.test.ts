import { isDomainError, type BrowserSessionState, type DomainError } from '@repo/domain'
import { describe, expect, it, vi } from 'vitest'

import {
  BROWSER_WORKER_RESPONSE_MAX_BYTES,
  browserWorkerTimeoutDefaults,
  createBrowserWorkerClient,
  type BrowserWorkerClientOptions,
} from './worker-client.ts'

const BASE_URL = 'http://browser-worker.internal:8086'
const TOKEN = 'worker-token-0123456789abcdef0123456789abcdef'

const sessionId = '0196abcd-0000-7000-8000-000000000001'
const taskId = '0196abcd-0000-7000-8000-000000000002'
const siteId = '0196abcd-0000-7000-8000-000000000003'
const assignmentId = '0196abcd-0000-7000-8000-000000000004'

const ensureRequest = { sessionId, taskId, siteId, takeControl: true }

const state: BrowserSessionState = {
  session: sessionId,
  status: 'ready',
  controller: 'agent',
  controlEpoch: 3,
  manualReady: false,
  holder: null,
  pageId: 1,
  viewportVersion: 1,
  viewport: { width: 1280, height: 800 },
  url: 'https://news.example.ru/wp-admin/',
  title: 'Консоль',
  tabs: [{ pageId: 1, url: 'https://news.example.ru/wp-admin/', title: 'Консоль' }],
}

const click = {
  taskId,
  assignmentId,
  action: { tool: 'web_click' as const, observation: 'o4', ref: 'e31' },
}
const clicked = {
  tool: 'web_click',
  page: { pageId: 1, url: 'https://news.example.ru/wp-admin/post-new.php', title: 'Новая запись' },
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** A fake worker: every call answers `answer` and is recorded. */
function workerWith(
  answer: (url: string, init: RequestInit) => Response | Promise<Response>,
  options: Partial<BrowserWorkerClientOptions> = {},
) {
  const calls: { url: string; init: RequestInit }[] = []
  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init: init ?? {} })
    return Promise.resolve(answer(url, init ?? {}))
  })
  const client = createBrowserWorkerClient({
    baseUrl: BASE_URL,
    token: TOKEN,
    fetch: fetchMock as unknown as typeof fetch,
    ...options,
  })
  return { client, calls, fetchMock }
}

/** A worker that never answers: the call ends only when its signal aborts. */
const silent = (_url: string, init: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(init.signal?.reason))
  })

async function rejection(promise: Promise<unknown>): Promise<DomainError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(isDomainError(error), String(error)).toBe(true)
  const domainError = error as DomainError
  // Neither the token nor the address of the worker ever reaches an error.
  const said = `${domainError.message} ${JSON.stringify(domainError.details ?? null)}`
  expect(said).not.toContain(TOKEN)
  expect(said).not.toContain('browser-worker.internal')
  expect(said).not.toContain('8086')
  expect(domainError.cause).toBeUndefined()
  return domainError
}

describe('the HTTP client of the browser worker', () => {
  it('ensures a session with the token and reads its state', async () => {
    const { client, calls } = workerWith(() => json(state))
    await expect(client.ensure(ensureRequest)).resolves.toEqual(state)
    expect(calls).toHaveLength(1)
    const { url, init } = calls[0] ?? { url: '', init: {} }
    expect(url).toBe(`${BASE_URL}/v1/sessions/ensure`)
    expect(init.method).toBe('POST')
    expect(init.redirect).toBe('manual')
    expect(init.headers).toEqual({
      authorization: `Bearer ${TOKEN}`,
      accept: 'application/json',
      'content-type': 'application/json',
    })
    expect(JSON.parse(String(init.body))).toEqual(ensureRequest)
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('closes, verifies and lists with their paths and bodies', async () => {
    const verified = {
      checkpoints: [
        {
          kind: 'post',
          objectId: '12',
          state: 'verified',
          object: {
            kind: 'post',
            objectId: '12',
            title: 'Новость',
            status: 'draft',
            editUrl: 'https://news.example.ru/wp-admin/post.php?post=12&action=edit',
            images: 2,
            files: 1,
            featuredImage: true,
          },
        },
        { kind: 'post', objectId: '13', state: 'missing' },
      ],
    }
    const listed = { sessions: [{ sessionId, taskId, status: 'ready' }] }
    const { client, calls } = workerWith((url) => {
      if (url.endsWith('/close')) return json({ sessionId, status: 'closed' })
      if (url.endsWith('/verify')) return json(verified)
      return json(listed)
    })
    await expect(client.close(sessionId, { reason: 'task_done' })).resolves.toEqual({
      sessionId,
      status: 'closed',
    })
    await expect(client.verify(sessionId)).resolves.toEqual(verified)
    await expect(client.list()).resolves.toEqual(listed)
    expect(
      calls.map(({ url, init }) => [url.slice(BASE_URL.length), init.method, init.body]),
    ).toEqual([
      [`/v1/sessions/${sessionId}/close`, 'POST', JSON.stringify({ reason: 'task_done' })],
      [`/v1/sessions/${sessionId}/verify`, 'POST', '{}'],
      ['/v1/sessions', 'GET', undefined],
    ])
    // A GET carries no body and says so.
    expect(calls[2]?.init.headers).not.toHaveProperty('content-type')
  })

  it('answers an action with the result of its tool', async () => {
    const { client, calls } = workerWith(() => json({ ok: true, result: clicked }))
    await expect(client.action(sessionId, click)).resolves.toEqual(clicked)
    expect(calls[0]?.url).toBe(`${BASE_URL}/v1/sessions/${sessionId}/actions`)
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual(click)
  })

  it('rejects a refusal of an action with the fixed code and its text', async () => {
    const { client } = workerWith(() => json({ ok: false, code: 'BROWSER_USER_IN_CONTROL' }))
    const error = await rejection(client.action(sessionId, click))
    expect(error.code).toBe('BROWSER_USER_IN_CONTROL')
    expect(error.httpStatus).toBe(409)
    expect(error.message).toBe(
      'The client controls the browser. End the turn and wait for the client.',
    )
    expect(error.details).toEqual({ operation: 'action', failure: 'refused' })
  })

  it('passes the worker’s own code of a 4xx through', async () => {
    const { client } = workerWith(() => json({ code: 'BROWSER_SESSION_UNKNOWN' }, 404))
    const unknown = await rejection(client.verify(sessionId))
    expect(unknown.code).toBe('BROWSER_SESSION_UNKNOWN')
    expect(unknown.httpStatus).toBe(404)
    expect(unknown.message).toBe('The browser worker refused the request')
    expect(unknown.details).toEqual({ operation: 'verify', failure: 'refused', status: 404 })

    // A code of the tools keeps its own status and text.
    const denied = workerWith(() => json({ code: 'BROWSER_ADDRESS_DENIED' }, 403))
    const error = await rejection(
      denied.client.action(sessionId, {
        ...click,
        action: { tool: 'web_open', url: '/wp-admin/' },
      }),
    )
    expect([error.code, error.httpStatus, error.message]).toEqual([
      'BROWSER_ADDRESS_DENIED',
      403,
      'This address is outside the site.',
    ])
  })

  it('passes a 5xx through only with a fixed code of the tools', async () => {
    const timedOut = workerWith(() => json({ code: 'BROWSER_TIMEOUT' }, 504))
    expect((await rejection(timedOut.client.action(sessionId, click))).code).toBe('BROWSER_TIMEOUT')
    for (const answer of [
      () => json({ code: 'INTERNAL_ERROR' }, 500),
      () => json({ statusCode: 500, message: 'Internal server error' }, 500),
      () => new Response('<html>Bad Gateway</html>', { status: 502 }),
      () => new Response(null, { status: 503 }),
    ]) {
      const error = await rejection(workerWith(answer).client.action(sessionId, click))
      expect(error.code).toBe('BROWSER_SESSION_UNAVAILABLE')
      expect(error.httpStatus).toBe(503)
      expect(error.details).toMatchObject({ operation: 'action', failure: 'status' })
    }
  })

  it('takes a 4xx without a code of the worker as the worker unavailable', async () => {
    for (const answer of [
      () => new Response('Unauthorized', { status: 401 }),
      () => json({ code: 'denied: ws://127.0.0.1:9/secret' }, 403),
      () => json({ code: 'BROWSER_ADDRESS_DENIED', message: 'https://evil.example' }, 403),
    ]) {
      const error = await rejection(workerWith(answer).client.list())
      expect(error.code).toBe('BROWSER_SESSION_UNAVAILABLE')
      expect(error.details).toMatchObject({ operation: 'list', failure: 'status' })
    }
  })

  it('does not follow a redirect', async () => {
    const { client } = workerWith(
      () =>
        new Response(null, { status: 307, headers: { location: 'https://elsewhere.example/' } }),
    )
    const error = await rejection(client.ensure(ensureRequest))
    expect(error.code).toBe('BROWSER_SESSION_UNAVAILABLE')
    expect(error.details).toEqual({ operation: 'ensure', failure: 'status', status: 307 })
  })

  it('takes an unreachable worker as unavailable and drops what fetch said', async () => {
    const { client } = workerWith(() => {
      throw new TypeError('fetch failed', {
        cause: new Error(`connect ECONNREFUSED browser-worker.internal:8086 Bearer ${TOKEN}`),
      })
    })
    const error = await rejection(client.ensure(ensureRequest))
    expect(error.code).toBe('BROWSER_SESSION_UNAVAILABLE')
    expect(error.httpStatus).toBe(503)
    expect(error.details).toEqual({ operation: 'ensure', failure: 'unreachable' })
  })

  it('checks every answer strictly', async () => {
    const bad: [string, () => Promise<unknown>][] = [
      [
        'an extra field',
        () => clientOf(json({ ...state, endpoint: 'ws://x' })).ensure(ensureRequest),
      ],
      [
        'another session',
        () => clientOf(json({ ...state, session: taskId })).ensure(ensureRequest),
      ],
      [
        'another closed session',
        () =>
          clientOf(json({ sessionId: taskId, status: 'closed' })).close(sessionId, {
            reason: 'idle',
          }),
      ],
      [
        'a result of another tool',
        () =>
          clientOf(json({ ok: true, result: { ...clicked, tool: 'web_fill' } })).action(
            sessionId,
            click,
          ),
      ],
      [
        'an unknown refusal',
        () =>
          clientOf(json({ ok: false, code: 'BROWSER_PREVIEW_NOT_READY' })).action(sessionId, click),
      ],
      ['not JSON', () => clientOf(new Response('ok', { status: 200 })).list()],
      ['no body', () => clientOf(new Response(null, { status: 204 })).list()],
      ['not UTF-8', () => clientOf(new Response(new Uint8Array([0x7b, 0xff, 0x7d]))).list()],
    ]
    for (const [what, run] of bad) {
      const error = await rejection(run())
      expect(error.code, what).toBe('BROWSER_SESSION_UNAVAILABLE')
      expect((error.details as { failure: string }).failure, what).toBe('body')
    }
  })

  it('reads no answer past its limit', async () => {
    const big = `{"sessions":[],"pad":"${'x'.repeat(BROWSER_WORKER_RESPONSE_MAX_BYTES)}"}`
    const declared = clientOf(
      new Response(big, { headers: { 'content-length': String(big.length) } }),
    )
    expect(((await rejection(declared.list())).details as { failure: string }).failure).toBe('body')

    // A stream that does not declare its length is cut where it passes the limit.
    let pulled = 0
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1
        controller.enqueue(new Uint8Array(64 * 1024).fill(0x20))
      },
    })
    const undeclared = clientOf(new Response(endless))
    expect(((await rejection(undeclared.list())).details as { failure: string }).failure).toBe(
      'body',
    )
    expect(pulled).toBeLessThanOrEqual(BROWSER_WORKER_RESPONSE_MAX_BYTES / (64 * 1024) + 2)
  })

  it('refuses a request that breaks the contract before sending it, naming fields only', async () => {
    const { client, fetchMock } = workerWith(() => json(state))
    const secret = 'https://news.example.ru/?token=hunter2'
    for (const run of [
      // The worker reads the site's address from the database: a caller never names one.
      () => client.ensure({ ...ensureRequest, siteUrl: secret } as never),
      () => client.ensure({ ...ensureRequest, extra: true } as never),
      () => client.close('../../etc', { reason: 'idle' }),
      () => client.close(sessionId, { reason: 'bored' as never }),
      () => client.verify('not-a-uuid'),
      () =>
        client.action(sessionId, {
          ...click,
          action: { tool: 'web_fill', observation: 'o4', ref: 'e31', text: `\u0000${secret}` },
        }),
    ]) {
      const error = await rejection(run())
      expect(error.code).toBe('BAD_REQUEST')
      expect(JSON.stringify(error.details)).not.toContain('hunter2')
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('gives each call its own time, and a timed-out page action is a timeout', async () => {
    const timeouts = { ensureMs: 20, closeMs: 20, verifyMs: 20, listMs: 20, actionMs: 20 }
    const { client } = workerWith(silent, { timeouts })
    const expected: [() => Promise<unknown>, string][] = [
      [() => client.ensure(ensureRequest), 'BROWSER_SESSION_UNAVAILABLE'],
      [() => client.close(sessionId, { reason: 'idle' }), 'BROWSER_SESSION_UNAVAILABLE'],
      [() => client.list(), 'BROWSER_SESSION_UNAVAILABLE'],
      // The action or the check may still have happened in the page: the agent looks again.
      [() => client.action(sessionId, click), 'BROWSER_TIMEOUT'],
      [() => client.verify(sessionId), 'BROWSER_TIMEOUT'],
    ]
    for (const [run, code] of expected) {
      const error = await rejection(run())
      expect(error.code).toBe(code)
      expect((error.details as { failure: string }).failure).toBe('timeout')
    }
  })

  it('keeps an action within the budget of a tool call and ensure within a cold start', () => {
    expect(browserWorkerTimeoutDefaults.actionMs).toBeLessThan(50_000)
    expect(browserWorkerTimeoutDefaults.ensureMs).toBe(90_000)
    const make = (timeouts: BrowserWorkerClientOptions['timeouts']) => () =>
      createBrowserWorkerClient({ baseUrl: BASE_URL, token: TOKEN, timeouts })
    expect(make({ actionMs: 50_000 })).not.toThrow()
    expect(make({ actionMs: 50_001 })).toThrow('actionMs must be 1 to 50000 ms')
    expect(make({ verifyMs: 60_000 })).toThrow('verifyMs')
    expect(make({ ensureMs: 90_001 })).toThrow('ensureMs')
    expect(make({ listMs: 0 })).toThrow('listMs')
    expect(make({ closeMs: 1.5 })).toThrow('closeMs')
  })

  it('rejects with the caller’s own reason when the caller cancels', async () => {
    const { client, fetchMock } = workerWith(silent)
    const reason = new Error('the turn was cancelled')
    const controller = new AbortController()
    const pending = client.action(sessionId, click, { signal: controller.signal })
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)

    // Cancelled before: nothing is sent.
    await expect(client.list({ signal: AbortSignal.abort(reason) })).rejects.toBe(reason)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('refuses a worker address or a token it could not send safely, without echoing them', () => {
    for (const baseUrl of [
      'browser-worker:8086',
      'ftp://browser-worker.internal',
      'http://user:pass@browser-worker.internal',
      'http://browser-worker.internal/api',
      'http://browser-worker.internal/?x=1',
    ])
      expect(() => createBrowserWorkerClient({ baseUrl, token: TOKEN })).toThrow(
        /^The browser worker address/,
      )
    for (const token of ['', 'two words', `${TOKEN}\r\nx-evil: 1`, 'токен'])
      try {
        createBrowserWorkerClient({ baseUrl: BASE_URL, token })
        expect.unreachable()
      } catch (error) {
        expect(String(error)).toContain('token must be visible ASCII')
        if (token !== '') expect(String(error)).not.toContain(token)
      }
    // A trailing slash is the same origin.
    expect(() => createBrowserWorkerClient({ baseUrl: `${BASE_URL}/`, token: TOKEN })).not.toThrow()
  })
})

function clientOf(response: Response) {
  return workerWith(() => response).client
}
