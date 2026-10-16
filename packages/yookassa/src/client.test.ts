import { Buffer } from 'node:buffer'

import { describe, expect, it, vi } from 'vitest'

import { createYookassaClient } from './client.ts'
import { YookassaApiError, YookassaError } from './errors.ts'
import type { ChargeSavedInput, CreatePaymentInput, CreatePaymentMethodInput } from './schemas.ts'

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

/** POST /payment_methods right after creation: nothing is saved until the user confirms. */
const pendingMethod = {
  id: '2f1b6c1d-000f-5000-8000-18db351245c7',
  type: 'bank_card',
  saved: false,
  status: 'pending',
  holder: { account_id: '123456', gateway_id: '654321' },
  confirmation: {
    type: 'redirect',
    confirmation_url: 'https://yoomoney.ru/payment-methods/confirm?id=2f1b6c1d',
  },
}

const activeMethod = {
  id: '2f1b6c1d-000f-5000-8000-18db351245c7',
  type: 'bank_card',
  saved: true,
  status: 'active',
  title: 'Bank card *4444',
  holder: { account_id: '123456', gateway_id: '654321' },
  card: {
    first6: '555555',
    last4: '4444',
    expiry_year: '2030',
    expiry_month: '12',
    card_type: 'Mir',
    issuer_country: 'RU',
  },
  metadata: { subscription_id: 'sub_1' },
}

const methodInput: CreatePaymentMethodInput = {
  type: 'bank_card',
  confirmation: { type: 'redirect', return_url: 'https://raditi.ru/settings/billing/return' },
  metadata: { subscription_id: 'sub_1' },
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

  it('posts createPaymentMethod with Basic auth, Idempotence-Key and a redirect', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(pendingMethod))

    const method = await clientWith(fetchMock).createPaymentMethod(methodInput, 'pm-key_1.a')

    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.yookassa.ru/v3/payment_methods')
    expect(init?.method).toBe('POST')
    expect(init?.headers).toEqual({
      Authorization: AUTH,
      'Content-Type': 'application/json',
      'Idempotence-Key': 'pm-key_1.a',
    })
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    expect(JSON.parse(String(init?.body))).toEqual(methodInput)
    expect(method).toMatchObject({
      id: pendingMethod.id,
      type: 'bank_card',
      saved: false,
      status: 'pending',
      confirmation: { confirmation_url: pendingMethod.confirmation.confirmation_url },
    })
  })

  it('saves an СБП account the same way', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ ...pendingMethod, type: 'sbp' }))

    const method = await clientWith(fetchMock).createPaymentMethod(
      { ...methodInput, type: 'sbp' },
      'idem',
    )

    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toMatchObject({ type: 'sbp' })
    expect(method.type).toBe('sbp')
  })

  it('gets a payment method by id without Idempotence-Key or body, encoding the id', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(activeMethod))

    const method = await clientWith(fetchMock).getPaymentMethod('pm_1/../payments')

    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.yookassa.ru/v3/payment_methods/pm_1%2F..%2Fpayments')
    expect(init?.method).toBe('GET')
    expect(init?.headers).toEqual({ Authorization: AUTH })
    expect(init?.body).toBeUndefined()
    expect(method).toEqual({
      id: activeMethod.id,
      type: 'bank_card',
      saved: true,
      status: 'active',
      title: 'Bank card *4444',
      card: activeMethod.card,
      metadata: { subscription_id: 'sub_1' },
    })
  })

  it('reads the status of the method a payment was made with, when ЮKassa sends one', async () => {
    const paid = {
      ...payment,
      status: 'succeeded',
      paid: true,
      payment_method: { id: 'pm_1', type: 'bank_card', saved: true, status: 'active' },
    }
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(paid))
      .mockResolvedValueOnce(
        jsonResponse({ ...paid, payment_method: { id: 'pm_1', type: 'bank_card', saved: true } }),
      )
    const client = clientWith(fetchMock)

    expect((await client.getPayment('pmt_1')).payment_method).toMatchObject({
      saved: true,
      status: 'active',
    })
    expect((await client.getPayment('pmt_1')).payment_method?.status).toBeUndefined()
  })

  it('reads a payment whose method has a status it has never heard of', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse({
        ...payment,
        status: 'succeeded',
        paid: true,
        payment_method: { id: 'pm_1', type: 'bank_card', saved: true, status: 'expired' },
      }),
    )

    expect((await clientWith(fetchMock).getPayment('pmt_1')).payment_method).toMatchObject({
      saved: true,
      status: 'expired',
    })
  })

  it('keeps a cancellation reason it has never heard of', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        ...payment,
        status: 'canceled',
        cancellation_details: { party: 'payment_network', reason: 'reason_added_tomorrow' },
      }),
    )

    const canceled = await clientWith(fetchMock).getPayment('pmt_1')

    expect(canceled.cancellation_details).toEqual({
      party: 'payment_network',
      reason: 'reason_added_tomorrow',
    })
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

  // The platform tells its own refunds by this field (`refundDescription` of @repo/billing):
  // what the request described the refund with has to be sent and read back as it is.
  it('sends the description of a refund and reads it back with the refund', async () => {
    const description = 'Возврат по заказу 0199a000-0000-7000-8000-0000000000b2'
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(jsonResponse({ ...refund, description })))
    const client = clientWith(fetchMock)

    const created = await client.createRefund(
      { payment_id: 'pmt_1', amount: { value: '1990.00', currency: 'RUB' }, description },
      'refund.0199a000-0000-7000-8000-0000000000b2.1',
    )

    expect(created.description).toBe(description)
    const [, init] = fetchMock.mock.calls[0]!
    // Nothing beside what was asked for: no metadata of a refund is sent unless given.
    expect(JSON.parse(String(init?.body))).toEqual({
      payment_id: 'pmt_1',
      amount: { value: '1990.00', currency: 'RUB' },
      description,
    })
    expect((await client.getRefund('rf_1')).description).toBe(description)
    // A refund made in the ЮKassa cabinet may carry none.
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(refund)))
    expect((await client.getRefund('rf_1')).description).toBeUndefined()
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

  it.each([
    ['a colon, as in credit_ledger keys', 'order:1:grant'],
    ['a space', 'renew 1'],
    ['a slash', 'refund/1'],
    ['a plus', 'a+b'],
    ['Cyrillic', 'ключ'],
    ['a line break', 'refund.1\n'],
    ['a header injection', 'k\r\nX-Other: 1'],
  ])('rejects an Idempotence-Key with %s before calling ЮKassa', async (_label, key) => {
    const charge = {
      amount: { value: '1.00', currency: 'RUB' },
      payment_method_id: 'pm_1',
    } satisfies ChargeSavedInput
    const calls = [
      client.createPayment(paymentInput, key),
      client.chargeWithSavedMethod(charge, key),
      client.createPaymentMethod(methodInput, key),
      client.createRefund({ payment_id: 'pmt_1', amount: charge.amount }, key),
    ]
    for (const call of calls) {
      const error = await call.catch((e: unknown) => e)
      expect(error).toBeInstanceOf(YookassaError)
      expect((error as Error).message).toBe(
        'Idempotence-Key must be 1–64 characters: letters, digits, dot, hyphen and underscore',
      )
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('takes the keys the billing plan uses', async () => {
    const accepting = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse(payment)))
    const uuid = '018e5f0a-1b2c-7d4e-9f0a-1b2c3d4e5f6a'
    const keys = [
      uuid,
      `renew.${uuid}.1790000000000`,
      `refund.${uuid}`,
      'A-Z_a-z.0-9',
      'k'.repeat(64),
    ]
    for (const key of keys) {
      await clientWith(accepting).createPayment(paymentInput, key)
    }
    expect(
      accepting.mock.calls.map(([, init]) => new Headers(init?.headers).get('Idempotence-Key')),
    ).toEqual(keys)
  })

  it.each([
    ['another type', { ...methodInput, type: 'yoo_money' }],
    ['no confirmation', { type: 'bank_card' }],
    [
      'a relative return address',
      { ...methodInput, confirmation: { type: 'redirect', return_url: '/settings' } },
    ],
    ['card data', { ...methodInput, card: { number: '5555555555554444' } }],
  ])('rejects a payment method with %s before calling ЮKassa', async (_label, input) => {
    await expect(
      client.createPaymentMethod(input as unknown as CreatePaymentMethodInput, 'idem'),
    ).rejects.toThrow(/^Invalid payment method input: /)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a refund description longer than ЮKassa takes', async () => {
    const refundOf = (description: string) =>
      client.createRefund(
        { payment_id: 'pmt_1', amount: { value: '1.00', currency: 'RUB' }, description },
        'k',
      )
    await expect(refundOf('в'.repeat(251))).rejects.toThrow(/^Invalid refund input: description/)
    expect(fetchMock).not.toHaveBeenCalled()
    fetchMock.mockResolvedValue(jsonResponse(refund))
    await expect(refundOf('в'.repeat(250))).resolves.toMatchObject({ id: 'rf_1' })
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

  it('rejects a payment method of the wrong shape or with an unknown status', async () => {
    for (const body of [
      { ...activeMethod, status: 'archived' },
      { ...activeMethod, saved: 'yes' },
      { ...activeMethod, id: '' },
    ]) {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(body))
      await expect(clientWith(fetchMock).getPaymentMethod('pm_1')).rejects.toThrow(
        'Unexpected YooKassa response',
      )
    }
  })

  it('reports a refused payment method like any other API error', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse(
          { type: 'error', code: 'not_found', description: 'Payment method not found' },
          404,
        ),
      )
    await expect(clientWith(fetchMock).getPaymentMethod('pm_404')).rejects.toMatchObject({
      name: 'YookassaApiError',
      status: 404,
      code: 'not_found',
      retryable: false,
    })
    const failing = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({}, 500))
    await expect(
      clientWith(failing).createPaymentMethod(methodInput, 'idem'),
    ).rejects.toMatchObject({ status: 500, retryable: true })
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
