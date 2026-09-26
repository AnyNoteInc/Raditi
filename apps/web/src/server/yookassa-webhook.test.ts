import { describe, expect, it, vi } from 'vitest'

import { handleYookassaWebhook, webhookSenderIp } from './yookassa-webhook'

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

const post = (body: string, ip?: string) =>
  new Request('http://localhost:3000/api/webhooks/yookassa', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(ip === undefined ? {} : { 'x-forwarded-for': ip }),
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
