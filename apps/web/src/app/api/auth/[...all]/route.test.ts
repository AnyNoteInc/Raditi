import { randomUUID } from 'node:crypto'

import type * as AuthModule from '@repo/auth'
import { describe, expect, it, vi } from 'vitest'

import { MAX_AUTH_BODY_BYTES } from '@/server/body-limit'

const ORIGIN = 'https://raditi.ru'
const PASSWORD = 'body-limit-test-password'
const account = {
  id: '0199a000-0000-7000-8000-000000000001',
  email: 'owner@example.ru',
  name: 'Анна',
  lastName: null,
  image: null,
  emailVerified: true,
  createdAt: new Date(),
  updatedAt: new Date(),
}

// The production configuration of @repo/auth (captcha on, limits in the database) on a local
// adapter: what the route serves, without PostgreSQL.
const { store } = vi.hoisted(() => ({
  store: { user: [], account: [], session: [], verification: [], rateLimit: [] } as Record<
    string,
    Record<string, unknown>[]
  >,
}))
vi.mock('@repo/auth', async (importOriginal) => {
  const original = await importOriginal<typeof AuthModule>()
  const { createPrismaClient } = await import('@repo/db')
  const { betterAuth } = await import('better-auth')
  const { memoryAdapter } = await import('better-auth/adapters/memory')
  const options = original.createAuth({
    config: {
      appEnv: 'production',
      appUrl: 'https://raditi.ru',
      baseUrl: 'https://raditi.ru',
      secret: 'x'.repeat(32),
      captcha: { serverKey: 'ysc2_k', clientKey: 'ysc1_k' },
    },
    // A real client that never connects: better-auth reads its data model, nothing more.
    prisma: createPrismaClient({ databaseUrl: 'postgresql://raditi:raditi@127.0.0.1:9/raditi' }),
    notifier: {
      verifyEmail: async () => true,
      resetPassword: async () => true,
      welcome: async () => true,
    },
    fetch: async () => Response.json({ status: 'ok' }),
  }).options
  const auth = betterAuth({
    ...options,
    database: memoryAdapter(store),
    advanced: { ...options.advanced, database: { generateId: () => crypto.randomUUID() } },
    logger: { disabled: true },
  })
  return { ...original, auth }
})

const { auth } = await import('@repo/auth')
const { GET, POST } = await import('./route')

const MIB = 1024 * 1024

/** A JSON body of `megabytes`, produced lazily; counts the megabytes the server pulled. */
function hugeBody(megabytes: number) {
  const encoder = new TextEncoder()
  const chunk = new Uint8Array(MIB).fill(0x61)
  let pulled = 0
  let stage: 'open' | 'fill' | 'done' = 'open'
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (stage === 'open') {
        stage = 'fill'
        controller.enqueue(encoder.encode('{"email":"owner@example.ru","password":"'))
      } else if (pulled < megabytes) {
        pulled += 1
        controller.enqueue(chunk)
      } else if (stage === 'fill') {
        stage = 'done'
        controller.enqueue(encoder.encode('"}'))
      } else controller.close()
    },
  })
  return { stream, pulled: () => pulled }
}

// Every request from its own address: better-auth allows three sign-ins per address in 10 s.
let clients = 0
const post = (path: string, body: BodyInit, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}/api/auth${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: ORIGIN,
      'x-forwarded-for': `203.0.113.${(clients += 1)}`,
      ...headers,
    },
    body,
    duplex: 'half',
  } as RequestInit)

describe('auth route: request body limit', () => {
  it.each(['/sign-in/email', '/sign-out', '/reset-password'])(
    'stops reading an 8 MiB body sent to %s without a session or a captcha answer',
    async (path) => {
      const body = hugeBody(8)

      const response = await POST(post(path, body.stream))

      expect(response.status).toBe(413)
      expect(await response.json()).toEqual({ message: 'Запрос слишком большой.' })
      // The limit plus the chunk that crossed it, and one the stream prepared ahead.
      expect(body.pulled()).toBeLessThanOrEqual(2)
    },
  )

  it('refuses a declared oversize body before reading it', async () => {
    const request = post('/sign-in/email', '{}', {
      'content-length': String(MAX_AUTH_BODY_BYTES + 1),
    })
    expect((await POST(request)).status).toBe(413)
    expect(request.bodyUsed).toBe(false)
  })

  it('takes a body of exactly the limit to better-auth', async () => {
    const padding = MAX_AUTH_BODY_BYTES - Buffer.byteLength(JSON.stringify({ email: '' }))
    const body = JSON.stringify({ email: 'a'.repeat(padding) })
    expect(Buffer.byteLength(body)).toBe(MAX_AUTH_BODY_BYTES)

    const response = await POST(post('/sign-in/email', body))

    // The captcha hook of better-auth answered: the request went past the limit.
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'CAPTCHA_REQUIRED' })
  })

  it('signs a user in and reads the session as before', async () => {
    const context = await auth.$context
    store.user!.push({ ...account })
    store.account!.push({
      id: randomUUID(),
      userId: account.id,
      accountId: account.id,
      providerId: 'credential',
      password: await context.password.hash(PASSWORD),
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    })

    const signedIn = await POST(
      post('/sign-in/email', JSON.stringify({ email: account.email, password: PASSWORD }), {
        'x-captcha-response': 'token',
      }),
    )

    expect(signedIn.status).toBe(200)
    expect(await signedIn.json()).toMatchObject({ user: { email: account.email, name: 'Анна' } })
    const cookie = signedIn.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ')
    const session = await GET(
      new Request(`${ORIGIN}/api/auth/get-session`, { headers: { cookie } }),
    )
    expect(session.status).toBe(200)
    expect(await session.json()).toMatchObject({ user: { id: account.id } })

    const wrong = await POST(
      post('/sign-in/email', JSON.stringify({ email: account.email, password: 'wrong' }), {
        'x-captcha-response': 'token',
      }),
    )
    expect(wrong.status).toBe(401)
  })
})
