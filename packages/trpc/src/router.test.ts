import type { Auth, ConsentRow } from '@repo/auth'
import type { PrismaClient } from '@repo/db'
import { legalDocuments } from '@repo/domain'
import type { YookassaClient } from '@repo/yookassa'
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import { describe, expect, it, vi } from 'vitest'

import { CONSENT_REQUIRED, CONSENT_REQUIRED_MESSAGE } from './errors.ts'
import { appRouter, createCaller } from './router.ts'
import {
  consentedProcedure,
  createCallerFactory,
  createContext,
  router,
  type BillingContext,
  type Context,
} from './trpc.ts'

type StoredRow = ConsentRow & { seq: number }

/** In-memory user_consents: newest first by insertion order, like created_at desc. */
function fakePrisma(initial: ConsentRow[] = []) {
  let seq = 0
  const rows: StoredRow[] = initial.map((row) => ({ ...row, seq: ++seq }))
  const userConsent = {
    findMany: vi.fn(async ({ where }: { where: { userId: string } }) =>
      rows
        .filter((row) => row.userId === where.userId)
        .sort((a, b) => b.seq - a.seq)
        .map(({ documentType, granted, documentVersion }) => ({
          documentType,
          granted,
          documentVersion,
        })),
    ),
    createMany: vi.fn(async ({ data }: { data: ConsentRow[] }) => {
      for (const row of data) rows.push({ ...row, seq: ++seq })
      return { count: data.length }
    }),
  }
  return { prisma: { userConsent } as unknown as PrismaClient, rows, userConsent }
}

const now = new Date('2026-09-26T12:00:00Z')
const user = {
  id: '0199a000-0000-7000-8000-000000000001',
  email: 'owner@example.ru',
  name: 'Анна',
  emailVerified: true,
  image: null,
  createdAt: now,
  updatedAt: now,
}
const session = {
  id: '0199a000-0000-7000-8000-000000000002',
  userId: user.id,
  token: 'session-token',
  expiresAt: new Date('2026-10-03T12:00:00Z'),
  createdAt: now,
  updatedAt: now,
}
const headers = () =>
  new Headers({ 'x-forwarded-for': '203.0.113.7', 'user-agent': 'Mozilla/5.0 Firefox/150.0' })

function signedIn(prisma: PrismaClient): Context {
  return { prisma, headers: headers(), session, user, billing: null }
}

function anonymous(prisma: PrismaClient): Context {
  return { prisma, headers: headers(), session: null, user: null, billing: null }
}

const consentDocs = legalDocuments.filter((d) => d.consentType !== null)
const requiredDocs = consentDocs.filter((d) => d.required)
const current = (type: string): string => consentDocs.find((d) => d.consentType === type)!.version

const granted = (
  documentType: ConsentRow['documentType'],
  documentVersion = current(documentType),
): ConsentRow => ({
  userId: user.id,
  documentType,
  documentVersion,
  granted: true,
  source: 'sign_up',
  ipAddress: null,
  userAgent: null,
})

describe('createContext', () => {
  // What the web app builds once per process (paymentShop): the context carries that object.
  const shop: BillingContext = {
    yookassa: { name: 'the shop of the process' } as unknown as YookassaClient,
    appUrl: 'https://raditi.example',
    appEnv: 'test',
    autopayments: true,
    pastDueDays: 7,
  }
  /** better-auth with the session lookup alone: all the context asks it for. */
  function authStub(current: { session: typeof session; user: typeof user } | null) {
    const getSession = vi.fn(async (_request: { headers: Headers }) => current)
    return { auth: { api: { getSession } } as unknown as Auth, getSession }
  }

  it('carries the payment shop it is given, the very object', async () => {
    const { prisma } = fakePrisma()
    const { auth } = authStub(null)

    const ctx = await createContext({ headers: headers(), prisma, auth, billing: shop })

    expect(ctx.billing).toBe(shop)
  })

  it('has no shop unless one is given: payments are switched off', async () => {
    const { prisma } = fakePrisma()
    const { auth } = authStub(null)

    await expect(createContext({ headers: headers(), prisma, auth })).resolves.toMatchObject({
      billing: null,
    })
    await expect(
      createContext({ headers: headers(), prisma, auth, billing: null }),
    ).resolves.toMatchObject({ billing: null })
  })

  it('reads the session behind the request headers and keeps the database client', async () => {
    const { prisma } = fakePrisma()
    const { auth, getSession } = authStub({ session, user })
    const requestHeaders = headers()

    const ctx = await createContext({ headers: requestHeaders, prisma, auth, billing: shop })

    expect(getSession).toHaveBeenCalledExactlyOnceWith({ headers: requestHeaders })
    expect(ctx.session).toBe(session)
    expect(ctx.user).toBe(user)
    expect(ctx.prisma).toBe(prisma)
    expect(ctx.headers).toBe(requestHeaders)
  })

  it('is anonymous without a session, and the router takes it as its context', async () => {
    const { prisma } = fakePrisma()
    const { auth } = authStub(null)

    const ctx = await createContext({ headers: headers(), prisma, auth, billing: shop })

    expect(ctx).toMatchObject({ session: null, user: null })
    await expect(createCaller(ctx).health.ping()).resolves.toEqual({ ok: true })
    await expect(createCaller(ctx).user.me()).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })
})

describe('health.ping', () => {
  it('answers without a session', async () => {
    await expect(createCaller(anonymous(fakePrisma().prisma)).health.ping()).resolves.toEqual({
      ok: true,
    })
  })
})

describe('user.me', () => {
  it('requires a session', async () => {
    await expect(createCaller(anonymous(fakePrisma().prisma)).user.me()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    })
  })

  it('returns the public profile only', async () => {
    await expect(createCaller(signedIn(fakePrisma().prisma)).user.me()).resolves.toEqual({
      id: user.id,
      email: user.email,
      name: 'Анна',
      lastName: null,
      image: null,
      emailVerified: true,
    })
  })
})

describe('consent', () => {
  it('lists every document that takes a consent', async () => {
    const { prisma } = fakePrisma([
      granted('user_agreement'),
      granted('privacy_policy', '2000-01-01'),
    ])

    const list = await createCaller(signedIn(prisma)).consent.list()

    expect(list.map((d) => d.slug)).toEqual(consentDocs.map((d) => d.slug))
    expect(list.find((d) => d.slug === 'user-agreement')).toMatchObject({
      required: true,
      accepted: true,
      acceptedVersion: current('user_agreement'),
    })
    expect(list.find((d) => d.slug === 'privacy-policy')).toMatchObject({
      accepted: false,
      acceptedVersion: '2000-01-01',
    })
    expect(list.find((d) => d.slug === 'marketing-consent')).toMatchObject({
      required: false,
      accepted: false,
      acceptedVersion: null,
    })
  })

  it('requires a session', async () => {
    await expect(createCaller(anonymous(fakePrisma().prisma)).consent.list()).rejects.toMatchObject(
      {
        code: 'UNAUTHORIZED',
      },
    )
  })

  it('accepts everything missing at onboarding and records the request', async () => {
    const { prisma, rows } = fakePrisma()
    const caller = createCaller(signedIn(prisma))

    await expect(
      caller.consent.acceptRequired({
        acceptTerms: true,
        acceptPersonalData: true,
        marketing: false,
      }),
    ).resolves.toEqual({
      written: requiredDocs.length + 1,
    })

    expect(rows.map((r) => [r.documentType, r.granted])).toEqual([
      ...requiredDocs.map((d) => [d.consentType, true]),
      ['marketing', false],
    ])
    expect(rows[0]).toMatchObject({
      userId: user.id,
      source: 'onboarding',
      ipAddress: '203.0.113.7',
      userAgent: 'Mozilla/5.0 Firefox/150.0',
    })
    const list = await caller.consent.list()
    expect(list.filter((d) => d.required).every((d) => d.accepted)).toBe(true)
  })

  it('writes only documents whose accepted edition is outdated', async () => {
    const { prisma, userConsent } = fakePrisma([
      granted('user_agreement', '2000-01-01'),
      granted('public_offer'),
      granted('privacy_policy'),
      granted('pii_processing'),
      { ...granted('marketing'), granted: false },
    ])

    const result = await createCaller(signedIn(prisma)).consent.acceptRequired({
      acceptTerms: true,
      acceptPersonalData: true,
      marketing: false,
    })

    expect(result).toEqual({ written: 1 })
    expect(userConsent.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          documentType: 'user_agreement',
          documentVersion: current('user_agreement'),
        }),
      ],
    })
  })

  it('writes nothing when everything is already accepted', async () => {
    const { prisma, userConsent } = fakePrisma()
    const caller = createCaller(signedIn(prisma))
    await caller.consent.acceptRequired({
      acceptTerms: true,
      acceptPersonalData: true,
      marketing: true,
    })

    await expect(
      caller.consent.acceptRequired({
        acceptTerms: true,
        acceptPersonalData: true,
        marketing: true,
      }),
    ).resolves.toEqual({
      written: 0,
    })
    expect(userConsent.createMany).toHaveBeenCalledTimes(1)
  })

  it('refuses without either required checkbox', async () => {
    const { prisma, userConsent } = fakePrisma()
    const caller = createCaller(signedIn(prisma))
    const both = { acceptTerms: true, acceptPersonalData: true, marketing: false } as const
    const { acceptPersonalData: _omitted, ...termsOnly } = both

    for (const input of [
      { ...both, acceptTerms: false },
      { ...both, acceptPersonalData: false },
      termsOnly,
    ]) {
      await expect(
        caller.consent.acceptRequired(input as unknown as typeof both),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    }
    expect(userConsent.createMany).not.toHaveBeenCalled()
  })

  it('toggles marketing from the settings and skips repeats', async () => {
    const { prisma, rows } = fakePrisma()
    const caller = createCaller(signedIn(prisma))

    await expect(caller.consent.setMarketing({ granted: true })).resolves.toEqual({ changed: true })
    await expect(caller.consent.setMarketing({ granted: true })).resolves.toEqual({
      changed: false,
    })
    await expect(caller.consent.setMarketing({ granted: false })).resolves.toEqual({
      changed: true,
    })

    expect(rows.map((r) => [r.documentType, r.granted, r.source])).toEqual([
      ['marketing', true, 'settings'],
      ['marketing', false, 'settings'],
    ])
  })
})

describe('consentedProcedure', () => {
  const businessRouter = router({ sites: consentedProcedure.query(() => ['site-1']) })
  const createBusinessCaller = createCallerFactory(businessRouter)
  const allRequired = () => requiredDocs.map((d) => granted(d.consentType))

  it('lets a user with every current required consent through', async () => {
    const { prisma } = fakePrisma(allRequired())
    await expect(createBusinessCaller(signedIn(prisma)).sites()).resolves.toEqual(['site-1'])
  })

  it('does not need the marketing consent', async () => {
    const { prisma } = fakePrisma([...allRequired(), { ...granted('marketing'), granted: false }])
    await expect(createBusinessCaller(signedIn(prisma)).sites()).resolves.toEqual(['site-1'])
  })

  it.each([
    ['no consents at all', []],
    [
      'an outdated edition',
      [...allRequired().slice(1), granted(requiredDocs[0]!.consentType, '2000-01-01')],
    ],
    ['a withdrawn consent', [...allRequired(), { ...granted('pii_processing'), granted: false }]],
    ['a missing document', allRequired().slice(1)],
  ])('stops a user with %s', async (_case, rows: ConsentRow[]) => {
    const { prisma } = fakePrisma(rows)
    const error = await createBusinessCaller(signedIn(prisma))
      .sites()
      .catch((e: unknown) => e)

    expect(error).toMatchObject({
      code: 'PRECONDITION_REQUIRED',
      message: CONSENT_REQUIRED_MESSAGE,
      cause: { code: CONSENT_REQUIRED },
    })
  })

  it('asks for a session first', async () => {
    const { prisma, userConsent } = fakePrisma()
    await expect(createBusinessCaller(anonymous(prisma)).sites()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    })
    expect(userConsent.findMany).not.toHaveBeenCalled()
  })

  it('opens after the user accepts the documents, while consent.* and user.me stay open', async () => {
    const { prisma } = fakePrisma()
    const ctx = signedIn(prisma)

    await expect(createCaller(ctx).user.me()).resolves.toMatchObject({ id: user.id })
    await expect(createCaller(ctx).consent.list()).resolves.not.toHaveLength(0)
    await expect(createBusinessCaller(ctx).sites()).rejects.toMatchObject({
      code: 'PRECONDITION_REQUIRED',
    })

    await createCaller(ctx).consent.acceptRequired({
      acceptTerms: true,
      acceptPersonalData: true,
      marketing: false,
    })

    await expect(createBusinessCaller(ctx).sites()).resolves.toEqual(['site-1'])
  })

  // Stopping the charges does not wait for a consent: a user who has not accepted a new
  // edition of the documents may still unlink the payment method and switch auto-renewal off
  // (default «н» of docs/plan/37-billing-plan.md). Such a user is sent to the page that asks
  // for the consent, so that page has to show the coming charge and the way to stop it:
  // `billing.autoRenewal` reads only what its block shows. Every other billing procedure is
  // guarded.
  const openToEveryUser = [
    'billing.unlinkPaymentMethod',
    'billing.cancelAutoRenew',
    'billing.autoRenewal',
  ]

  it('guards every procedure of the app router except consent.*, user.me, health and what stops the charges', async () => {
    const open = (path: string) =>
      path === 'user.me' || /^(?:consent|health)\./.test(path) || openToEveryUser.includes(path)
    const paths = Object.keys(appRouter._def.procedures)
    // The exception is a procedure that exists: a renamed one must not leave the list behind.
    expect(paths).toEqual(expect.arrayContaining(openToEveryUser))
    const guarded = paths.filter((path) => !open(path))
    expect(guarded).toEqual(
      expect.arrayContaining([
        'user.updateProfile',
        'project.list',
        'project.create',
        'billing.overview',
        'billing.plans',
        'billing.usage',
        'billing.usageHistory',
        'billing.payments',
        'billing.startCheckout',
        'billing.startPackCheckout',
        'billing.syncOrder',
        'billing.startPaymentMethodChange',
        'billing.syncPaymentMethod',
        'billing.startPastDuePayment',
        'billing.resumeAutoRenew',
        'billing.schedulePlanChange',
        'billing.cancelPlanChange',
      ]),
    )
    // Nothing else of billing is open: three procedures, and none that pays or switches on.
    expect(paths.filter((path) => path.startsWith('billing.') && open(path)).sort()).toEqual(
      [...openToEveryUser].sort(),
    )

    for (const path of guarded) {
      const { prisma } = fakePrisma()
      const procedure = path
        .split('.')
        .reduce<unknown>(
          (node, key) => (node as Record<string, unknown>)[key],
          createCaller(signedIn(prisma)),
        ) as (input?: unknown) => Promise<unknown>
      // The consent check precedes input validation, so no valid input is needed.
      await expect(procedure(), path).rejects.toMatchObject({
        code: 'PRECONDITION_REQUIRED',
        cause: { code: CONSENT_REQUIRED },
      })
    }
  })

  it('asks a signed-in user for no consent before the charges are stopped or shown', async () => {
    for (const path of openToEveryUser) {
      const call = (ctx: Context) =>
        path
          .split('.')
          .reduce<unknown>(
            (node, key) => (node as Record<string, unknown>)[key],
            createCaller(ctx),
          ) as (input?: unknown) => Promise<unknown>
      const { prisma, userConsent } = fakePrisma()

      // Past the guard the procedure reads tables this fake does not have: whatever it fails
      // with, it is not the demand to accept the documents.
      const error = await call(signedIn(prisma))({}).catch((thrown: unknown) => thrown)

      expect(error, path).toMatchObject({ code: 'INTERNAL_SERVER_ERROR' })
      expect(userConsent.findMany, path).not.toHaveBeenCalled()
      // A session it does need.
      await expect(call(anonymous(prisma))({}), path).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      })
    }
  })

  it('answers over HTTP with 428, the domain code and the Russian text', async () => {
    const response = await fetchRequestHandler({
      endpoint: '/api/trpc',
      req: new Request('http://localhost:3000/api/trpc/sites'),
      router: businessRouter,
      createContext: () => signedIn(fakePrisma().prisma),
    })

    expect(response.status).toBe(428)
    const body = (await response.json()) as { error: { json: { message: string; data: object } } }
    expect(body.error.json.message).toBe(CONSENT_REQUIRED_MESSAGE)
    expect(body.error.json.data).toEqual({
      code: 'PRECONDITION_REQUIRED',
      httpStatus: 428,
      path: 'sites',
      domainCode: CONSENT_REQUIRED,
    })
  })
})

describe('over HTTP', () => {
  const call = (path: string, ctx: Context) =>
    fetchRequestHandler({
      endpoint: '/api/trpc',
      req: new Request(`http://localhost:3000/api/trpc/${path}`),
      router: appRouter,
      createContext: () => ctx,
    })

  it('serializes with superjson', async () => {
    const response = await call('health.ping', anonymous(fakePrisma().prisma))
    await expect(response.json()).resolves.toEqual({ result: { data: { json: { ok: true } } } })
  })

  it('sends a Russian UNAUTHORIZED without a stack trace', async () => {
    const response = await call('user.me', anonymous(fakePrisma().prisma))

    expect(response.status).toBe(401)
    const body = (await response.json()) as { error: { json: { message: string; data: object } } }
    expect(body.error.json.message).toBe('Войдите, чтобы продолжить')
    expect(body.error.json.data).toEqual({
      code: 'UNAUTHORIZED',
      httpStatus: 401,
      path: 'user.me',
      domainCode: null,
    })
  })

  it('answers invalid input with a generic Russian text instead of zod issues', async () => {
    const response = await fetchRequestHandler({
      endpoint: '/api/trpc',
      req: new Request('http://localhost:3000/api/trpc/consent.acceptRequired', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ json: { acceptTerms: false, acceptPersonalData: true } }),
      }),
      router: appRouter,
      createContext: () => signedIn(fakePrisma().prisma),
    })

    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { json: { message: string; data: object } } }
    expect(body.error.json.message).toBe('Проверьте введённые данные')
    expect(JSON.stringify(body)).not.toMatch(/expected|invalid_value|acceptTerms/i)
  })
})
