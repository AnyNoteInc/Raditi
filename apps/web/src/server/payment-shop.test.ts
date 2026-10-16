import type * as YookassaModule from '@repo/yookassa'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The module with the settings and the client factory replaced: the test sees what the shop
// of the process is built from and how often.
const stand = vi.hoisted(() => ({
  client: { name: 'yookassa client' },
  createYookassaClient: vi.fn(),
  yookassaEnv: vi.fn(),
  webEnv: vi.fn(),
}))

vi.mock('@/env', () => ({ env: { web: stand.webEnv, yookassa: stand.yookassaEnv } }))
vi.mock('@repo/yookassa', async (importOriginal) => ({
  ...(await importOriginal<typeof YookassaModule>()),
  createYookassaClient: stand.createYookassaClient,
}))

const LOCAL_SHOP = {
  shopId: '123456',
  secretKey: 'test_synthetic-key',
  baseUrl: 'http://127.0.0.1:4010/v3',
  autopayments: true,
}

describe('the payment shop of the process', () => {
  beforeEach(() => {
    // The module keeps what it built: every test gets a new one.
    vi.resetModules()
    stand.createYookassaClient.mockReset().mockReturnValue(stand.client)
    stand.yookassaEnv.mockReset().mockReturnValue(LOCAL_SHOP)
    stand.webEnv.mockReset().mockReturnValue({
      appEnv: 'test',
      appUrl: 'https://raditi.example',
      pastDueDays: 14,
    })
  })

  it('reads nothing when the module is imported', async () => {
    await import('./payment-shop')

    expect(stand.yookassaEnv).not.toHaveBeenCalled()
    expect(stand.webEnv).not.toHaveBeenCalled()
    expect(stand.createYookassaClient).not.toHaveBeenCalled()
  })

  it('is the client of the shop settings with the origin and the environment of the app', async () => {
    const { paymentShop } = await import('./payment-shop')

    expect(paymentShop()).toEqual({
      yookassa: stand.client,
      appUrl: 'https://raditi.example',
      appEnv: 'test',
      // The shop saves payment methods: auto-renewal is offered.
      autopayments: true,
      // The grace the core role ends an overdue tariff by: the pages name its last day.
      pastDueDays: 14,
    })
    expect(stand.createYookassaClient).toHaveBeenCalledExactlyOnceWith(LOCAL_SHOP)
  })

  it('carries the switch of a shop that takes one-time payments only', async () => {
    stand.yookassaEnv.mockReturnValue({ ...LOCAL_SHOP, autopayments: false })
    const { paymentShop } = await import('./payment-shop')

    // What the billing procedures refuse auto-renewal by and the pages hide it by.
    expect(paymentShop()).toMatchObject({ yookassa: stand.client, autopayments: false })
  })

  it('builds one client for the life of the process', async () => {
    const { paymentShop } = await import('./payment-shop')

    const first = paymentShop()
    expect(paymentShop()).toBe(first)
    expect(paymentShop()).toBe(first)

    expect(stand.createYookassaClient).toHaveBeenCalledTimes(1)
    expect(stand.yookassaEnv).toHaveBeenCalledTimes(1)
  })

  it('is null while payments are off, and makes no client', async () => {
    stand.yookassaEnv.mockReturnValue(null)
    const { paymentShop } = await import('./payment-shop')

    expect(paymentShop()).toBeNull()
    expect(paymentShop()).toBeNull()

    expect(stand.createYookassaClient).not.toHaveBeenCalled()
    expect(stand.yookassaEnv).toHaveBeenCalledTimes(1)
    expect(stand.webEnv).not.toHaveBeenCalled()
  })

  it('does not fail on a broken web section while payments are off', async () => {
    // Every tRPC context asks for the shop: the pages must not depend on a section they never use.
    stand.yookassaEnv.mockReturnValue(null)
    stand.webEnv.mockImplementation(() => {
      throw new Error('[env:web] REDIS_URL: must be a redis:// URL')
    })
    const { paymentShop } = await import('./payment-shop')

    expect(paymentShop()).toBeNull()
  })

  it('throws on a broken web section of a shop that is set up and reads it again next time', async () => {
    stand.webEnv.mockImplementationOnce(() => {
      throw new Error('[env:web] APP_URL: must be an http(s) URL')
    })
    const { paymentShop } = await import('./payment-shop')

    expect(() => paymentShop()).toThrow('APP_URL')
    expect(stand.createYookassaClient).not.toHaveBeenCalled()

    expect(paymentShop()).toMatchObject({
      yookassa: stand.client,
      appUrl: 'https://raditi.example',
    })
    expect(stand.createYookassaClient).toHaveBeenCalledTimes(1)
  })

  it('throws on a broken section of the environment and reads it again next time', async () => {
    stand.yookassaEnv.mockImplementationOnce(() => {
      throw new Error('[env:yookassa] YOOKASSA_SECRET_KEY: must be set together')
    })
    const { paymentShop } = await import('./payment-shop')

    expect(() => paymentShop()).toThrow('YOOKASSA_SECRET_KEY')
    expect(stand.createYookassaClient).not.toHaveBeenCalled()

    expect(paymentShop()).toMatchObject({ yookassa: stand.client })
    expect(stand.createYookassaClient).toHaveBeenCalledTimes(1)
  })
})
