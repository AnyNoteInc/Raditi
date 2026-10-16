import { afterEach, describe, expect, it, vi } from 'vitest'

const pair = 'P'.repeat(20)
const secrets = {
  BETTER_AUTH_SECRET: 'better-auth-secret-'.padEnd(40, 'x'),
  S3_SECRET_ACCESS_KEY: 'very-secret-s3-key',
  VAULT_SECRET_ID: 'web-secret-id',
}

/** Every section web reads, as the app VM gives them to it. */
const production = {
  NEXT_RUNTIME: 'nodejs',
  APP_ENV: 'production',
  APP_URL: 'https://raditi.ru',
  BETTER_AUTH_URL: 'https://raditi.ru',
  METRICS_TOKEN: 'test-metrics-token-'.padEnd(32, 'x'),
  REDIS_URL: 'redis://:secret@redis:6379',
  SMARTCAPTCHA_SERVER_KEY: `ysc2_${pair}SERVERSECRETPART`,
  SMARTCAPTCHA_CLIENT_KEY: `ysc1_${pair}CLIENTPUBLICPART`,
  DATABASE_URL: 'postgresql://raditi:secret@postgres:5432/raditi',
  S3_ENDPOINT: 'https://storage.yandexcloud.net',
  S3_ACCESS_KEY_ID: 'key-id',
  VAULT_ADDR: 'https://vault.internal:8200',
  VAULT_ROLE_ID: 'web-role',
  // A developer's shell may export it; production refuses it.
  VAULT_DEV_ROOT_TOKEN: undefined,
  // Payments are off until the shop is connected; the address of a fake and its senders are
  // never set in production, the switch of autopayments only with a shop.
  YOOKASSA_SHOP_ID: undefined,
  YOOKASSA_SECRET_KEY: undefined,
  YOOKASSA_API_URL: undefined,
  YOOKASSA_WEBHOOK_ALLOWLIST: undefined,
  YOOKASSA_AUTOPAYMENTS: undefined,
  ...secrets,
}

const credentials = { YOOKASSA_SHOP_ID: '123456', YOOKASSA_SECRET_KEY: 'live_shop-secret-key' }
// A shop in production says whether ЮKassa has approved its autopayments.
const shop = { ...credentials, YOOKASSA_AUTOPAYMENTS: 'on' }

/** A fresh module graph: env.ts remembers what it parsed. */
async function withEnv(values: Record<string, string | undefined>) {
  vi.resetModules()
  for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value)
  return {
    ...(await import('./config-check')),
    register: (await import('../instrumentation')).register,
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

// Every case imports the server modules afresh: slow on a loaded machine, not stuck.
describe('brokenSections', { timeout: 30_000 }, () => {
  it('finds nothing broken in complete production settings', async () => {
    const { brokenSections } = await withEnv(production)
    expect(brokenSections()).toEqual([])
  })

  it('names every broken section in order, and nothing else', async () => {
    const { brokenSections } = await withEnv({
      ...production,
      BETTER_AUTH_SECRET: undefined,
      S3_ENDPOINT: 'ftp://storage.yandexcloud.net',
      DATABASE_URL: undefined,
    })
    expect(brokenSections()).toEqual(['auth', 'storage', 'db'])
    expect(
      brokenSections({
        a: () => 1,
        b: () => {
          throw new Error(`leaks ${secrets.S3_SECRET_ACCESS_KEY}`)
        },
      }),
    ).toEqual(['b'])
  })

  it('takes payments switched off or a complete shop, and nothing in between', async () => {
    expect((await withEnv({ ...production, ...shop })).brokenSections()).toEqual([])
    for (const half of [
      { YOOKASSA_SHOP_ID: shop.YOOKASSA_SHOP_ID },
      { YOOKASSA_SECRET_KEY: shop.YOOKASSA_SECRET_KEY },
    ]) {
      expect((await withEnv({ ...production, ...half })).brokenSections()).toEqual(['yookassa'])
    }
  })

  it('wants a shop in production to say whether its autopayments are approved', async () => {
    // Not guessed: ЮKassa answers 403 to a payment that saves its method until they are.
    expect((await withEnv({ ...production, ...credentials })).brokenSections()).toEqual([
      'yookassa',
    ])
    for (const YOOKASSA_AUTOPAYMENTS of ['on', 'off']) {
      const { brokenSections } = await withEnv({
        ...production,
        ...credentials,
        YOOKASSA_AUTOPAYMENTS,
      })
      expect(brokenSections()).toEqual([])
      const { env } = await import('@/env')
      expect(env.yookassa()).toMatchObject({ autopayments: YOOKASSA_AUTOPAYMENTS === 'on' })
    }
    // Outside production the switch is on unless set: a local fake saves payment methods.
    const development = await withEnv({ ...production, ...credentials, APP_ENV: 'development' })
    expect(development.brokenSections()).toEqual([])
    expect((await import('@/env')).env.yookassa()).toMatchObject({ autopayments: true })
  })

  it('refuses the settings of a local fake ЮKassa in production, with payments on or off', async () => {
    for (const fake of [
      { YOOKASSA_API_URL: 'http://127.0.0.1:4010/v3' },
      { YOOKASSA_WEBHOOK_ALLOWLIST: '127.0.0.1' },
    ]) {
      for (const configured of [shop, {}]) {
        const { brokenSections } = await withEnv({ ...production, ...configured, ...fake })
        expect(brokenSections()).toEqual(['yookassa'])
      }
    }
  })

  it('takes the settings of a local fake ЮKassa outside production', async () => {
    const { brokenSections } = await withEnv({
      ...production,
      ...shop,
      APP_ENV: 'development',
      YOOKASSA_API_URL: 'http://127.0.0.1:4010/v3',
      YOOKASSA_WEBHOOK_ALLOWLIST: '127.0.0.1, ::1',
    })
    expect(brokenSections()).toEqual([])
    const { env } = await import('@/env')
    expect(env.yookassa()).toEqual({
      shopId: shop.YOOKASSA_SHOP_ID,
      secretKey: shop.YOOKASSA_SECRET_KEY,
      baseUrl: 'http://127.0.0.1:4010/v3',
      webhookAllowlist: ['127.0.0.1', '::1'],
      autopayments: true,
    })
  })
})

describe('register', { timeout: 30_000 }, () => {
  function stubExit() {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    return { exit, error }
  }

  it('stops a production server with broken settings, naming the sections only', async () => {
    const { register } = await withEnv({
      ...production,
      SMARTCAPTCHA_CLIENT_KEY: undefined,
      VAULT_ADDR: `http://${secrets.VAULT_SECRET_ID}@vault.internal:8200`,
    })
    const { exit, error } = stubExit()
    await register()
    expect(exit).toHaveBeenCalledWith(1)
    expect(error).toHaveBeenCalledExactlyOnceWith('web: broken production settings: auth, vault')
    expect(JSON.stringify(error.mock.calls)).not.toMatch(
      new RegExp(Object.values(secrets).join('|')),
    )
  })

  it('stops a production server with half of the shop credentials, without leaking the key', async () => {
    const { register } = await withEnv({
      ...production,
      YOOKASSA_SECRET_KEY: shop.YOOKASSA_SECRET_KEY,
    })
    const { exit, error } = stubExit()
    await register()
    expect(exit).toHaveBeenCalledWith(1)
    expect(error).toHaveBeenCalledExactlyOnceWith('web: broken production settings: yookassa')
    expect(JSON.stringify(error.mock.calls)).not.toContain(shop.YOOKASSA_SECRET_KEY)
  })

  it('starts with complete production settings', async () => {
    const { register } = await withEnv(production)
    const { exit, error } = stubExit()
    await register()
    expect(exit).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })

  it('stays lazy outside production and in the edge runtime', async () => {
    for (const values of [
      { APP_ENV: 'development' },
      { APP_ENV: 'test' },
      { NEXT_RUNTIME: 'edge' },
      { APP_ENV: undefined },
    ]) {
      const { register } = await withEnv({
        ...production,
        BETTER_AUTH_SECRET: undefined,
        ...values,
      })
      const { exit } = stubExit()
      await register()
      expect(exit).not.toHaveBeenCalled()
    }
  })
})
