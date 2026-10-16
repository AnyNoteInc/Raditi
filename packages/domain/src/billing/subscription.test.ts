import { describe, expect, it } from 'vitest'
import {
  isLiveSubscription,
  liveSubscriptionStatuses,
  nextSubscriptionStatus,
  subscriptionAllowsTasks,
  subscriptionEvents,
  subscriptionStatuses,
  subscriptionStatusSchema,
  type SubscriptionEvent,
  type SubscriptionStatus,
} from './subscription.ts'

type Current = SubscriptionStatus | null

const allowed: readonly (readonly [Current, SubscriptionEvent, SubscriptionStatus])[] = [
  [null, 'first_payment_succeeded', 'active'],
  ['active', 'renewal_succeeded', 'active'],
  ['active', 'renewal_declined', 'past_due'],
  ['active', 'period_ended_without_renewal', 'cancelled'],
  ['past_due', 'past_due_grace_ended', 'expired'],
  ['past_due', 'past_due_payment_succeeded', 'active'],
  ['active', 'refunded_by_operator', 'cancelled'],
  ['past_due', 'refunded_by_operator', 'cancelled'],
]

const currents: readonly Current[] = [null, ...subscriptionStatuses]
const forbidden = currents.flatMap((current) =>
  subscriptionEvents
    .filter((event) => !allowed.some(([from, on]) => from === current && on === event))
    .map((event) => [current, event] as const),
)

describe('subscription statuses', () => {
  it('lists exactly the values of the database enum', () => {
    expect(subscriptionStatuses).toEqual(['trial', 'active', 'past_due', 'cancelled', 'expired'])
    for (const status of subscriptionStatuses) {
      expect(subscriptionStatusSchema.parse(status)).toBe(status)
    }
  })

  it.each(['canceled', 'ACTIVE', 'pending', '', null])('rejects %j as a status', (value) => {
    expect(subscriptionStatusSchema.safeParse(value).success).toBe(false)
  })

  it('lists the seven events of a subscription', () => {
    expect(subscriptionEvents).toEqual([
      'first_payment_succeeded',
      'renewal_succeeded',
      'renewal_declined',
      'period_ended_without_renewal',
      'past_due_grace_ended',
      'past_due_payment_succeeded',
      'refunded_by_operator',
    ])
  })
})

describe('nextSubscriptionStatus', () => {
  it.each(allowed)('%s on %s becomes %s', (current, event, next) => {
    expect(nextSubscriptionStatus(current, event)).toBe(next)
  })

  it('covers every pair of status and event with the two tables', () => {
    expect(allowed.length + forbidden.length).toBe(currents.length * subscriptionEvents.length)
    expect(forbidden).toHaveLength(34)
  })

  it.each(forbidden)('refuses %s on %s', (current, event) => {
    expect(() => nextSubscriptionStatus(current, event)).toThrow(
      expect.objectContaining({ name: 'DomainError', code: 'CONFLICT', httpStatus: 409 }),
    )
  })

  it('names the status and the event in the error', () => {
    expect(() => nextSubscriptionStatus('expired', 'renewal_succeeded')).toThrowError(
      'Subscription in status expired cannot handle renewal_succeeded',
    )
    expect(() => nextSubscriptionStatus(null, 'renewal_declined')).toThrowError(
      'Subscription in status none cannot handle renewal_declined',
    )
  })

  it.each(subscriptionEvents)('keeps cancelled and expired final on %s', (event) => {
    expect(() => nextSubscriptionStatus('cancelled', event)).toThrow()
    expect(() => nextSubscriptionStatus('expired', event)).toThrow()
  })

  it.each(subscriptionEvents)('refuses %s for a trial, which has no rules yet', (event) => {
    expect(() => nextSubscriptionStatus('trial', event)).toThrow()
  })

  it('refuses a second first payment while a subscription is live', () => {
    for (const status of liveSubscriptionStatuses) {
      expect(() => nextSubscriptionStatus(status, 'first_payment_succeeded')).toThrow()
    }
  })

  it('refuses an event it does not know, inherited object keys included', () => {
    for (const event of ['refunded', 'toString', 'constructor', '']) {
      for (const current of currents) {
        expect(() => nextSubscriptionStatus(current, event as SubscriptionEvent)).toThrow(
          expect.objectContaining({ name: 'DomainError', code: 'CONFLICT' }),
        )
      }
    }
  })

  it('follows a subscription through renewals, a declined charge and a late payment', () => {
    const events: SubscriptionEvent[] = [
      'first_payment_succeeded',
      'renewal_succeeded',
      'renewal_declined',
      'past_due_payment_succeeded',
      'renewal_succeeded',
      'period_ended_without_renewal',
    ]
    const path: Current[] = [null]
    for (const event of events) path.push(nextSubscriptionStatus(path.at(-1)!, event))
    expect(path).toEqual([null, 'active', 'active', 'past_due', 'active', 'active', 'cancelled'])
  })

  it('ends an unpaid subscription as expired, not cancelled', () => {
    const pastDue = nextSubscriptionStatus('active', 'renewal_declined')
    expect(nextSubscriptionStatus(pastDue, 'past_due_grace_ended')).toBe('expired')
  })

  it('lets an operator end a paid tariff and an overdue one with a refund, and nothing else', () => {
    expect(nextSubscriptionStatus('active', 'refunded_by_operator')).toBe('cancelled')
    const pastDue = nextSubscriptionStatus('active', 'renewal_declined')
    expect(nextSubscriptionStatus(pastDue, 'refunded_by_operator')).toBe('cancelled')
    // Nothing to end: no subscription, a trial without rules, a tariff that is already over.
    for (const current of [null, 'trial', 'cancelled', 'expired'] as const) {
      expect(() => nextSubscriptionStatus(current, 'refunded_by_operator')).toThrowError(
        `Subscription in status ${current ?? 'none'} cannot handle refunded_by_operator`,
      )
    }
  })

  it('ends a tariff once: a second refund finds it cancelled and is refused', () => {
    const ended = nextSubscriptionStatus('active', 'refunded_by_operator')
    expect(() => nextSubscriptionStatus(ended, 'refunded_by_operator')).toThrow(
      expect.objectContaining({ name: 'DomainError', code: 'CONFLICT' }),
    )
  })
})

describe('subscription predicates', () => {
  it.each([
    [null, false, false],
    ['trial', true, false],
    ['active', true, true],
    ['past_due', true, false],
    ['cancelled', false, false],
    ['expired', false, false],
  ] as const)('%s: live %s, lets the customer queue tasks %s', (status, live, allowsTasks) => {
    expect(isLiveSubscription(status)).toBe(live)
    expect(subscriptionAllowsTasks(status)).toBe(allowsTasks)
  })

  it('counts as live exactly the statuses of the partial unique index', () => {
    expect(liveSubscriptionStatuses).toEqual(['trial', 'active', 'past_due'])
    expect(subscriptionStatuses.filter((status) => isLiveSubscription(status))).toEqual(
      liveSubscriptionStatuses,
    )
  })

  it('never lets a subscription that is not live queue tasks', () => {
    for (const status of subscriptionStatuses) {
      if (subscriptionAllowsTasks(status)) expect(isLiveSubscription(status)).toBe(true)
    }
  })

  it('only ever moves a subscription between live statuses or ends it', () => {
    for (const [current, , next] of allowed) {
      if (current !== null) expect(isLiveSubscription(current)).toBe(true)
      expect(subscriptionStatuses).toContain(next)
    }
  })
})
