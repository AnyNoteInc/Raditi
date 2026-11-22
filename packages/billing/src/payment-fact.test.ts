import type { Payment } from '@repo/yookassa'
import { describe, expect, it } from 'vitest'

import { paymentFactDetail } from './payment-fact.ts'

// The fact of a paid service (Decree № 1526, p. 3 «д»; docs/plan/88-artifacts.md, 88.16а-1).

const order = { id: '0199a000-0000-7000-8000-0000000000b2', kind: 'pack' as const }
const payment = (extra: Partial<Payment> = {}): Payment => ({
  id: '2f1a0c6e-000f-5000-8000-1b2c3d4e5f60',
  status: 'succeeded',
  paid: true,
  amount: { value: '1490.5', currency: 'RUB' },
  created_at: '2026-11-22T10:00:00.000Z',
  ...extra,
})

describe('the fact of a payment', () => {
  it('keeps the organisation, transaction, currency, amount and order', () => {
    expect(paymentFactDetail(order, payment())).toEqual({
      organisation: 'ЮKassa',
      transaction: '2f1a0c6e-000f-5000-8000-1b2c3d4e5f60',
      currency: 'RUB',
      amount: '1490.50',
      order: order.id,
      service: 'pack',
    })
  })

  it('names the payment system and its identifiers, never the card number', () => {
    const detail = paymentFactDetail(
      order,
      payment({
        payment_method: {
          id: 'pm-1',
          type: 'bank_card',
          saved: false,
          card: { first6: '220220', last4: '4242', card_type: 'Mir' },
        },
      }),
    )
    expect(detail).toMatchObject({ system: 'bank_card', methodId: 'pm-1', card: 'Mir' })
    expect(JSON.stringify(detail)).not.toMatch(/220220|4242/)
  })
})
