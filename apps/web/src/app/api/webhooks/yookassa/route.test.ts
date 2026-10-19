import type * as YookassaModule from '@repo/yookassa'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// The route with its real handler; the shop settings, the database client, the shop client and
// the settlement of @repo/billing are replaced, so the test sees what the route hands over.
const stand = vi.hoisted(() => ({
  shop: null as {
    shopId: string
    secretKey: string
    baseUrl?: string
    webhookAllowlist?: string[]
  } | null,
  prisma: { name: 'prisma' },
  client: { name: 'yookassa client' },
  createYookassaClient: vi.fn(),
  settleOrderByPaymentId: vi.fn(),
  settlePaymentMethod: vi.fn(),
  settleRefund: vi.fn(),
}))

vi.mock('@/env', () => ({
  env: {
    web: () => ({ appEnv: 'development', appUrl: 'http://localhost:3000' }),
    yookassa: () => stand.shop,
  },
}))
vi.mock('@repo/db', () => ({ prisma: stand.prisma }))
vi.mock('@repo/billing', () => ({
  settleOrderByPaymentId: stand.settleOrderByPaymentId,
  settlePaymentMethod: stand.settlePaymentMethod,
  settleRefund: stand.settleRefund,
}))
vi.mock('@repo/yookassa', async (importOriginal) => ({
  ...(await importOriginal<typeof YookassaModule>()),
  createYookassaClient: stand.createYookassaClient,
}))

// Inside 185.71.76.0/27 from the published ЮKassa ranges.
const YOOKASSA_IP = '185.71.76.10'
const LOCAL_SHOP = {
  shopId: '123456',
  secretKey: 'test_synthetic-key',
  baseUrl: 'http://127.0.0.1:4010/v3',
  webhookAllowlist: ['127.0.0.1'],
}

const send = async (event: string, object: object, ip: string) => {
  const { POST } = await import('./route')
  return POST(
    new Request('http://localhost:3000/api/webhooks/yookassa', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify({ type: 'notification', event, object }),
    }),
  )
}

const notify = (event: string, status: string, ip: string) =>
  send(
    event,
    {
      id: 'pmt_1',
      status,
      paid: status === 'succeeded',
      amount: { value: '4900.00', currency: 'RUB' },
      created_at: '2026-10-04T09:00:00Z',
    },
    ip,
  )

/** «A payment method was bound», with a card the route must not take from the notification. */
const notifyBound = (ip: string) =>
  send(
    'payment_method.active',
    {
      id: 'pm_1',
      type: 'bank_card',
      saved: true,
      status: 'active',
      title: 'Bank card *4444',
      card: { last4: '4444', card_type: 'Mir' },
    },
    ip,
  )

/** «A refund went through», with an amount the route must not take from the notification. */
const notifyRefunded = (ip: string) =>
  send(
    'refund.succeeded',
    {
      id: 'rfnd_1',
      payment_id: 'pmt_1',
      status: 'succeeded',
      amount: { value: '4900.00', currency: 'RUB' },
      created_at: '2026-10-04T09:00:00Z',
    },
    ip,
  )

describe('ЮKassa notification route', () => {
  let info: ReturnType<typeof vi.spyOn>
  let error: ReturnType<typeof vi.spyOn>
  // The first import transforms the whole graph of the route; on a machine busy with every other
  // suite of `pnpm test` that alone outlasted the 5 s of the first test. Later imports after
  // vi.resetModules() reuse the transform.
  beforeAll(async () => {
    await import('./route')
  }, 60_000)
  beforeEach(() => {
    // The route keeps its handler for the life of the module: every test gets a new one.
    vi.resetModules()
    stand.shop = LOCAL_SHOP
    stand.createYookassaClient.mockReset().mockReturnValue(stand.client)
    stand.settleOrderByPaymentId.mockReset().mockResolvedValue({ state: 'paid' })
    stand.settlePaymentMethod.mockReset().mockResolvedValue({ state: 'active' })
    stand.settleRefund.mockReset().mockResolvedValue({ state: 'refunded' })
    info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })
  afterEach(() => {
    info.mockRestore()
    error.mockRestore()
  })

  it('settles a paid and a cancelled payment through the shop of the settings', async () => {
    expect((await notify('payment.succeeded', 'succeeded', '127.0.0.1')).status).toBe(200)
    expect((await notify('payment.canceled', 'canceled', '127.0.0.1')).status).toBe(200)

    const deps = {
      prisma: stand.prisma,
      yookassa: stand.client,
      appUrl: 'http://localhost:3000',
      appEnv: 'development',
    }
    expect(stand.settleOrderByPaymentId.mock.calls).toEqual([
      [deps, { paymentId: 'pmt_1' }],
      [deps, { paymentId: 'pmt_1' }],
    ])
    // One client for the life of the route, made from the shop settings.
    expect(stand.createYookassaClient).toHaveBeenCalledExactlyOnceWith(LOCAL_SHOP)
    expect(info.mock.calls).toEqual([
      ['[yookassa] payment.succeeded for pmt_1: order paid'],
      ['[yookassa] payment.canceled for pmt_1: order paid'],
    ])
  })

  it('accepts a payment that waits for capture without settling anything', async () => {
    const res = await notify('payment.waiting_for_capture', 'waiting_for_capture', '127.0.0.1')

    expect(res.status).toBe(200)
    expect(stand.settleOrderByPaymentId).not.toHaveBeenCalled()
    expect(stand.settlePaymentMethod).not.toHaveBeenCalled()
    expect(stand.settleRefund).not.toHaveBeenCalled()
  })

  it('reads a refund back through the shop of the settings', async () => {
    expect((await notifyRefunded('127.0.0.1')).status).toBe(200)

    // The same shop the payments are settled through, and of the notification only the id.
    expect(stand.settleRefund.mock.calls).toEqual([
      [
        {
          prisma: stand.prisma,
          yookassa: stand.client,
          appUrl: 'http://localhost:3000',
          appEnv: 'development',
        },
        { refundId: 'rfnd_1' },
      ],
    ])
    expect(stand.settleOrderByPaymentId).not.toHaveBeenCalled()
    expect(stand.settlePaymentMethod).not.toHaveBeenCalled()
    expect(stand.createYookassaClient).toHaveBeenCalledExactlyOnceWith(LOCAL_SHOP)
    expect(info.mock.calls).toEqual([['[yookassa] refund.succeeded for rfnd_1: refund refunded']])
  })

  it.each(['outside', 'unknown'])(
    'answers 200 for a refund the platform did not ask for: %s',
    async (state) => {
      stand.settleRefund.mockResolvedValue({ state })

      expect((await notifyRefunded('127.0.0.1')).status).toBe(200)
      expect(info.mock.calls).toEqual([[`[yookassa] refund.succeeded for rfnd_1: refund ${state}`]])
    },
  )

  it('answers 500 when the refund cannot be read back', async () => {
    stand.settleRefund.mockRejectedValue(new Error('YooKassa request timed out'))

    const res = await notifyRefunded('127.0.0.1')

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'not processed' })
    expect(error.mock.calls).toEqual([
      ['[yookassa] refund.succeeded for rfnd_1 failed: YooKassa request timed out'],
    ])
    // Neither a credential nor the amount of the notification is in the log.
    const logged = JSON.stringify([...error.mock.calls, ...info.mock.calls])
    expect(logged).not.toContain(LOCAL_SHOP.secretKey)
    expect(logged).not.toContain('4900.00')
  })

  it('refuses a refund from a sender outside the list', async () => {
    expect((await notifyRefunded(YOOKASSA_IP)).status).toBe(403)
    expect(stand.settleRefund).not.toHaveBeenCalled()
  })

  it('reads a bound payment method back through the shop of the settings', async () => {
    expect((await notifyBound('127.0.0.1')).status).toBe(200)

    // The same shop the payments are settled through, and of the notification only the id.
    expect(stand.settlePaymentMethod.mock.calls).toEqual([
      [
        {
          prisma: stand.prisma,
          yookassa: stand.client,
          appUrl: 'http://localhost:3000',
          appEnv: 'development',
        },
        { paymentMethodId: 'pm_1' },
      ],
    ])
    expect(stand.settleOrderByPaymentId).not.toHaveBeenCalled()
    expect(stand.createYookassaClient).toHaveBeenCalledExactlyOnceWith(LOCAL_SHOP)
    expect(info.mock.calls).toEqual([
      ['[yookassa] payment_method.active for pm_1: payment method active'],
    ])
  })

  it('answers 200 for a payment method no subscription waits for', async () => {
    stand.settlePaymentMethod.mockResolvedValue({ state: 'unknown' })

    expect((await notifyBound('127.0.0.1')).status).toBe(200)
    expect(info.mock.calls).toEqual([
      ['[yookassa] payment_method.active for pm_1: payment method unknown'],
    ])
  })

  it('answers 500 when the payment method cannot be read back', async () => {
    stand.settlePaymentMethod.mockRejectedValue(new Error('YooKassa request timed out'))

    const res = await notifyBound('127.0.0.1')

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'not processed' })
    expect(error.mock.calls).toEqual([
      ['[yookassa] payment_method.active for pm_1 failed: YooKassa request timed out'],
    ])
    // Neither a credential nor the card of the notification is in the log.
    const logged = JSON.stringify([...error.mock.calls, ...info.mock.calls])
    expect(logged).not.toContain(LOCAL_SHOP.secretKey)
    expect(logged).not.toContain('4444')
  })

  it('refuses a payment method from a sender outside the list', async () => {
    expect((await notifyBound(YOOKASSA_IP)).status).toBe(403)
    expect(stand.settlePaymentMethod).not.toHaveBeenCalled()
  })

  it('answers 200 for a payment no order holds', async () => {
    stand.settleOrderByPaymentId.mockResolvedValue({ state: 'unknown' })

    expect((await notify('payment.succeeded', 'succeeded', '127.0.0.1')).status).toBe(200)
  })

  it('answers 500 when the settlement throws', async () => {
    stand.settleOrderByPaymentId.mockRejectedValue(new Error('YooKassa request timed out'))

    const res = await notify('payment.succeeded', 'succeeded', '127.0.0.1')

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'not processed' })
    expect(error.mock.calls).toEqual([
      ['[yookassa] payment.succeeded for pmt_1 failed: YooKassa request timed out'],
    ])
    // Neither line of the log holds a credential or the body.
    const logged = JSON.stringify([...error.mock.calls, ...info.mock.calls])
    expect(logged).not.toContain(LOCAL_SHOP.secretKey)
    expect(logged).not.toContain('4900.00')
  })

  it('refuses a sender outside the list without settling anything', async () => {
    const res = await notify('payment.succeeded', 'succeeded', YOOKASSA_IP)

    // The list of a local shop replaces the published ranges.
    expect(res.status).toBe(403)
    expect(stand.settleOrderByPaymentId).not.toHaveBeenCalled()
  })

  it('answers 200 and says once that payments are not configured', async () => {
    stand.shop = null

    expect((await notify('payment.succeeded', 'succeeded', YOOKASSA_IP)).status).toBe(200)
    expect((await notify('payment.canceled', 'canceled', YOOKASSA_IP)).status).toBe(200)
    expect((await notifyBound(YOOKASSA_IP)).status).toBe(200)
    expect((await notifyRefunded(YOOKASSA_IP)).status).toBe(200)

    expect(stand.createYookassaClient).not.toHaveBeenCalled()
    expect(stand.settleOrderByPaymentId).not.toHaveBeenCalled()
    expect(stand.settlePaymentMethod).not.toHaveBeenCalled()
    expect(stand.settleRefund).not.toHaveBeenCalled()
    expect(info.mock.calls).toEqual([
      ['[yookassa] payments are not configured: notifications are accepted and ignored'],
    ])
    // Without a shop only the published ranges are trusted.
    expect((await notify('payment.succeeded', 'succeeded', '127.0.0.1')).status).toBe(403)
  })
})
