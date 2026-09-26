import { Buffer } from 'node:buffer'

import { describe, expect, it, vi } from 'vitest'

import { createYookassaClient } from './client.ts'
import { YookassaApiError, YookassaError } from './errors.ts'
import type { ChargeSavedInput, CreatePaymentInput } from './schemas.ts'

const AUTH = `Basic ${Buffer.from('shop:secret').toString('base64')}`

const payment = {
  id: 'pmt_1',
  status: 'pending',
  paid: false,
  amount: { value: '4900.00', currency: 'RUB' },
  confirmation: {
    type: 'redirect',
    confirmation_url: 'https://yoomoney.ru/checkout/payments/v2/contract?orderId=pmt_1',
  },
  created_at: '2026-09-26T12:00:00.000Z',
  test: true,
  refundable: false,
}

const refund = {
  id: 'rf_1',
  payment_id: 'pmt_1',
  status: 'succeeded',
  amount: { value: '1990.00', currency: 'RUB' },
  created_at: '2026-09-26T00:00:00Z',
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function clientWith(fetchMock: typeof fetch, timeoutMs?: number) {
  return createYookassaClient({ shopId: 'shop', secretKey: 'secret', fetch: fetchMock, timeoutMs })
}

const paymentInput: CreatePaymentInput = {
  amount: { value: '4900.00', currency: 'RUB' },
  capture: true,
  save_payment_method: true,
  confirmation: { type: 'redirect', return_url: 'https://raditi.ru/billing/return' },
  description: 'Тариф «Старт», 1 месяц',
  metadata: { orderId: 'order_1' },
}

describe('createYookassaClient', () => {
  it('posts createPayment with Basic auth, Idempotence-Key and a timeout', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(payment))

    const result = await clientWith(fetchMock).createPayment(paymentInput, 'idem_1')

    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.yookassa.ru/v3/payments')
    expect(init?.method).toBe('POST')
    expect(init?.headers).toEqual({
      Authorization: AUTH,
      'Content-Type': 'application/json',
      'Idempotence-Key': 'idem_1',
    })
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    expect(JSON.parse(String(init?.body))).toEqual(paymentInput)
    expect(result.id).toBe('pmt_1')
    expect(result.amount.value).toBe('4900.00')
  })

  it('posts chargeWithSavedMethod with capture and without confirmation', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ ...payment, status: 'succeeded', paid: true }))

    const input = {
      amount: { value: '4900.00', currency: 'RUB' },
      payment_method_id: 'pm_1',
      description: 'Продление тарифа «Старт»',
      metadata: { orderId: 'order_2' },
    } satisfies ChargeSavedInput

    const result = await clientWith(fetchMock).chargeWithSavedMethod(input, 'idem_2')

    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.yookassa.ru/v3/payments')
    expect((init?.headers as Record<string, string>)['Idempotence-Key']).toBe('idem_2')
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    expect(body).toEqual({ ...input, capture: true })
    expect(body).not.toHaveProperty('confirmation')
    expect(result.status).toBe('succeeded')
  })

  it('gets a payment by id without Idempotence-Key or body, encoding the id', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(payment))

    const result = await clientWith(fetchMock).getPayment('pmt_1/with space')

    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.yookassa.ru/v3/payments/pmt_1%2Fwith%20space')
    expect(init?.method).toBe('GET')
    expect(init?.headers).toEqual({ Authorization: AUTH })
    expect(init?.body).toBeUndefined()
    expect(result).toMatchObject(payment)
  })

  it('posts createRefund with Idempotence-Key', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(refund))

    const r = await clientWith(fetchMock).createRefund(
      { payment_id: 'pmt_1', amount: { value: '1990.00', currency: 'RUB' } },
      'rf-key',
    )

    expect(r.id).toBe('rf_1')
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.yookassa.ru/v3/refunds')
    expect(init?.method).toBe('POST')
    expect(new Headers(init?.headers).get('Idempotence-Key')).toBe('rf-key')
  })

  it('gets a refund by id and encodes it (AnyNote did not)', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(refund))

    const r = await clientWith(fetchMock).getRefund('rf_2/../payments')

    expect(r.id).toBe('rf_1')
    expect(fetchMock.mock.calls[0]![0]).toBe(
      'https://api.yookassa.ru/v3/refunds/rf_2%2F..%2Fpayments',
    )
  })

  it('honours a custom base URL without a double slash', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(payment))
    const client = createYookassaClient({
      shopId: 'shop',
      secretKey: 'secret',
      baseUrl: 'http://yookassa.test/v3/',
      fetch: fetchMock,
    })

    await client.getPayment('pmt_1')

    expect(fetchMock.mock.calls[0]![0]).toBe('http://yookassa.test/v3/payments/pmt_1')
  })
})

describe('input validation (money as two-decimal strings)', () => {
  const fetchMock = vi.fn<typeof fetch>()
  const client = clientWith(fetchMock)

  it.each([
    ['a number', 4900],
    ['an integer string', '4900'],
    ['one decimal', '4900.0'],
    ['three decimals', '4900.000'],
    ['kopecks as an integer', 490000],
    ['a comma', '4900,00'],
    ['a negative amount', '-1.00'],
    ['zero', '0.00'],
    ['a leading zero', '04900.00'],
    ['an exponent', '4.9e3'],
    ['spaces', '4 900.00'],
  ])('rejects %s before calling ЮKassa', async (_label, value) => {
    const input = { ...paymentInput, amount: { value, currency: 'RUB' } } as CreatePaymentInput
    await expect(client.createPayment(input, 'idem')).rejects.toThrow(/amount\.value/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects other currencies', async () => {
    const input = {
      ...paymentInput,
      amount: { value: '10.00', currency: 'USD' },
    } as unknown as CreatePaymentInput
    await expect(client.createPayment(input, 'idem')).rejects.toBeInstanceOf(YookassaError)
  })

  it('rejects unknown fields instead of dropping them silently', async () => {
    const input = { ...paymentInput, receipt: {} } as unknown as CreatePaymentInput
    await expect(client.createPayment(input, 'idem')).rejects.toThrow(/receipt|Unrecognized/)
  })

  it('rejects metadata beyond ЮKassa limits', async () => {
    const metadata = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, 'v']))
    await expect(client.createPayment({ ...paymentInput, metadata }, 'idem')).rejects.toThrow(
      /metadata/,
    )
  })

  it.each(['', 'k'.repeat(65)])('rejects the Idempotence-Key %j', async (key) => {
    await expect(client.createPayment(paymentInput, key)).rejects.toThrow(/Idempotence-Key/)
    await expect(
      client.createRefund({ payment_id: 'pmt_1', amount: { value: '1.00', currency: 'RUB' } }, key),
    ).rejects.toThrow(/Idempotence-Key/)
  })

  it('rejects an empty refund amount', async () => {
    await expect(
      client.createRefund({ payment_id: 'pmt_1', amount: { value: '0.00', currency: 'RUB' } }, 'k'),
    ).rejects.toThrow(/greater than zero/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('error handling', () => {
  it('includes code and description from the ЮKassa error body', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        {
          type: 'error',
          id: 'err-1',
          code: 'forbidden',
          description: 'Магазин не имеет права на проведение операции',
        },
        403,
      ),
    )

    await expect(clientWith(fetchMock).createPayment(paymentInput, 'idem')).rejects.toMatchObject({
      name: 'YookassaApiError',
      status: 403,
      code: 'forbidden',
      retryable: false,
      message: 'forbidden: Магазин не имеет права на проведение операции',
    })
  })

  it('appends the parameter when ЮKassa returns it', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse(
          { code: 'invalid_request', description: 'Receipt is required', parameter: 'receipt' },
          400,
        ),
      )

    await expect(clientWith(fetchMock).createPayment(paymentInput, 'idem')).rejects.toMatchObject({
      status: 400,
      message: 'invalid_request: Receipt is required: parameter=receipt',
    })
  })

  it('falls back to a generic message for a non-JSON body', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('plain text', { status: 502 }))

    await expect(clientWith(fetchMock).getPayment('pmt_1')).rejects.toMatchObject({
      status: 502,
      message: 'YooKassa API request failed',
    })
  })

  it.each([
    [429, true],
    [500, true],
    [503, true],
    [400, false],
    [401, false],
    [404, false],
  ])('marks HTTP %i as retryable=%s', async (status, retryable) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({}, status))
    const error = await clientWith(fetchMock)
      .getPayment('pmt_1')
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(YookassaApiError)
    expect((error as YookassaApiError).retryable).toBe(retryable)
  })

  it('wraps network errors as retryable without leaking credentials', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'))
    const error = await clientWith(fetchMock)
      .createPayment(paymentInput, 'idem')
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(YookassaError)
    expect(error).toMatchObject({ message: 'YooKassa request failed', retryable: true })
    expect(JSON.stringify(error)).not.toContain('secret')
  })

  it('times out', async () => {
    const hanging = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason as Error))
        }),
    )
    await expect(clientWith(hanging, 20).getPayment('pmt_1')).rejects.toMatchObject({
      message: 'YooKassa request timed out',
      retryable: true,
    })
  })

  it('rejects a 200 response of the wrong shape', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ ...payment, amount: { value: 4900, currency: 'RUB' } }))
    await expect(clientWith(fetchMock).getPayment('pmt_1')).rejects.toThrow(
      'Unexpected YooKassa response',
    )
  })
})
