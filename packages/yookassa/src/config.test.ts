import { describe, expect, it } from 'vitest'

import { yookassaConfigFromEnv } from './config.ts'

describe('yookassaConfigFromEnv', () => {
  it('returns null when payments are not configured', () => {
    expect(yookassaConfigFromEnv({})).toBeNull()
    expect(yookassaConfigFromEnv({ YOOKASSA_SHOP_ID: '', YOOKASSA_SECRET_KEY: ' ' })).toBeNull()
  })

  it('reads the shop credentials', () => {
    expect(
      yookassaConfigFromEnv({ YOOKASSA_SHOP_ID: '123456', YOOKASSA_SECRET_KEY: 'test_abcdefgh' }),
    ).toEqual({ shopId: '123456', secretKey: 'test_abcdefgh' })
  })

  it('requires both values together', () => {
    expect(() => yookassaConfigFromEnv({ YOOKASSA_SHOP_ID: '123456' })).toThrow(
      '[yookassa] invalid configuration: YOOKASSA_SECRET_KEY: YOOKASSA_SHOP_ID and YOOKASSA_SECRET_KEY must be set together',
    )
    expect(() => yookassaConfigFromEnv({ YOOKASSA_SECRET_KEY: 'test_abcdefgh' })).toThrow(
      'YOOKASSA_SHOP_ID: YOOKASSA_SHOP_ID and YOOKASSA_SECRET_KEY must be set together',
    )
  })

  it('names invalid variables without echoing the secret', () => {
    let message = ''
    try {
      yookassaConfigFromEnv({ YOOKASSA_SHOP_ID: 'shop-x', YOOKASSA_SECRET_KEY: 'short' })
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toContain('YOOKASSA_SHOP_ID')
    expect(message).toContain('YOOKASSA_SECRET_KEY')
    expect(message).not.toContain('short')
  })
})
