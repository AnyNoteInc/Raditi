// The settings of the billing run (playwright.billing.config.ts). The config starts web and the
// fake ЮKassa with them, the fixtures in the test workers build the same better-auth instance
// from them. Playwright evaluates this module in every process, so everything here is a constant
// or comes from the environment of the run; nothing is read from a file.

function port(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65_535)
    throw new Error(`${name} must be a port from 1024 to 65535`)
  return parsed
}

// Not 3100 of the smoke and landing runs. The two names are set for one run only: nothing reads
// them from .env, and the e2e scripts are not Turbo tasks.
// eslint-disable-next-line turbo/no-undeclared-env-vars -- Port of a local run, outside Turbo tasks.
const WEB_PORT = port(process.env.E2E_BILLING_WEB_PORT, 'E2E_BILLING_WEB_PORT', 3110)
const YOOKASSA_PORT = port(
  // eslint-disable-next-line turbo/no-undeclared-env-vars -- Port of a local run, outside Turbo tasks.
  process.env.E2E_BILLING_YOOKASSA_PORT,
  'E2E_BILLING_YOOKASSA_PORT',
  4110,
)
if (WEB_PORT === YOOKASSA_PORT)
  throw new Error('E2E_BILLING_WEB_PORT and E2E_BILLING_YOOKASSA_PORT must differ')

/** The origin of web in this run; the session cookie belongs to its host. */
export const baseURL = `http://localhost:${WEB_PORT}`
export const webPort = WEB_PORT

const yookassaOrigin = `http://127.0.0.1:${YOOKASSA_PORT}`

/** The fake ЮKassa of infra/dev/billing-verify: its API for web and its commands for the tests. */
export const fakeYookassa = {
  port: YOOKASSA_PORT,
  apiUrl: `${yookassaOrigin}/v3`,
  controlUrl: `${yookassaOrigin}/__control`,
  /** Where the fake sends notifications. */
  webhookUrl: `${baseURL}/api/webhooks/yookassa`,
} as const

/**
 * What better-auth is built from, in web and in the sign-in fixture alike: a session cookie the
 * fixture signs is one web accepts. The secret is synthetic and guards nothing: the run works on
 * a disposable database. The captcha stays off whatever a developer's .env says.
 */
export const authEnv = {
  APP_ENV: 'test',
  APP_URL: baseURL,
  BETTER_AUTH_URL: baseURL,
  BETTER_AUTH_SECRET: 'synthetic-secret-of-the-e2e-billing-run',
  SMARTCAPTCHA_SERVER_KEY: '',
  SMARTCAPTCHA_CLIENT_KEY: '',
} as const

/** The shop of the fake: synthetic credentials, no real shop exists. */
export const yookassaShop = {
  YOOKASSA_SHOP_ID: '100500',
  YOOKASSA_SECRET_KEY: 'test_synthetic-e2e-key',
} as const

/**
 * The database of the run, from the environment only. The repository .env names the working
 * development database, and a test user must never be written there by mistake.
 */
export function databaseUrl(): string {
  const url = process.env.DATABASE_URL
  if (url === undefined || url.trim() === '')
    throw new Error(
      'DATABASE_URL is not set. The billing run works on the database named in the environment ' +
        '(migrations and seeds applied) and never reads .env: export DATABASE_URL and run again.',
    )
  return url
}
