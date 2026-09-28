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
  REDIS_URL: 'redis://web:secret@redis:6379',
  SMARTCAPTCHA_SERVER_KEY: `ysc2_${pair}SERVERSECRETPART`,
  SMARTCAPTCHA_CLIENT_KEY: `ysc1_${pair}CLIENTPUBLICPART`,
  DATABASE_URL: 'postgresql://raditi_web:secret@postgres:5432/raditi',
  S3_ENDPOINT: 'https://storage.yandexcloud.net',
  S3_ACCESS_KEY_ID: 'key-id',
  VAULT_ADDR: 'https://vault.internal:8200',
  VAULT_ROLE_ID: 'web-role',
  // A developer's shell may export it; production refuses it.
  VAULT_DEV_ROOT_TOKEN: undefined,
  ...secrets,
}

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
