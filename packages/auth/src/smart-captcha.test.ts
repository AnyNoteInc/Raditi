import { betterAuth } from 'better-auth'
import { memoryAdapter } from 'better-auth/adapters/memory'
import { describe, expect, it, vi } from 'vitest'

import { ipAddressOptions } from './request-meta.ts'
import {
  CAPTCHA_HEADER,
  smartCaptcha,
  SMARTCAPTCHA_VALIDATE_URL,
  validateSmartCaptcha,
} from './smart-captcha.ts'

const serverKey = 'ysc2_test-server-key'

function yandexAnswers(status: number, body: unknown) {
  return vi.fn<typeof globalThis.fetch>(async () =>
    Response.json(body, { status, headers: { 'content-type': 'application/json' } }),
  )
}

const ok = () => yandexAnswers(200, { status: 'ok', message: '', host: 'raditi.ru' })
const robot = () => yandexAnswers(200, { status: 'failed', message: '' })
const badKey = () =>
  yandexAnswers(403, { status: 'failed', message: 'Authentication failed. Invalid secret.' })
const down = () => yandexAnswers(503, { error: 'unavailable' })

describe('validateSmartCaptcha', () => {
  it('posts the key, the token and the client IP as a form', async () => {
    const fetch = ok()

    await expect(
      validateSmartCaptcha({ serverKey, token: 'tok', ip: '203.0.113.7', fetch }),
    ).resolves.toEqual({
      kind: 'pass',
    })

    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe(SMARTCAPTCHA_VALIDATE_URL)
    expect(init?.method).toBe('POST')
    expect(Object.fromEntries(init?.body as URLSearchParams)).toEqual({
      secret: serverKey,
      token: 'tok',
      ip: '203.0.113.7',
    })
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('fails a robot', async () => {
    await expect(
      validateSmartCaptcha({ serverKey, token: 'tok', fetch: robot() }),
    ).resolves.toEqual({
      kind: 'fail',
      reason: 'failed',
    })
  })

  it('fails closed on a rejected server key instead of switching the captcha off', async () => {
    await expect(
      validateSmartCaptcha({ serverKey, token: 'tok', fetch: badKey() }),
    ).resolves.toEqual({
      kind: 'fail',
      reason: 'http_403',
    })
  })

  it('fails an unreadable answer', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response('<html>', { status: 200 }),
    )
    await expect(validateSmartCaptcha({ serverKey, token: 'tok', fetch })).resolves.toEqual({
      kind: 'fail',
      reason: 'bad_body',
    })
  })

  it.each([
    ['5xx', down(), 'http_503'],
    ['429', yandexAnswers(429, {}), 'http_429'],
    [
      'a network error',
      vi.fn<typeof globalThis.fetch>(async () => {
        throw new TypeError('fetch failed')
      }),
      'TypeError',
    ],
  ])('reports Yandex as unavailable on %s', async (_case, fetch, reason) => {
    await expect(validateSmartCaptcha({ serverKey, token: 'tok', fetch })).resolves.toEqual({
      kind: 'unavailable',
      reason,
    })
  })

  it('gives up after the timeout', async () => {
    const hanging = vi.fn<typeof globalThis.fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
        }),
    )
    await expect(
      validateSmartCaptcha({ serverKey, token: 'tok', fetch: hanging, timeoutMs: 10 }),
    ).resolves.toEqual({ kind: 'unavailable', reason: 'TimeoutError' })
  })
})

function authWithCaptcha(fetch: typeof globalThis.fetch) {
  const log = vi.fn()
  const auth = betterAuth({
    baseURL: 'http://localhost:3000',
    secret: 'x'.repeat(32),
    database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
    emailAndPassword: { enabled: true },
    telemetry: { enabled: false },
    logger: { level: 'debug', log },
    advanced: { ipAddress: ipAddressOptions },
    plugins: [smartCaptcha({ serverKey, fetch })],
  })
  return { auth, log }
}

const credentials = { email: 'owner@example.ru', password: 'correct-horse-battery' }

function captchaHeaders(token?: string): Headers {
  const headers = new Headers({ 'x-forwarded-for': '203.0.113.7' })
  if (token !== undefined) headers.set(CAPTCHA_HEADER, token)
  return headers
}

/** Sign-in of an unknown user: 401 means the captcha let the request through. */
async function signInStatus(auth: ReturnType<typeof authWithCaptcha>['auth'], headers: Headers) {
  try {
    await auth.api.signInEmail({ body: credentials, headers })
    return { status: 'OK', code: undefined }
  } catch (error) {
    const e = error as { status: string; body?: { code?: string } }
    return { status: e.status, code: e.body?.code }
  }
}

describe('smartCaptcha plugin', () => {
  it('lets a human through and sends Yandex the client IP', async () => {
    const fetch = ok()
    const { auth } = authWithCaptcha(fetch)

    await expect(signInStatus(auth, captchaHeaders('tok'))).resolves.toMatchObject({
      status: 'UNAUTHORIZED',
    })
    expect(Object.fromEntries(fetch.mock.calls[0]![1]?.body as URLSearchParams)).toMatchObject({
      token: 'tok',
      ip: '203.0.113.7',
    })
  })

  it('asks for the captcha when the token is missing, without calling Yandex', async () => {
    const fetch = ok()
    const { auth } = authWithCaptcha(fetch)

    await expect(signInStatus(auth, captchaHeaders())).resolves.toEqual({
      status: 'BAD_REQUEST',
      code: 'CAPTCHA_REQUIRED',
    })
    // Server code calling auth.api without the client's headers gets no bypass either.
    await expect(auth.api.signInEmail({ body: credentials })).rejects.toMatchObject({
      body: { code: 'CAPTCHA_REQUIRED' },
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    ['a robot', robot(), 'failed'],
    ['an unreadable answer', yandexAnswers(200, { unexpected: true }), 'bad_body'],
  ])('stops %s and warns with the path and the reason', async (_case, fetch, reason) => {
    const { auth, log } = authWithCaptcha(fetch)
    await expect(signInStatus(auth, captchaHeaders('secret-token'))).resolves.toEqual({
      status: 'FORBIDDEN',
      code: 'CAPTCHA_FAILED',
    })
    expect(log).toHaveBeenCalledWith('warn', 'SmartCaptcha check failed', {
      path: '/sign-in/email',
      reason,
    })
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret-token')
  })

  it('stops an oversized token without calling Yandex and warns', async () => {
    const fetch = ok()
    const { auth, log } = authWithCaptcha(fetch)
    await expect(signInStatus(auth, captchaHeaders('t'.repeat(5000)))).resolves.toEqual({
      status: 'FORBIDDEN',
      code: 'CAPTCHA_FAILED',
    })
    expect(fetch).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith('warn', 'SmartCaptcha check failed', {
      path: '/sign-in/email',
      reason: 'token_too_long',
    })
  })

  it('stops everyone and logs an error when Yandex rejects the server key', async () => {
    const { auth, log } = authWithCaptcha(badKey())
    await expect(signInStatus(auth, captchaHeaders('secret-token'))).resolves.toEqual({
      status: 'FORBIDDEN',
      code: 'CAPTCHA_FAILED',
    })
    expect(log).toHaveBeenCalledWith('error', expect.stringContaining('SMARTCAPTCHA_SERVER_KEY'), {
      path: '/sign-in/email',
      reason: 'http_403',
    })
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret-token')
  })

  it('lets the request through and warns when Yandex is down', async () => {
    const { auth, log } = authWithCaptcha(down())
    await expect(signInStatus(auth, captchaHeaders('tok'))).resolves.toMatchObject({
      status: 'UNAUTHORIZED',
    })
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('unavailable'), {
      path: '/sign-in/email',
      reason: 'http_503',
    })
  })

  it('logs nothing for a human', async () => {
    const { auth, log } = authWithCaptcha(ok())
    await signInStatus(auth, captchaHeaders('tok'))
    expect(
      log.mock.calls.filter(([, message]) => String(message).includes('SmartCaptcha')),
    ).toEqual([])
  })

  it('guards the HTTP route too', async () => {
    const fetch = ok()
    const { auth } = authWithCaptcha(fetch)
    const response = await auth.handler(
      new Request('http://localhost:3000/api/auth/sign-up/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
        body: JSON.stringify({ ...credentials, name: 'Анна' }),
      }),
    )
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ code: 'CAPTCHA_REQUIRED' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('leaves other endpoints alone', async () => {
    const fetch = ok()
    const { auth } = authWithCaptcha(fetch)
    await expect(auth.api.getSession({ headers: new Headers() })).resolves.toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })
})
