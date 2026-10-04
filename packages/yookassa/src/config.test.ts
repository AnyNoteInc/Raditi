import { describe, expect, it } from 'vitest'

import { yookassaConfigFromEnv } from './config.ts'

const dev = { APP_ENV: 'development' }
const shop = { YOOKASSA_SHOP_ID: '123456', YOOKASSA_SECRET_KEY: 'test_abcdefgh' }
const problemsOf = (env: Record<string, string | undefined>) => {
  try {
    yookassaConfigFromEnv(env)
  } catch (err) {
    return (err as Error).message
  }
  throw new Error('expected an error')
}

describe('yookassaConfigFromEnv', () => {
  it('returns null when payments are not configured', () => {
    expect(yookassaConfigFromEnv(dev)).toBeNull()
    expect(
      yookassaConfigFromEnv({ ...dev, YOOKASSA_SHOP_ID: '', YOOKASSA_SECRET_KEY: ' ' }),
    ).toBeNull()
    expect(yookassaConfigFromEnv({ APP_ENV: 'production' })).toBeNull()
  })

  it('reads the shop credentials', () => {
    expect(yookassaConfigFromEnv({ ...dev, ...shop })).toEqual({
      shopId: '123456',
      secretKey: 'test_abcdefgh',
    })
    expect(yookassaConfigFromEnv({ APP_ENV: 'production', ...shop })).toEqual({
      shopId: '123456',
      secretKey: 'test_abcdefgh',
    })
    // Blank development-only variables are unset, as in a copied .env.example.
    const blank = { YOOKASSA_API_URL: '', YOOKASSA_WEBHOOK_ALLOWLIST: ' ' }
    for (const APP_ENV of ['development', 'production']) {
      const config = yookassaConfigFromEnv({ APP_ENV, ...shop, ...blank })
      expect(config).not.toHaveProperty('baseUrl')
      expect(config).not.toHaveProperty('webhookAllowlist')
    }
  })

  it('requires both values together', () => {
    expect(() => yookassaConfigFromEnv({ ...dev, YOOKASSA_SHOP_ID: '123456' })).toThrow(
      '[yookassa] invalid configuration: YOOKASSA_SECRET_KEY: YOOKASSA_SHOP_ID and YOOKASSA_SECRET_KEY must be set together',
    )
    expect(() => yookassaConfigFromEnv({ ...dev, YOOKASSA_SECRET_KEY: 'test_abcdefgh' })).toThrow(
      'YOOKASSA_SHOP_ID: YOOKASSA_SHOP_ID and YOOKASSA_SECRET_KEY must be set together',
    )
  })

  it('names invalid variables without echoing the secret', () => {
    const message = problemsOf({ ...dev, YOOKASSA_SHOP_ID: 'shop-x', YOOKASSA_SECRET_KEY: 'short' })
    expect(message).toContain('YOOKASSA_SHOP_ID')
    expect(message).toContain('YOOKASSA_SECRET_KEY')
    expect(message).not.toContain('short')
  })

  it('requires APP_ENV: a missing or misspelt one never switches the production rules off', () => {
    for (const APP_ENV of [undefined, '', 'prod']) {
      expect(() =>
        yookassaConfigFromEnv({ APP_ENV, ...shop, YOOKASSA_API_URL: 'http://127.0.0.1:4010/v3' }),
      ).toThrow(
        '[yookassa] invalid configuration: APP_ENV: must be one of development, test, production',
      )
    }
  })

  describe('the address of a local fake and its notification senders', () => {
    it('reads both outside production', () => {
      for (const APP_ENV of ['development', 'test']) {
        expect(
          yookassaConfigFromEnv({
            APP_ENV,
            ...shop,
            YOOKASSA_API_URL: 'http://127.0.0.1:4010/v3/',
            YOOKASSA_WEBHOOK_ALLOWLIST: ' 127.0.0.1 , ::1,10.20.0.0/24 ',
          }),
        ).toEqual({
          shopId: '123456',
          secretKey: 'test_abcdefgh',
          baseUrl: 'http://127.0.0.1:4010/v3',
          webhookAllowlist: ['127.0.0.1', '::1', '10.20.0.0/24'],
        })
      }
    })

    it('checks them but stays off while payments are off', () => {
      expect(
        yookassaConfigFromEnv({
          ...dev,
          YOOKASSA_API_URL: 'http://127.0.0.1:4010/v3',
          YOOKASSA_WEBHOOK_ALLOWLIST: '127.0.0.1',
        }),
      ).toBeNull()
      expect(problemsOf({ ...dev, YOOKASSA_API_URL: 'localhost:4010' })).toContain(
        'YOOKASSA_API_URL',
      )
    })

    it('refuses both in production, with payments on or off, naming only the variables', () => {
      const fake = {
        YOOKASSA_API_URL: 'http://fake.internal:4010/v3',
        YOOKASSA_WEBHOOK_ALLOWLIST: '203.0.113.7',
      }
      for (const credentials of [shop, {}]) {
        const message = problemsOf({ APP_ENV: 'production', ...credentials, ...fake })
        expect(message).toBe(
          '[yookassa] invalid configuration: ' +
            'YOOKASSA_API_URL: not allowed in production (the real API address is built in); ' +
            'YOOKASSA_WEBHOOK_ALLOWLIST: not allowed in production (notifications come from the published ranges only)',
        )
      }
      // The real API address spelt out is refused as well: production takes no address at all.
      expect(
        problemsOf({
          APP_ENV: 'production',
          ...shop,
          YOOKASSA_API_URL: 'https://api.yookassa.ru/v3',
        }),
      ).toContain('YOOKASSA_API_URL: not allowed in production')
    })

    it.each([
      ['a relative address', '/v3'],
      ['a host without a scheme', '127.0.0.1:4010/v3'],
      ['another scheme', 'ftp://127.0.0.1/v3'],
    ])('refuses %s as the API address', (_label, YOOKASSA_API_URL) => {
      const message = problemsOf({ ...dev, ...shop, YOOKASSA_API_URL })
      expect(message).toBe(
        '[yookassa] invalid configuration: YOOKASSA_API_URL: must be an http(s) URL',
      )
    })

    it.each([
      ['credentials', 'http://shop:hunter2-key@127.0.0.1:4010/v3'],
      ['a query', 'http://127.0.0.1:4010/v3?key=hunter2-key'],
      ['a fragment', 'http://127.0.0.1:4010/v3#hunter2-key'],
    ])('refuses an API address with %s, without echoing it', (_label, YOOKASSA_API_URL) => {
      const message = problemsOf({ ...dev, ...shop, YOOKASSA_API_URL })
      expect(message).toBe(
        '[yookassa] invalid configuration: YOOKASSA_API_URL: expected an address without credentials, query or fragment',
      )
      expect(message).not.toContain('hunter2')
    })

    it.each([
      ['a host name', 'localhost'],
      ['a prefix beyond the family', '127.0.0.1/33'],
      ['an address with a port', '127.0.0.1:3000'],
      ['a trailing comma', '127.0.0.1,'],
      ['commas alone', ' , '],
      ['a broken entry among valid ones', '127.0.0.1, ::1/129, 10.0.0.0/8'],
    ])('refuses %s in the allowlist, without echoing it', (_label, YOOKASSA_WEBHOOK_ALLOWLIST) => {
      const message = problemsOf({ ...dev, ...shop, YOOKASSA_WEBHOOK_ALLOWLIST })
      expect(message).toBe(
        '[yookassa] invalid configuration: YOOKASSA_WEBHOOK_ALLOWLIST: must be IP addresses or CIDR ranges separated by commas',
      )
    })
  })
})
