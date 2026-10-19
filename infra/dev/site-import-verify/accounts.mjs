// Cabinet users of the stand: signed up, confirmed and signed in through the server API of
// @repo/auth on the stand's own database, as apps/e2e/fixtures/signed-in.ts does it for the
// billing run — the auth instance is built from the settings web runs with, so web accepts the
// session cookie it signs. The letters stay in memory: nobody delivers them here.
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const COOKIE_NAME = /^[A-Za-z0-9_.-]+$/

/** One Set-Cookie header as the browser and the stand's own requests send it back. */
export function sessionCookie(header, host) {
  const [pair = '', ...attributes] = header.split(';').map((part) => part.trim())
  const separator = pair.indexOf('=')
  const name = pair.slice(0, separator)
  if (separator < 1 || !COOKIE_NAME.test(name))
    throw new Error('A Set-Cookie header without a name')
  const flags = new Map(
    attributes.map((text) => {
      const [key = '', ...value] = text.split('=')
      return [key.toLowerCase(), value.join('=')]
    }),
  )
  return {
    name,
    value: pair.slice(separator + 1),
    domain: host,
    path: flags.get('path') || '/',
    httpOnly: flags.has('httponly'),
    secure: flags.has('secure'),
    sameSite: 'Lax',
  }
}

/** The Cookie header of a set of cookies. */
export const cookieHeader = (cookies) =>
  cookies.map(({ name, value }) => `${name}=${value}`).join('; ')

/**
 * Signs up one user per id (`site-import-<id>-<random>@example.ru`, both required consents),
 * opens the link of the confirmation letter and keeps the cookies of the session it opened.
 * Resolves to `{ accounts: { [id]: { userId, email, cookies, cookie } }, close }`.
 */
export async function createAccounts({ repository, databaseUrl, webEnv, ids }) {
  const { authConfigFromEnv, createAuth } = await import(
    pathToFileURL(join(repository, 'packages/auth/src/index.ts')).href
  )
  const { createPrismaClient } = await import(
    pathToFileURL(join(repository, 'packages/db/src/index.ts')).href
  )
  const prisma = createPrismaClient({ databaseUrl, log: [] })
  const links = new Map()
  const notifier = {
    verifyEmail: async ({ to, url }) => {
      links.set(to, url)
    },
    resetPassword: async () => undefined,
    welcome: async () => undefined,
  }
  const authEnv = Object.fromEntries(
    [
      'APP_ENV',
      'APP_URL',
      'BETTER_AUTH_URL',
      'BETTER_AUTH_SECRET',
      'SMARTCAPTCHA_SERVER_KEY',
      'SMARTCAPTCHA_CLIENT_KEY',
    ].map((key) => [key, webEnv[key] ?? '']),
  )
  const auth = createAuth({ config: authConfigFromEnv(authEnv), prisma, notifier })
  const host = new URL(webEnv.APP_URL).hostname
  const accounts = {}
  try {
    for (const id of ids) {
      const email = `site-import-${id}-${randomBytes(4).toString('hex')}@example.ru`
      const { user } = await auth.api.signUpEmail({
        body: {
          name: 'Анна',
          lastName: 'Проверкина',
          email,
          password: randomBytes(18).toString('base64url'),
          acceptTerms: true,
          acceptPersonalData: true,
          marketing: false,
        },
      })
      const link = links.get(email)
      links.delete(email)
      const token = link ? new URL(link).searchParams.get('token') : null
      if (!token) throw new Error('The sign-up sent no confirmation letter')
      const verified = await auth.api.verifyEmail({ query: { token }, asResponse: true })
      const cookies = verified.headers.getSetCookie().map((header) => sessionCookie(header, host))
      if (!verified.ok || cookies.length === 0)
        throw new Error(`The confirmation link opened no session (HTTP ${verified.status})`)
      accounts[id] = { userId: user.id, email, cookies, cookie: cookieHeader(cookies) }
    }
  } finally {
    await prisma.$disconnect()
  }
  return accounts
}
