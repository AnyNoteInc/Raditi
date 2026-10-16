import { describe, expect, it } from 'vitest'

import { yookassaConfigFromEnv } from './config.ts'

const dev = { APP_ENV: 'development' }
const shop = { YOOKASSA_SHOP_ID: '123456', YOOKASSA_SECRET_KEY: 'test_abcdefgh' }
// A shop in production says whether its autopayments are approved.
const live = { ...shop, YOOKASSA_AUTOPAYMENTS: 'on' }
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
      autopayments: true,
    })
    expect(yookassaConfigFromEnv({ APP_ENV: 'production', ...live })).toEqual({
      shopId: '123456',
      secretKey: 'test_abcdefgh',
      autopayments: true,
    })
    // Blank development-only variables are unset, as in a copied .env.example.
    const blank = { YOOKASSA_API_URL: '', YOOKASSA_WEBHOOK_ALLOWLIST: ' ' }
    for (const APP_ENV of ['development', 'production']) {
      const config = yookassaConfigFromEnv({ APP_ENV, ...live, ...blank })
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

  describe('the switch of autopayments', () => {
    const REQUIRED =
      '[yookassa] invalid configuration: YOOKASSA_AUTOPAYMENTS: must be set to on or off in production ' +
      '(YooKassa answers 403 to save_payment_method until its manager approves autopayments for the shop)'

    it.each([
      ['on', true],
      ['off', false],
    ])('reads %s', (YOOKASSA_AUTOPAYMENTS, autopayments) => {
      for (const APP_ENV of ['development', 'test', 'production']) {
        expect(yookassaConfigFromEnv({ APP_ENV, ...shop, YOOKASSA_AUTOPAYMENTS })).toEqual({
          shopId: '123456',
          secretKey: 'test_abcdefgh',
          autopayments,
        })
      }
    })

    it('is on unless set outside production: a local fake saves payment methods', () => {
      for (const APP_ENV of ['development', 'test']) {
        for (const YOOKASSA_AUTOPAYMENTS of [undefined, '', ' ']) {
          expect(yookassaConfigFromEnv({ APP_ENV, ...shop, YOOKASSA_AUTOPAYMENTS })).toMatchObject({
            autopayments: true,
          })
        }
      }
    })

    it('has no default for a shop in production, and says why', () => {
      // A blank value is no value, as everywhere in the environment.
      for (const YOOKASSA_AUTOPAYMENTS of [undefined, '', ' ']) {
        expect(problemsOf({ APP_ENV: 'production', ...shop, YOOKASSA_AUTOPAYMENTS })).toBe(REQUIRED)
      }
    })

    it('is not asked for while payments are off, in production as well', () => {
      expect(yookassaConfigFromEnv({ APP_ENV: 'production' })).toBeNull()
      // Half a shop is the mistake to name, not the switch of a shop that is not there.
      expect(problemsOf({ APP_ENV: 'production', YOOKASSA_SHOP_ID: '123456' })).toBe(
        '[yookassa] invalid configuration: YOOKASSA_SECRET_KEY: YOOKASSA_SHOP_ID and YOOKASSA_SECRET_KEY must be set together',
      )
    })

    it('is checked but not used while payments are off', () => {
      for (const APP_ENV of ['development', 'production']) {
        expect(yookassaConfigFromEnv({ APP_ENV, YOOKASSA_AUTOPAYMENTS: 'off' })).toBeNull()
        expect(problemsOf({ APP_ENV, YOOKASSA_AUTOPAYMENTS: 'maybe' })).toBe(
          '[yookassa] invalid configuration: YOOKASSA_AUTOPAYMENTS: must be on or off',
        )
      }
    })

    it.each([['true'], ['false'], ['1'], ['ON'], ['Off'], ['on,off']])(
      'refuses %s: the value is on or off, as written',
      (YOOKASSA_AUTOPAYMENTS) => {
        for (const APP_ENV of ['development', 'production']) {
          // One problem: a wrong value is not also a missing one.
          expect(problemsOf({ APP_ENV, ...shop, YOOKASSA_AUTOPAYMENTS })).toBe(
            '[yookassa] invalid configuration: YOOKASSA_AUTOPAYMENTS: must be on or off',
          )
        }
      },
    )
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
          autopayments: true,
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
      for (const credentials of [live, {}]) {
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
          ...live,
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
