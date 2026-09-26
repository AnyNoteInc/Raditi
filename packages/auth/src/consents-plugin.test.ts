import { betterAuth } from 'better-auth'
import { memoryAdapter } from 'better-auth/adapters/memory'
import { describe, expect, it, vi } from 'vitest'

import type { ConsentRow } from './consents.ts'
import { consents, parseSignUpConsent } from './consents-plugin.ts'
import { ipAddressOptions } from './request-meta.ts'

function authWithConsents(
  createMany = vi.fn(async (_args: { data: ConsentRow[] }) => ({ count: 0 })),
) {
  const log = vi.fn()
  const auth = betterAuth({
    baseURL: 'http://localhost:3000',
    secret: 'x'.repeat(32),
    database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
    emailAndPassword: { enabled: true, requireEmailVerification: true },
    emailVerification: { sendOnSignUp: true, sendVerificationEmail: async () => {} },
    telemetry: { enabled: false },
    logger: { level: 'debug', log },
    advanced: { ipAddress: ipAddressOptions },
    plugins: [consents({ db: { userConsent: { createMany } } })],
  })
  return { auth, createMany, log }
}

const headers = () =>
  new Headers({ 'x-forwarded-for': '203.0.113.7', 'user-agent': 'Mozilla/5.0 Firefox/150.0' })

const signUp = (
  auth: ReturnType<typeof authWithConsents>['auth'],
  extra: Record<string, unknown>,
) =>
  auth.api.signUpEmail({
    body: { email: 'owner@example.ru', password: 'correct-horse-battery', name: 'Анна', ...extra },
    headers: headers(),
  })

const both = { acceptTerms: true, acceptPersonalData: true } as const

describe('parseSignUpConsent', () => {
  it('returns the consent fields', () => {
    expect(parseSignUpConsent({ ...both, marketing: true, email: 'a@b.ru' })).toEqual({
      ...both,
      marketing: true,
    })
  })

  it('names the first missing checkbox in Russian', () => {
    const terms = /примите пользовательское соглашение/
    expect(() => parseSignUpConsent({ marketing: true })).toThrow(terms)
    expect(() => parseSignUpConsent({ acceptPersonalData: true })).toThrow(terms)
    expect(() => parseSignUpConsent(null)).toThrow(terms)

    const personalData = 'Нужно дать согласие на обработку персональных данных'
    expect(() => parseSignUpConsent({ acceptTerms: true })).toThrow(personalData)
    expect(() => parseSignUpConsent({ acceptTerms: true, marketing: 'yes' })).toThrow(personalData)

    expect(() => parseSignUpConsent({ ...both, marketing: 'yes' })).toThrow(/рассылках/)
  })
})

describe('consents plugin', () => {
  it('rejects a sign-up without the terms and creates no user', async () => {
    const { auth, createMany } = authWithConsents()

    await expect(signUp(auth, { marketing: true })).rejects.toMatchObject({
      status: 'BAD_REQUEST',
      body: { code: 'TERMS_NOT_ACCEPTED' },
    })
    await expect(signUp(auth, { ...both, acceptTerms: 'on' })).rejects.toMatchObject({
      body: { code: 'TERMS_NOT_ACCEPTED' },
    })
    expect(createMany).not.toHaveBeenCalled()
    // The address is still free: the before hook stopped the request before any write.
    await expect(signUp(auth, both)).resolves.toMatchObject({ token: null })
  })

  it('rejects a sign-up without the separate personal data consent', async () => {
    const { auth, createMany } = authWithConsents()

    await expect(signUp(auth, { acceptTerms: true, marketing: true })).rejects.toMatchObject({
      status: 'BAD_REQUEST',
      body: {
        code: 'PERSONAL_DATA_NOT_ACCEPTED',
        message: 'Нужно дать согласие на обработку персональных данных',
      },
    })
    await expect(signUp(auth, { ...both, acceptPersonalData: 'on' })).rejects.toMatchObject({
      body: { code: 'PERSONAL_DATA_NOT_ACCEPTED' },
    })
    expect(createMany).not.toHaveBeenCalled()
    await expect(signUp(auth, both)).resolves.toMatchObject({ token: null })
  })

  it('logs the consents of a new user with the IP and the user agent', async () => {
    const { auth, createMany } = authWithConsents()

    const { user } = await signUp(auth, { ...both, marketing: true })

    expect(createMany).toHaveBeenCalledTimes(1)
    const rows = createMany.mock.calls[0]![0].data
    expect(rows.map((r) => [r.documentType, r.granted])).toEqual([
      ['user_agreement', true],
      ['public_offer', true],
      ['privacy_policy', true],
      ['pii_processing', true],
      ['marketing', true],
    ])
    expect(rows.every((r) => r.userId === user.id && r.source === 'sign_up')).toBe(true)
    expect(rows[0]).toMatchObject({
      ipAddress: '203.0.113.7',
      userAgent: 'Mozilla/5.0 Firefox/150.0',
    })
  })

  it('writes nothing for a repeated sign-up with a taken address', async () => {
    const { auth, createMany } = authWithConsents()
    await signUp(auth, both)

    // better-auth answers with a made-up user so the address cannot be probed.
    const repeated = await signUp(auth, { ...both, marketing: true })

    expect(repeated.user.id).toBeTruthy()
    expect(createMany).toHaveBeenCalledTimes(1)
  })

  it('keeps the new account when the consent log is unavailable', async () => {
    const createMany = vi.fn(async () => {
      throw new Error('connection lost')
    })
    const { auth, log } = authWithConsents(createMany)

    await expect(signUp(auth, both)).resolves.toMatchObject({ token: null })
    expect(log).toHaveBeenCalledWith(
      'error',
      'Could not record sign-up consents',
      expect.anything(),
    )
  })
})
