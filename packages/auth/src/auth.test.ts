import { randomUUID } from 'node:crypto'

import { createPrismaClient } from '@repo/db'
import { betterAuth } from 'better-auth'
import { memoryAdapter } from 'better-auth/adapters/memory'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

import { createAuth, type AuthNotifier } from './auth.ts'
import type { AuthConfig } from './config.ts'
import type { ConsentRow } from './consents.ts'

const config: AuthConfig = {
  appEnv: 'test',
  appUrl: 'https://raditi.ru',
  baseUrl: 'https://raditi.ru',
  secret: 'x'.repeat(32),
  captcha: null,
  yandex: null,
}

// A real client that never connects: better-auth reads its data model, nothing more.
const prisma = createPrismaClient({ databaseUrl: 'postgresql://raditi:raditi@127.0.0.1:9/raditi' })
afterAll(() => prisma.$disconnect())

function makeNotifier() {
  return {
    verifyEmail: vi.fn<AuthNotifier['verifyEmail']>(async () => true),
    resetPassword: vi.fn<AuthNotifier['resetPassword']>(async () => true),
    welcome: vi.fn<AuthNotifier['welcome']>(async () => true),
  }
}

const user = {
  id: '0199a000-0000-7000-8000-000000000001',
  email: 'owner@example.ru',
  name: 'Анна',
  emailVerified: false,
  createdAt: new Date(),
  updatedAt: new Date(),
}

describe('createAuth', () => {
  it('matches the Prisma schema of @repo/db', async () => {
    const auth = createAuth({ config, prisma, notifier: makeNotifier() })
    const context = await auth.$context

    expect(context.explicitSchemaCheck).toBeDefined()
    await expect(context.explicitSchemaCheck?.()).resolves.toBeUndefined()
  })

  it('keeps foreign services and telemetry out', async () => {
    const auth = createAuth({ config, prisma, notifier: makeNotifier() })
    const { options } = auth
    expect(options.telemetry).toEqual({ enabled: false })
    expect('socialProviders' in options).toBe(false)
    // No bearer plugin: it would hand the session token out in set-auth-token and expose
    // that header to scripts via Access-Control-Expose-Headers.
    expect(options.plugins.map((p) => p.id)).toEqual([
      'consents',
      'sign-up-profile',
      'next-cookies',
    ])
  })

  it('adds sign-in with Yandex ID only when its app is configured', () => {
    const auth = createAuth({
      config: { ...config, yandex: { clientId: 'id', clientSecret: 'secret' } },
      prisma,
      notifier: makeNotifier(),
    })
    expect(auth.options.plugins.map((p) => p.id)).toEqual([
      'consents',
      'sign-up-profile',
      'generic-oauth',
      'next-cookies',
    ])
  })

  it('registers the captcha first when keys are configured', () => {
    const auth = createAuth({
      config: { ...config, captcha: { serverKey: 'ysc2_k', clientKey: 'ysc1_k' } },
      prisma,
      notifier: makeNotifier(),
    })
    expect(auth.options.plugins.map((p) => p.id)).toEqual([
      'smart-captcha',
      'consents',
      'sign-up-profile',
      'next-cookies',
    ])
  })

  it('accepts an optional surname while normalizing and validating its input', () => {
    const auth = createAuth({ config, prisma, notifier: makeNotifier() })
    const surname = auth.options.user.additionalFields.lastName
    expect(surname.required).toBe(false)
    expect(surname.validator.input.parse('  Иванова  ')).toBe('Иванова')
    expect(surname.validator.input.parse('  ')).toBeNull()
    expect(() => surname.validator.input.parse('x'.repeat(256))).toThrow()
  })

  it('returns a changed name, surname and avatar on the next session request', async () => {
    const store: Record<string, Record<string, unknown>[]> = {
      user: [{ ...user, emailVerified: true, lastName: null, image: null }],
      account: [],
      session: [],
      verification: [],
      rateLimit: [],
    }
    const options = createAuth({ config, prisma, notifier: makeNotifier() }).options
    // Exercise the actual auth configuration and HTTP session cookies with a local adapter.
    const auth = betterAuth({
      ...options,
      database: memoryAdapter(store),
      advanced: { ...options.advanced, database: { generateId: () => randomUUID() } },
    })
    const ctx = await auth.$context
    store.account!.push({
      id: randomUUID(),
      userId: user.id,
      accountId: user.id,
      providerId: 'credential',
      password: await ctx.password.hash('profile-test-password'),
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    })

    const signedIn = await auth.api.signInEmail({
      body: { email: user.email, password: 'profile-test-password' },
      asResponse: true,
    })
    expect(signedIn.status).toBe(200)
    const headers = new Headers({
      cookie: signedIn.headers
        .getSetCookie()
        .map((cookie) => cookie.split(';')[0])
        .join('; '),
    })
    expect(await auth.api.getSession({ headers })).toMatchObject({
      user: { name: 'Анна', lastName: null, image: null },
    })

    Object.assign(store.user![0]!, {
      name: 'Мария',
      lastName: 'Петрова',
      image: '/api/profile/avatar/next',
    })

    expect(await auth.api.getSession({ headers })).toMatchObject({
      user: { name: 'Мария', lastName: 'Петрова', image: '/api/profile/avatar/next' },
    })
  })

  describe('fields better-auth stores outside the validated paths', () => {
    /** The real configuration on a local adapter, with one verified account signed in. */
    async function signedInAuth() {
      const store: Record<string, Record<string, unknown>[]> = {
        user: [{ ...user, emailVerified: true, lastName: null, image: null }],
        account: [],
        session: [],
        verification: [],
        rateLimit: [],
      }
      const options = createAuth({ config, prisma, notifier: makeNotifier() }).options
      const auth = betterAuth({
        ...options,
        database: memoryAdapter(store),
        advanced: { ...options.advanced, database: { generateId: () => randomUUID() } },
        logger: { disabled: true },
      })
      const ctx = await auth.$context
      store.account!.push({
        id: randomUUID(),
        userId: user.id,
        accountId: user.id,
        providerId: 'credential',
        password: await ctx.password.hash('profile-test-password'),
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      })
      const signedIn = await auth.api.signInEmail({
        body: { email: user.email, password: 'profile-test-password' },
        asResponse: true,
      })
      const cookie = signedIn.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; ')
      const post = (path: string, body: unknown) =>
        auth.handler(
          new Request(`https://raditi.ru/api/auth${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: 'https://raditi.ru', cookie },
            body: JSON.stringify(body),
          }),
        )
      return { auth, store, post }
    }

    it.each(['/update-user', '/update-user/', '//update-user', '/UPDATE-USER', '/update%2Duser'])(
      'keeps the built-in profile update closed: POST %s changes nothing',
      async (path) => {
        const { store, post } = await signedInAuth()

        const response = await post(path, {
          name: '   ',
          lastName: 'Петрова',
          image: 'https://tracker.example/pixel.gif?u=1',
        })

        expect(response.status).toBe(404)
        expect(store.user![0]).toMatchObject({ name: 'Анна', lastName: null, image: null })
      },
    )

    it('leaves the session itself reachable over HTTP', async () => {
      const { auth, post } = await signedInAuth()
      expect(auth.options.disabledPaths).toEqual(['/update-user'])
      // Not a blanket 404: another signed-in endpoint of the same router still answers.
      expect((await post('/revoke-other-sessions', {})).status).toBe(200)
    })

    it('accepts neither an image nor an unchecked name at sign-up', async () => {
      const { store, post } = await signedInAuth()
      const body = {
        email: 'new@example.ru',
        password: 'profile-test-password',
        name: 'Мария',
        acceptTerms: true,
        acceptPersonalData: true,
        marketing: false,
      }

      const withImage = await post('/sign-up/email', {
        ...body,
        image: 'https://tracker.example/signup.gif',
      })
      expect(withImage.status).toBe(400)
      expect(await withImage.json()).toMatchObject({ code: 'IMAGE_NOT_ALLOWED' })

      const blankName = await post('/sign-up/email', { ...body, name: ' ' })
      expect(blankName.status).toBe(400)
      expect(await blankName.json()).toMatchObject({ code: 'INVALID_NAME' })

      // users.email is VarChar(255): a longer address is a 400 the web maps to Russian text,
      // not a failed insert.
      const longEmail = await post('/sign-up/email', {
        ...body,
        email: `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(59)}.ru`,
      })
      expect(longEmail.status).toBe(400)
      expect(await longEmail.json()).toMatchObject({ code: 'INVALID_EMAIL' })

      expect(store.user).toHaveLength(1)
    })

    it('lets a valid sign-up through: trimmed name, surname and the consent log', async () => {
      const createMany = vi.spyOn(prisma.userConsent, 'createMany').mockResolvedValue({ count: 5 })
      try {
        const { store, post } = await signedInAuth()

        const response = await post('/sign-up/email', {
          email: 'new@example.ru',
          password: 'profile-test-password',
          name: '  Мария  ',
          lastName: '  Петрова ',
          acceptTerms: true,
          acceptPersonalData: true,
          marketing: false,
        })

        expect(response.status).toBe(200)
        const created = store.user!.find((row) => row.email === 'new@example.ru')
        expect(created).toMatchObject({ name: 'Мария', lastName: 'Петрова', emailVerified: false })
        expect(created!.image ?? null).toBeNull()
        // The profile hook rewrites the body the consent log reads its fields from.
        expect(createMany).toHaveBeenCalledTimes(1)
        const rows = createMany.mock.calls[0]![0]!.data as ConsentRow[]
        expect(rows.map((row) => [row.documentType, row.granted])).toEqual([
          ['user_agreement', true],
          ['public_offer', true],
          ['privacy_policy', true],
          ['pii_processing', true],
          ['marketing', false],
        ])
        expect(rows.every((row) => row.userId === created!.id)).toBe(true)
      } finally {
        createMany.mockRestore()
      }
    })

    it('checks the consents before the profile fields', async () => {
      const { post } = await signedInAuth()
      const response = await post('/sign-up/email', {
        email: 'new@example.ru',
        password: 'profile-test-password',
        name: ' ',
      })
      expect(await response.json()).toMatchObject({ code: 'TERMS_NOT_ACCEPTED' })
    })

    it('keeps the User-Agent of a new session within its column', async () => {
      const { auth, store } = await signedInAuth()
      const signIn = (userAgent: string) =>
        auth.handler(
          new Request('https://raditi.ru/api/auth/sign-in/email', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              origin: 'https://raditi.ru',
              'user-agent': userAgent,
            },
            body: JSON.stringify({ email: user.email, password: 'profile-test-password' }),
          }),
        )

      // sessions.user_agent is VarChar(1024): a longer header made the sign-in fail with 500.
      expect((await signIn('M'.repeat(1500))).status).toBe(200)
      expect(store.session!.at(-1)).toMatchObject({ userAgent: 'M'.repeat(1024) })
      expect((await signIn('Mozilla/5.0')).status).toBe(200)
      expect(store.session!.at(-1)).toMatchObject({ userAgent: 'Mozilla/5.0' })
    })
  })

  it('queues the verification, reset and welcome letters', async () => {
    const notifier = makeNotifier()
    const { options } = createAuth({ config, prisma, notifier })
    const url = 'https://raditi.ru/api/auth/verify-email?token=t'

    await options.emailVerification.sendVerificationEmail({ user, url, token: 't' })
    await options.emailAndPassword.sendResetPassword({ user, url, token: 't' })
    await options.emailVerification.afterEmailVerification({ ...user, emailVerified: true })

    const inADay = Date.now() + 24 * 60 * 60 * 1000
    const verify = notifier.verifyEmail.mock.calls[0]![0]
    expect(verify).toMatchObject({ to: user.email, url })
    expect(Math.abs(Date.parse(verify.expiresAt!) - inADay)).toBeLessThan(60_000)
    const reset = notifier.resetPassword.mock.calls[0]![0]
    expect(reset).toMatchObject({ to: user.email, url })
    // Letters with one-time links greet without the name the user typed.
    expect(verify).not.toHaveProperty('name')
    expect(reset).not.toHaveProperty('name')
    expect(notifier.welcome).toHaveBeenCalledWith({
      userId: user.id,
      to: user.email,
      name: 'Анна',
      appUrl: 'https://raditi.ru',
    })
  })
})

describe('sign-in with Yandex ID', () => {
  const yandexConfig: AuthConfig = {
    ...config,
    yandex: { clientId: 'yandex-client', clientSecret: 'yandex-secret' },
  }
  const profile = {
    id: '1130000012345678',
    login: 'anna.ivanova',
    display_name: 'Анна',
    default_email: 'anna@yandex.ru',
    is_avatar_empty: false,
    default_avatar_id: '0/0-0',
  }

  afterEach(() => vi.unstubAllGlobals())

  function yandexAuth(users: Record<string, unknown>[] = []) {
    const store: Record<string, Record<string, unknown>[]> = {
      user: users,
      account: [],
      session: [],
      verification: [],
      rateLimit: [],
    }
    const options = createAuth({ config: yandexConfig, prisma, notifier: makeNotifier() }).options
    const auth = betterAuth({
      ...options,
      database: memoryAdapter(store),
      advanced: { ...options.advanced, database: { generateId: () => randomUUID() } },
      logger: { disabled: true },
    })
    const tokenRequests: URLSearchParams[] = []
    const realFetch = globalThis.fetch
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.href === 'https://oauth.yandex.com/token') {
        tokenRequests.push(new URLSearchParams(String(init?.body)))
        return Response.json({
          access_token: 'yandex-access-token',
          refresh_token: 'yandex-refresh-token',
          token_type: 'bearer',
          expires_in: 3600,
        })
      }
      if (url.origin === 'https://login.yandex.ru') return Response.json(profile)
      return realFetch(input, init)
    })
    return { auth, store, tokenRequests }
  }

  /** The whole round trip: the button, Yandex's consent screen, the callback. */
  async function signIn(auth: ReturnType<typeof yandexAuth>['auth']) {
    const start = await auth.handler(
      new Request('https://raditi.ru/api/auth/sign-in/social', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://raditi.ru' },
        body: JSON.stringify({
          provider: 'yandex',
          callbackURL: '/chats',
          errorCallbackURL: '/sign-in?yandex=failed',
        }),
      }),
    )
    const { url } = (await start.json()) as { url: string }
    const authorize = new URL(url)
    const cookie = start.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ')
    const callback = await auth.handler(
      new Request(
        `https://raditi.ru/api/auth/callback/yandex?code=yandex-code&state=${authorize.searchParams.get('state')}`,
        { headers: { cookie } },
      ),
    )
    return { authorize, callback }
  }

  it('asks for the registered scopes and returns to the registered callback', async () => {
    const { auth, tokenRequests } = yandexAuth()
    const { authorize, callback } = await signIn(auth)

    expect(authorize.origin + authorize.pathname).toBe('https://oauth.yandex.com/authorize')
    expect(authorize.searchParams.get('client_id')).toBe('yandex-client')
    expect(authorize.searchParams.get('scope')).toBe('login:info login:email')
    expect(authorize.searchParams.get('redirect_uri')).toBe(
      'https://raditi.ru/api/auth/callback/yandex',
    )
    expect(tokenRequests[0]?.get('redirect_uri')).toBe('https://raditi.ru/api/auth/callback/yandex')
    expect(callback.status).toBe(302)
    expect(callback.headers.get('location')).toBe('/chats')
    expect(callback.headers.getSetCookie().join(';')).toMatch(/session_token=/)
  })

  it('creates a verified user without the Yandex avatar and keeps no provider tokens', async () => {
    const { auth, store } = yandexAuth()
    await signIn(auth)

    expect(store.user).toHaveLength(1)
    expect(store.user![0]).toMatchObject({
      email: 'anna@yandex.ru',
      name: 'Анна',
      emailVerified: true,
    })
    expect(store.user![0]!.image ?? null).toBeNull()
    expect(store.account).toHaveLength(1)
    expect(store.account![0]).toMatchObject({
      providerId: 'yandex',
      accountId: profile.id,
      accessToken: null,
      refreshToken: null,
      idToken: null,
    })
    expect(JSON.stringify(store)).not.toMatch(/yandex-(access|refresh)-token/)
  })

  it('joins an account whose address was confirmed here', async () => {
    const { auth, store } = yandexAuth([
      { ...user, email: 'anna@yandex.ru', emailVerified: true, lastName: null, image: null },
    ])
    const { callback } = await signIn(auth)

    expect(callback.headers.get('location')).toBe('/chats')
    expect(store.user).toHaveLength(1)
    expect(store.account).toEqual([
      expect.objectContaining({ providerId: 'yandex', userId: user.id }),
    ])
  })

  it('does not join an account whose address nobody confirmed', async () => {
    const { auth, store } = yandexAuth([
      { ...user, email: 'anna@yandex.ru', emailVerified: false, lastName: null, image: null },
    ])
    const { callback } = await signIn(auth)

    expect(callback.headers.get('location')).toBe('/sign-in?yandex=failed&error=account_not_linked')
    expect(store.account).toEqual([])
    expect(store.session).toEqual([])
  })
})
