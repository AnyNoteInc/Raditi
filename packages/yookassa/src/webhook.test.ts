import { describe, expect, it } from 'vitest'

import { YookassaError } from './errors.ts'
import { YOOKASSA_WEBHOOK_IP_RANGES, parseWebhookEvent, verifyTrustedIp } from './webhook.ts'

const paymentObject = (status: string, extra: Record<string, unknown> = {}) => ({
  id: 'pmt_1',
  status,
  paid: status === 'succeeded' || status === 'waiting_for_capture',
  amount: { value: '4900.00', currency: 'RUB' },
  created_at: '2026-09-26T00:00:00Z',
  ...extra,
})

describe('parseWebhookEvent', () => {
  it('parses payment.succeeded with a saved payment method', () => {
    const event = parseWebhookEvent({
      type: 'notification',
      event: 'payment.succeeded',
      object: paymentObject('succeeded', {
        payment_method: {
          id: 'pm_1',
          type: 'bank_card',
          saved: true,
          card: { first6: '555555', last4: '4444', card_type: 'MasterCard' },
        },
        metadata: { orderId: 'order_1' },
      }),
    })
    expect(event.event).toBe('payment.succeeded')
    expect(event.object.id).toBe('pmt_1')
    if (event.event === 'payment.succeeded') {
      expect(event.object.payment_method?.saved).toBe(true)
      expect(event.object.metadata).toEqual({ orderId: 'order_1' })
    }
  })

  it('parses payment.canceled with cancellation details', () => {
    const event = parseWebhookEvent({
      type: 'notification',
      event: 'payment.canceled',
      object: paymentObject('canceled', {
        cancellation_details: { party: 'yoo_money', reason: 'expired_on_confirmation' },
      }),
    })
    expect(event.event).toBe('payment.canceled')
  })

  it('parses payment.waiting_for_capture', () => {
    const event = parseWebhookEvent({
      type: 'notification',
      event: 'payment.waiting_for_capture',
      object: paymentObject('waiting_for_capture'),
    })
    expect(event.event).toBe('payment.waiting_for_capture')
  })

  it('parses refund.succeeded', () => {
    const event = parseWebhookEvent({
      type: 'notification',
      event: 'refund.succeeded',
      object: {
        id: 'rf_1',
        payment_id: 'pmt_1',
        status: 'succeeded',
        amount: { value: '1990.00', currency: 'RUB' },
        created_at: '2026-09-26T00:00:00Z',
      },
    })
    expect(event.event).toBe('refund.succeeded')
    if (event.event === 'refund.succeeded') expect(event.object.payment_id).toBe('pmt_1')
  })

  it('throws on an unknown event', () => {
    expect(() =>
      parseWebhookEvent({
        type: 'notification',
        event: 'weird',
        object: paymentObject('succeeded'),
      }),
    ).toThrow(YookassaError)
  })

  it('throws on a missing body', () => {
    expect(() => parseWebhookEvent(null)).toThrow(YookassaError)
  })

  it('throws on a missing object', () => {
    expect(() => parseWebhookEvent({ type: 'notification', event: 'payment.succeeded' })).toThrow(
      YookassaError,
    )
  })

  it('throws when the event contradicts the object status', () => {
    expect(() =>
      parseWebhookEvent({
        type: 'notification',
        event: 'payment.succeeded',
        object: paymentObject('pending'),
      }),
    ).toThrow(/does not match/)
  })

  it.each([4900, '4900', '4900.0', '4900.000', '4900,00'])(
    'throws on the amount value %j',
    (value) => {
      expect(() =>
        parseWebhookEvent({
          type: 'notification',
          event: 'payment.succeeded',
          object: paymentObject('succeeded', { amount: { value, currency: 'RUB' } }),
        }),
      ).toThrow(/amount/)
    },
  )
})

describe('verifyTrustedIp', () => {
  const prod = { requireAllowlist: true }
  const dev = { requireAllowlist: false }

  it('allows everything with an empty allowlist outside production', () => {
    expect(verifyTrustedIp('8.8.8.8', [], dev)).toBe(true)
    expect(verifyTrustedIp('8.8.8.8', ['', ' '], dev)).toBe(true)
  })

  it('denies everything with an empty allowlist in production', () => {
    expect(verifyTrustedIp('185.71.76.5', [], prod)).toBe(false)
    expect(verifyTrustedIp('185.71.76.5', [' '], prod)).toBe(false)
  })

  it('matches IPv4 CIDRs', () => {
    const list = ['185.71.76.0/27', '77.75.156.0/27']
    expect(verifyTrustedIp('185.71.76.5', list, prod)).toBe(true)
    expect(verifyTrustedIp('77.75.156.10', list, prod)).toBe(true)
    expect(verifyTrustedIp('185.71.76.32', list, prod)).toBe(false)
    expect(verifyTrustedIp('8.8.8.8', list, prod)).toBe(false)
  })

  it('matches single addresses and /32 entries', () => {
    expect(verifyTrustedIp('1.2.3.4', ['1.2.3.4/32'], prod)).toBe(true)
    expect(verifyTrustedIp('1.2.3.5', ['1.2.3.4/32'], prod)).toBe(false)
    expect(verifyTrustedIp('77.75.156.11', ['77.75.156.11'], prod)).toBe(true)
    expect(verifyTrustedIp('77.75.156.12', ['77.75.156.11'], prod)).toBe(false)
  })

  it('matches IPv6 CIDRs', () => {
    expect(verifyTrustedIp('2a02:5180::1', ['2a02:5180::/32'], prod)).toBe(true)
    expect(verifyTrustedIp('2a02:5180:ffff:1::abcd', ['2a02:5180::/32'], prod)).toBe(true)
    expect(verifyTrustedIp('2A02:5180::1', ['2a02:5180::/32'], prod)).toBe(true)
    expect(verifyTrustedIp('2a02:5181::1', ['2a02:5180::/32'], prod)).toBe(false)
    expect(verifyTrustedIp('2001:db8::1', ['2a02:5180::/32'], prod)).toBe(false)
  })

  it('matches IPv4-mapped IPv6 peers against IPv4 entries', () => {
    expect(verifyTrustedIp('::ffff:185.71.76.5', ['185.71.76.0/27'], prod)).toBe(true)
    expect(verifyTrustedIp('::ffff:8.8.8.8', ['185.71.76.0/27'], prod)).toBe(false)
  })

  it('accepts bracketed IPv6 and strips zone ids', () => {
    expect(verifyTrustedIp('[2a02:5180::1]', ['2a02:5180::/32'], prod)).toBe(true)
    expect(verifyTrustedIp('fe80::1%eth0', ['2a02:5180::/32'], prod)).toBe(false)
  })

  it('does not let IPv4 and IPv6 ranges cross-match', () => {
    expect(verifyTrustedIp('2a02:5180::1', ['0.0.0.0/0'], prod)).toBe(false)
    expect(verifyTrustedIp('1.2.3.4', ['2a02:5180::/32'], prod)).toBe(false)
  })

  it.each([null, undefined, '', 'not.an.ip', '185.71.76.5:443', '999.1.1.1'])(
    'returns false for the malformed address %j',
    (ip) => {
      expect(verifyTrustedIp(ip, ['185.71.76.0/27'], prod)).toBe(false)
      expect(verifyTrustedIp(ip, ['185.71.76.0/27'], dev)).toBe(false)
    },
  )

  it.each([
    '300.1.1.1/24',
    '1.2.3.4/33',
    '1.2.3.4/x',
    '2a02::/129',
    'host.example',
    '1.2.3.4/24/1',
  ])('throws on the malformed allowlist entry %j', (entry) => {
    expect(() => verifyTrustedIp('1.2.3.4', [entry], prod)).toThrow(YookassaError)
  })

  it('covers every address ЮKassa publishes', () => {
    for (const ip of [
      '185.71.76.1',
      '185.71.77.31',
      '77.75.153.127',
      '77.75.156.11',
      '77.75.156.35',
      '77.75.154.200',
      '2a02:5180:0:1::10',
    ]) {
      expect(verifyTrustedIp(ip, YOOKASSA_WEBHOOK_IP_RANGES, prod)).toBe(true)
    }
    for (const ip of ['185.71.78.1', '77.75.153.128', '77.75.156.12', '77.75.154.127']) {
      expect(verifyTrustedIp(ip, YOOKASSA_WEBHOOK_IP_RANGES, prod)).toBe(false)
    }
  })
})
