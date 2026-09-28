import { createPrismaClient } from '@repo/db'
import { afterAll, describe, expect, it, vi } from 'vitest'

import { createAuth, type AuthNotifier } from './auth.ts'
import type { AuthConfig } from './config.ts'

const config: AuthConfig = {
  appEnv: 'test',
  appUrl: 'https://raditi.ru',
  baseUrl: 'https://raditi.ru',
  secret: 'x'.repeat(32),
  captcha: null,
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
    expect(options.plugins.map((p) => p.id)).toEqual(['consents', 'next-cookies'])
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
      'next-cookies',
    ])
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
