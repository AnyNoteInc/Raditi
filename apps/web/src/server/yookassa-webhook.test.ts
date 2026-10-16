import { describe, expect, it, vi } from 'vitest'

import {
  handleYookassaWebhook,
  MAX_BODY_BYTES,
  webhookSenderIp,
  webhookSenders,
  yookassaEventHandler,
} from './yookassa-webhook'

// Inside 185.71.76.0/27 from the published ЮKassa ranges.
const YOOKASSA_IP = '185.71.76.10'

const notification = {
  type: 'notification',
  event: 'payment.succeeded',
  object: {
    id: 'pmt_1',
    status: 'succeeded',
    paid: true,
    amount: { value: '4900.00', currency: 'RUB' },
    created_at: '2026-09-26T00:00:00Z',
  },
}

const post = (body: string, ip?: string, headers: Record<string, string> = {}) =>
  new Request('http://localhost:3000/api/webhooks/yookassa', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(ip === undefined ? {} : { 'x-forwarded-for': ip }),
      ...headers,
    },
    body,
  })

describe('handleYookassaWebhook', () => {
  it('answers 403 to an address outside the ЮKassa ranges', async () => {
    const onEvent = vi.fn()
    for (const ip of ['203.0.113.7', undefined, '', 'not-an-ip', '127.0.0.1']) {
      const res = await handleYookassaWebhook(post(JSON.stringify(notification), ip), {
        requireAllowlist: true,
        onEvent,
      })
      expect(res.status).toBe(403)
    }
    expect(onEvent).not.toHaveBeenCalled()
  })

  it('answers 400 to a body that is not a notification', async () => {
    const onEvent = vi.fn()
    const bodies = [
      '{not json',
      JSON.stringify({ type: 'notification', event: 'payment.succeeded' }),
      JSON.stringify({ ...notification, object: { ...notification.object, status: 'canceled' } }),
    ]
    for (const body of bodies) {
      const res = await handleYookassaWebhook(post(body, YOOKASSA_IP), {
        requireAllowlist: true,
        onEvent,
      })
      expect(res.status).toBe(400)
    }
    expect(onEvent).not.toHaveBeenCalled()
  })

  it('refuses a declared oversize body without reading it', async () => {
    const onEvent = vi.fn()
    const request = post(JSON.stringify(notification), YOOKASSA_IP, {
      'content-length': String(MAX_BODY_BYTES + 1),
    })

    const res = await handleYookassaWebhook(request, { requireAllowlist: true, onEvent })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid notification' })
    expect(request.bodyUsed).toBe(false)
    expect(onEvent).not.toHaveBeenCalled()
  })

  it('counts the body in bytes, not in UTF-16 characters', async () => {
    const onEvent = vi.fn()
    // Cyrillic takes two bytes a letter: under the limit in characters, over it in bytes.
    const body = JSON.stringify({
      ...notification,
      object: { ...notification.object, description: 'я'.repeat(MAX_BODY_BYTES / 2) },
    })
    expect(body.length).toBeLessThan(MAX_BODY_BYTES)
    expect(Buffer.byteLength(body)).toBeGreaterThan(MAX_BODY_BYTES)

    const res = await handleYookassaWebhook(post(body, YOOKASSA_IP), {
      requireAllowlist: true,
      onEvent,
    })

    expect(res.status).toBe(400)
    expect(onEvent).not.toHaveBeenCalled()
  })

  /** A body sent in chunks, without Content-Length. */
  const chunked = (source: UnderlyingDefaultSource<Uint8Array>) =>
    new Request('http://localhost:3000/api/webhooks/yookassa', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': YOOKASSA_IP },
      body: new ReadableStream(source),
      duplex: 'half',
    } as RequestInit)

  it('stops reading a body without Content-Length as soon as it passes the limit', async () => {
    const onEvent = vi.fn()
    const chunk = 16 * 1024
    let pulled = 0
    let cancelled = false
    // Endless: reading it whole would never finish.
    const request = chunked({
      pull(controller) {
        pulled += 1
        controller.enqueue(new Uint8Array(chunk).fill(0x20))
      },
      cancel() {
        cancelled = true
      },
    })
    expect(request.headers.get('content-length')).toBeNull()

    const res = await handleYookassaWebhook(request, { requireAllowlist: true, onEvent })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid notification' })
    expect(cancelled).toBe(true)
    expect(pulled * chunk).toBeLessThanOrEqual(MAX_BODY_BYTES + 2 * chunk)
    expect(onEvent).not.toHaveBeenCalled()
  })

  it('accepts a notification sent in chunks without Content-Length', async () => {
    const onEvent = vi.fn()
    const bytes = new TextEncoder().encode(JSON.stringify(notification))
    const middle = Math.floor(bytes.byteLength / 2)
    const res = await handleYookassaWebhook(
      chunked({
        start(controller) {
          controller.enqueue(bytes.subarray(0, middle))
          controller.enqueue(bytes.subarray(middle))
          controller.close()
        },
      }),
      { requireAllowlist: true, onEvent },
    )
    expect(res.status).toBe(200)
    expect(onEvent).toHaveBeenCalledTimes(1)
  })

  it('checks the body itself when Content-Length is exact or not a number', async () => {
    const body = JSON.stringify(notification)
    for (const length of [String(Buffer.byteLength(body)), 'unknown']) {
      const res = await handleYookassaWebhook(
        post(body, YOOKASSA_IP, { 'content-length': length }),
        { requireAllowlist: true },
      )
      expect(res.status).toBe(200)
    }
  })

  it('accepts a valid notification from ЮKassa and hands it over', async () => {
    const onEvent = vi.fn()
    const res = await handleYookassaWebhook(post(JSON.stringify(notification), YOOKASSA_IP), {
      requireAllowlist: true,
      onEvent,
    })

    expect(res.status).toBe(200)
    expect(onEvent).toHaveBeenCalledTimes(1)
    expect(onEvent.mock.calls[0]?.[0]).toMatchObject({
      event: 'payment.succeeded',
      object: { id: 'pmt_1' },
    })
  })

  it('accepts an IPv6 address from the ЮKassa ranges', async () => {
    const res = await handleYookassaWebhook(post(JSON.stringify(notification), '2a02:5180::1'), {
      requireAllowlist: true,
    })
    expect(res.status).toBe(200)
  })

  it('answers 403 when a forged ЮKassa address comes first in a list', async () => {
    const onEvent = vi.fn()
    // The client sent X-Forwarded-For itself and a proxy appended the real address.
    for (const ip of [`${YOOKASSA_IP}, 203.0.113.7`, `${YOOKASSA_IP}, ${YOOKASSA_IP}`]) {
      const res = await handleYookassaWebhook(post(JSON.stringify(notification), ip), {
        requireAllowlist: true,
        onEvent,
      })
      expect(res.status).toBe(403)
    }
    expect(onEvent).not.toHaveBeenCalled()
  })
})

describe('webhookSenders', () => {
  const local = { webhookAllowlist: ['127.0.0.1', '::1'] }

  it('trusts only the published ЮKassa ranges in production, whatever the settings say', () => {
    for (const yookassa of [null, {}, local]) {
      expect(webhookSenders('production', yookassa)).toEqual({
        requireAllowlist: true,
        allowlist: undefined,
      })
    }
  })

  it('replaces the published ranges with YOOKASSA_WEBHOOK_ALLOWLIST outside production', () => {
    for (const appEnv of ['development', 'test'] as const) {
      expect(webhookSenders(appEnv, local)).toEqual({
        requireAllowlist: false,
        allowlist: ['127.0.0.1', '::1'],
      })
      // Payments off, or no list: the published ranges stay.
      expect(webhookSenders(appEnv, null).allowlist).toBeUndefined()
      expect(webhookSenders(appEnv, {}).allowlist).toBeUndefined()
    }
  })
})

describe('handleYookassaWebhook with the senders of a local fake', () => {
  const body = JSON.stringify(notification)
  const development = webhookSenders('development', { webhookAllowlist: ['127.0.0.1', '::1'] })

  it('accepts a notification from loopback, which the published ranges refuse', async () => {
    const onEvent = vi.fn()
    for (const ip of ['127.0.0.1', '::1']) {
      const res = await handleYookassaWebhook(post(body, ip), { ...development, onEvent })
      expect(res.status).toBe(200)
    }
    expect(onEvent).toHaveBeenCalledTimes(2)

    const published = webhookSenders('development', null)
    const res = await handleYookassaWebhook(post(body, '127.0.0.1'), { ...published, onEvent })
    expect(res.status).toBe(403)
    expect(onEvent).toHaveBeenCalledTimes(2)
  })

  it('refuses every other sender: the list replaces the ЮKassa ranges, it does not add to them', async () => {
    const onEvent = vi.fn()
    for (const ip of [YOOKASSA_IP, '127.0.0.2', '203.0.113.7']) {
      const res = await handleYookassaWebhook(post(body, ip), { ...development, onEvent })
      expect(res.status).toBe(403)
    }
    expect(onEvent).not.toHaveBeenCalled()
  })

  it('still takes the sender only from an X-Forwarded-For with exactly one address', async () => {
    const onEvent = vi.fn()
    // No header (a direct connection from loopback), a list of hops, and a forged first hop.
    for (const ip of [undefined, '', '127.0.0.1, 127.0.0.1', '127.0.0.1, 203.0.113.7']) {
      const res = await handleYookassaWebhook(post(body, ip), { ...development, onEvent })
      expect(res.status).toBe(403)
    }
    expect(onEvent).not.toHaveBeenCalled()
  })

  it('ignores the list in production: loopback is refused, ЮKassa is accepted', async () => {
    const production = webhookSenders('production', { webhookAllowlist: ['127.0.0.1'] })
    expect((await handleYookassaWebhook(post(body, '127.0.0.1'), production)).status).toBe(403)
    expect((await handleYookassaWebhook(post(body, YOOKASSA_IP), production)).status).toBe(200)
  })

  it('hands over a payment_method.active notification', async () => {
    const onEvent = vi.fn()
    const method = {
      type: 'notification',
      event: 'payment_method.active',
      object: { id: 'pm_1', type: 'bank_card', saved: true, status: 'active' },
    }
    const res = await handleYookassaWebhook(post(JSON.stringify(method), '127.0.0.1'), {
      ...development,
      onEvent,
    })
    expect(res.status).toBe(200)
    expect(onEvent.mock.calls[0]?.[0]).toMatchObject({
      event: 'payment_method.active',
      object: { id: 'pm_1', status: 'active' },
    })
  })
})

describe('webhookSenderIp', () => {
  const ipOf = (value?: string) =>
    webhookSenderIp(new Headers(value === undefined ? {} : { 'x-forwarded-for': value }))

  it('takes the single address the proxy wrote', () => {
    expect(ipOf(YOOKASSA_IP)).toBe(YOOKASSA_IP)
    expect(ipOf(` ${YOOKASSA_IP} `)).toBe(YOOKASSA_IP)
    // better-auth writes IPv6 out in full; verifyTrustedIp matches either form.
    expect(ipOf('2a02:5180::1')).toBe('2a02:5180:0000:0000:0000:0000:0000:0001')
  })

  it('trusts no address when the header is missing, broken or holds several hops', () => {
    for (const value of [
      undefined,
      '',
      ' ',
      'not-an-ip',
      `${YOOKASSA_IP}, 10.0.0.1`,
      `${YOOKASSA_IP},10.0.0.1`,
      `10.0.0.1, ${YOOKASSA_IP}`,
      `${YOOKASSA_IP},`,
    ]) {
      expect(ipOf(value)).toBeNull()
    }
  })
})

describe('yookassaEventHandler', () => {
  const payment = (status: string) => ({ ...notification.object, status })
  const events = {
    'payment.succeeded': payment('succeeded'),
    'payment.canceled': payment('canceled'),
    'payment.waiting_for_capture': payment('waiting_for_capture'),
    'payment_method.active': { id: 'pm_1', type: 'bank_card', saved: true, status: 'active' },
    'refund.succeeded': {
      id: 'rfnd_1',
      payment_id: 'pmt_1',
      status: 'succeeded',
      amount: { value: '4900.00', currency: 'RUB' },
      created_at: '2026-09-26T00:00:00Z',
    },
  } as const
  type EventName = keyof typeof events

  type Settle = ((id: string) => Promise<{ state: string }>) | null

  /**
   * The route as it stands: the checked sender, the parsed body, then the handler. A test
   * about payments leaves the settlement of payment methods and of refunds to stubs nobody
   * should call.
   */
  function route(
    settlePayment: Settle,
    settlePaymentMethod: Settle = settlePayment && vi.fn<NonNullable<Settle>>(),
    settleRefund: Settle = settlePayment && vi.fn<NonNullable<Settle>>(),
  ) {
    const log = vi.fn<(line: string) => void>()
    const logError = vi.fn<(line: string) => void>()
    const onEvent = yookassaEventHandler({ settlePayment, settlePaymentMethod, settleRefund, log })
    const send = (event: EventName, object: object = events[event]) =>
      handleYookassaWebhook(
        post(JSON.stringify({ type: 'notification', event, object }), YOOKASSA_IP),
        { requireAllowlist: true, onEvent, logError },
      )
    return { send, log, logError }
  }

  it.each(['payment.succeeded', 'payment.canceled'] as const)(
    'settles the order of a %s notification by the payment id alone',
    async (event) => {
      const settlePayment = vi.fn().mockResolvedValue({ state: 'paid' })
      const { send, log, logError } = route(settlePayment)

      const res = await send(event)

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
      // The body is a hint: nothing of it but the id reaches the settlement.
      expect(settlePayment).toHaveBeenCalledExactlyOnceWith('pmt_1')
      expect(log.mock.calls).toEqual([[`[yookassa] ${event} for pmt_1: order paid`]])
      expect(logError).not.toHaveBeenCalled()
    },
  )

  it('accepts a payment that waits for capture and settles nothing', async () => {
    const settlePayment = vi.fn()
    const settlePaymentMethod = vi.fn()
    const settleRefund = vi.fn()
    const { send, log } = route(settlePayment, settlePaymentMethod, settleRefund)

    const res = await send('payment.waiting_for_capture')

    expect(res.status).toBe(200)
    expect(settlePayment).not.toHaveBeenCalled()
    expect(settlePaymentMethod).not.toHaveBeenCalled()
    expect(settleRefund).not.toHaveBeenCalled()
    expect(log.mock.calls).toEqual([
      ['[yookassa] payment.waiting_for_capture for pmt_1: accepted, not processed'],
    ])
  })

  it.each(['refunded', 'outside', 'pending', 'unknown'])(
    'reads a refund back by its id alone: %s',
    async (state) => {
      const settlePayment = vi.fn()
      const settlePaymentMethod = vi.fn()
      const settleRefund = vi.fn().mockResolvedValue({ state })
      const { send, log, logError } = route(settlePayment, settlePaymentMethod, settleRefund)

      // What the notification says of the amount and the payment is not what is acted on.
      const res = await send('refund.succeeded', {
        ...events['refund.succeeded'],
        payment_id: 'pmt_of_somebody_else',
        amount: { value: '1.00', currency: 'RUB' },
      })

      // Made in the cabinet, or not ours at all, is accepted as well: ЮKassa must not repeat it.
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
      expect(settleRefund).toHaveBeenCalledExactlyOnceWith('rfnd_1')
      expect(settlePayment).not.toHaveBeenCalled()
      expect(settlePaymentMethod).not.toHaveBeenCalled()
      expect(log.mock.calls).toEqual([[`[yookassa] refund.succeeded for rfnd_1: refund ${state}`]])
      expect(logError).not.toHaveBeenCalled()
    },
  )

  it('answers 500 when a refund cannot be read back, and settles it on the repeat', async () => {
    const settleRefund = vi
      .fn()
      .mockRejectedValueOnce(new Error('YooKassa request timed out'))
      .mockResolvedValue({ state: 'refunded' })
    const { send, log, logError } = route(vi.fn(), vi.fn(), settleRefund)

    const failed = await send('refund.succeeded')

    expect(failed.status).toBe(500)
    expect(await failed.json()).toEqual({ error: 'not processed' })
    expect(logError.mock.calls).toEqual([
      ['[yookassa] refund.succeeded for rfnd_1 failed: YooKassa request timed out'],
    ])
    expect(log).not.toHaveBeenCalled()

    expect((await send('refund.succeeded')).status).toBe(200)
    expect(settleRefund).toHaveBeenCalledTimes(2)
    expect(log.mock.calls).toEqual([['[yookassa] refund.succeeded for rfnd_1: refund refunded']])
  })

  it.each(['active', 'pending', 'unknown'])(
    'reads a bound payment method back by its id alone: %s',
    async (state) => {
      const settlePayment = vi.fn()
      const settlePaymentMethod = vi.fn().mockResolvedValue({ state })
      const { send, log, logError } = route(settlePayment, settlePaymentMethod)

      // What the notification says of the card is not what gets stored.
      const res = await send('payment_method.active', {
        ...events['payment_method.active'],
        title: 'Bank card *0000',
        card: { last4: '0000', card_type: 'Visa' },
      })

      // Not ours, or not yet, is accepted as well: ЮKassa must not repeat it for a day.
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
      expect(settlePaymentMethod).toHaveBeenCalledExactlyOnceWith('pm_1')
      expect(settlePayment).not.toHaveBeenCalled()
      expect(log.mock.calls).toEqual([
        [`[yookassa] payment_method.active for pm_1: payment method ${state}`],
      ])
      expect(logError).not.toHaveBeenCalled()
    },
  )

  it('answers 500 when a payment method cannot be read back, and stores it on the repeat', async () => {
    const settlePaymentMethod = vi
      .fn()
      .mockRejectedValueOnce(new Error('YooKassa request timed out'))
      .mockResolvedValue({ state: 'active' })
    const { send, log, logError } = route(vi.fn(), settlePaymentMethod)

    const failed = await send('payment_method.active')

    expect(failed.status).toBe(500)
    expect(await failed.json()).toEqual({ error: 'not processed' })
    expect(logError.mock.calls).toEqual([
      ['[yookassa] payment_method.active for pm_1 failed: YooKassa request timed out'],
    ])
    expect(log).not.toHaveBeenCalled()

    expect((await send('payment_method.active')).status).toBe(200)
    expect(settlePaymentMethod).toHaveBeenCalledTimes(2)
    expect(log.mock.calls).toEqual([
      ['[yookassa] payment_method.active for pm_1: payment method active'],
    ])
  })

  it('accepts a notification of a payment no order holds', async () => {
    const settlePayment = vi.fn().mockResolvedValue({ state: 'unknown' })
    const { send, log } = route(settlePayment)

    const res = await send('payment.succeeded')

    // Not ours, or not yet: 200, so that ЮKassa does not repeat it for a day.
    expect(res.status).toBe(200)
    expect(log.mock.calls).toEqual([['[yookassa] payment.succeeded for pmt_1: order unknown']])
  })

  it('answers 500 when the settlement throws, so that ЮKassa sends the notification again', async () => {
    const settlePayment = vi
      .fn()
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:5432'))
      .mockResolvedValue({ state: 'paid' })
    const { send, log, logError } = route(settlePayment)

    const failed = await send('payment.succeeded')

    expect(failed.status).toBe(500)
    expect(await failed.json()).toEqual({ error: 'not processed' })
    expect(failed.headers.get('cache-control')).toBe('no-store')
    expect(logError.mock.calls).toEqual([
      ['[yookassa] payment.succeeded for pmt_1 failed: connect ECONNREFUSED 127.0.0.1:5432'],
    ])
    expect(log).not.toHaveBeenCalled()

    // The repeat is settled like any other notification.
    expect((await send('payment.succeeded')).status).toBe(200)
    expect(settlePayment).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['no settlement at all', null, null, null],
    // The route gives all three or none; a part of a shop settles nothing.
    ['no settlement of payments', null, vi.fn(), vi.fn()],
    ['no settlement of payment methods', vi.fn(), null, vi.fn()],
    ['no settlement of refunds', vi.fn(), vi.fn(), null],
  ])('treats %s as payments that are not configured', async (_case, payments, methods, refunds) => {
    const { send, log } = route(payments, methods, refunds)

    for (const event of Object.keys(events) as EventName[]) {
      expect((await send(event)).status).toBe(200)
    }

    for (const settle of [payments, methods, refunds]) {
      if (settle !== null) expect(settle).not.toHaveBeenCalled()
    }
    expect(log.mock.calls).toEqual([
      ['[yookassa] payments are not configured: notifications are accepted and ignored'],
    ])
  })

  it('accepts everything and says so once while payments are not configured', async () => {
    const { send, log, logError } = route(null)

    for (const event of Object.keys(events) as EventName[]) {
      expect((await send(event)).status).toBe(200)
    }

    expect(log.mock.calls).toEqual([
      ['[yookassa] payments are not configured: notifications are accepted and ignored'],
    ])
    expect(logError).not.toHaveBeenCalled()
  })

  it('never writes the body of a notification to the log', async () => {
    const secret = 'Радити: тариф «Бизнес» на месяц'
    const object = {
      ...events['payment.succeeded'],
      description: secret,
      metadata: { order_id: 'order-in-the-body' },
      payment_method: { id: 'pm_secret', type: 'bank_card', saved: true, title: 'Bank card *4444' },
    }
    const lines: string[] = []
    const record = (line: string) => void lines.push(line)

    const method = {
      ...events['payment_method.active'],
      title: 'Bank card *4444',
      card: { first6: '220000', last4: '4444', card_type: 'Mir', issuer_name: 'Bank of the body' },
      metadata: { subscription_id: 'subscription-in-the-body' },
    }
    const returned = {
      ...events['refund.succeeded'],
      payment_id: 'payment-in-the-body',
      description: 'refund-reason-in-the-body',
      metadata: { order_id: 'refunded-order-in-the-body' },
    }
    const settled = yookassaEventHandler({
      settlePayment: () => Promise.resolve({ state: 'paid' }),
      settlePaymentMethod: () => Promise.resolve({ state: 'active' }),
      settleRefund: () => Promise.resolve({ state: 'refunded' }),
      log: record,
    })
    const failing = yookassaEventHandler({
      settlePayment: () => Promise.reject(new Error('boom')),
      settlePaymentMethod: () => Promise.reject(new Error('bang')),
      settleRefund: () => Promise.reject(new Error('bust')),
      log: record,
    })
    for (const onEvent of [settled, failing]) {
      for (const body of [
        { ...notification, object },
        { type: 'notification', event: 'payment_method.active', object: method },
        { type: 'notification', event: 'refund.succeeded', object: returned },
      ]) {
        await handleYookassaWebhook(post(JSON.stringify(body), YOOKASSA_IP), {
          requireAllowlist: true,
          onEvent,
          logError: record,
        })
      }
    }

    expect(lines).toEqual([
      '[yookassa] payment.succeeded for pmt_1: order paid',
      '[yookassa] payment_method.active for pm_1: payment method active',
      '[yookassa] refund.succeeded for rfnd_1: refund refunded',
      '[yookassa] payment.succeeded for pmt_1 failed: boom',
      '[yookassa] payment_method.active for pm_1 failed: bang',
      '[yookassa] refund.succeeded for rfnd_1 failed: bust',
    ])
    for (const forbidden of [
      secret,
      'order-in-the-body',
      'pm_secret',
      '4444',
      '4900.00',
      '220000',
      'Bank of the body',
      'subscription-in-the-body',
      'payment-in-the-body',
      'refund-reason-in-the-body',
    ]) {
      expect(lines.join('\n')).not.toContain(forbidden)
    }
  })

  it('writes an object id to the log as one short word', async () => {
    const settlePayment = vi.fn().mockResolvedValue({ state: 'unknown' })
    const { send, log } = route(settlePayment)
    const id = `pmt_1\n[yookassa] payment.succeeded for forged: order paid ${'x'.repeat(200)}`

    const res = await send('payment.succeeded', { ...events['payment.succeeded'], id })

    expect(res.status).toBe(200)
    // The settlement gets the id as it came; the log gets no line break and no more than 64.
    expect(settlePayment).toHaveBeenCalledExactlyOnceWith(id)
    const [[line]] = log.mock.calls as [[string]]
    expect(line).not.toContain('\n')
    expect(line).toBe(
      `[yookassa] payment.succeeded for ${id.slice(0, 64).replace(/[^\w.-]/g, '?')}: order unknown`,
    )
  })

  it('reports a failure to the console when the route gives no log of its own', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    try {
      const onEvent = yookassaEventHandler({
        settlePayment: vi
          .fn()
          .mockResolvedValueOnce({ state: 'failed' })
          .mockRejectedValue(new Error('boom')),
        settlePaymentMethod: vi.fn(),
        settleRefund: vi.fn(),
      })
      const send = () =>
        handleYookassaWebhook(post(JSON.stringify(notification), YOOKASSA_IP), {
          requireAllowlist: true,
          onEvent,
        })

      expect((await send()).status).toBe(200)
      expect((await send()).status).toBe(500)

      expect(info.mock.calls).toEqual([['[yookassa] payment.succeeded for pmt_1: order failed']])
      expect(error.mock.calls).toEqual([['[yookassa] payment.succeeded for pmt_1 failed: boom']])
    } finally {
      error.mockRestore()
      info.mockRestore()
    }
  })
})
