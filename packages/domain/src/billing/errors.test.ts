import { describe, expect, it } from 'vitest'
import { DomainError, isDomainError, isTooLarge } from '../errors.ts'
import {
  billingAlreadyOnPlan,
  billingErrorCodes,
  billingNoLiveSubscription,
  billingNothingToChange,
  billingOrderNotFound,
  billingPackNeedsSubscription,
  billingPaymentDeclined,
  billingPaymentsNotConfigured,
  billingPlanNotFound,
  billingPlanSiteLimit,
  billingSubscriptionExists,
} from './errors.ts'

const factories = [
  ['BILLING_PAYMENTS_NOT_CONFIGURED', 503, billingPaymentsNotConfigured],
  ['BILLING_PLAN_NOT_FOUND', 404, billingPlanNotFound],
  ['BILLING_ALREADY_ON_PLAN', 409, billingAlreadyOnPlan],
  ['BILLING_NO_LIVE_SUBSCRIPTION', 409, billingNoLiveSubscription],
  ['BILLING_SUBSCRIPTION_EXISTS', 409, billingSubscriptionExists],
  ['BILLING_PACK_NEEDS_SUBSCRIPTION', 409, billingPackNeedsSubscription],
  ['BILLING_ORDER_NOT_FOUND', 404, billingOrderNotFound],
  ['BILLING_PAYMENT_DECLINED', 402, billingPaymentDeclined],
  ['BILLING_NOTHING_TO_CHANGE', 409, billingNothingToChange],
  ['BILLING_PLAN_SITE_LIMIT', 409, billingPlanSiteLimit],
] as const

describe('billing errors', () => {
  it.each(factories)('%s has status %i', (code, httpStatus, factory) => {
    const error = factory()
    expect(error).toBeInstanceOf(DomainError)
    expect(isDomainError(error)).toBe(true)
    expect(error).toMatchObject({ name: 'DomainError', code, httpStatus })
    expect(error.details).toBeUndefined()
  })

  it('lists every code once, each with its own factory', () => {
    const produced = factories.map(([, , factory]) => factory().code)
    expect(produced).toEqual([...billingErrorCodes])
    expect(new Set(billingErrorCodes).size).toBe(billingErrorCodes.length)
    expect(billingErrorCodes).toHaveLength(10)
  })

  it('prefixes every code with BILLING_ and writes it in upper snake case', () => {
    for (const code of billingErrorCodes) expect(code).toMatch(/^BILLING_[A-Z]+(?:_[A-Z]+)*$/)
  })

  it('writes an English message for the logs, with no customer text in it', () => {
    for (const [, , factory] of factories) {
      const { message } = factory()
      expect(message.length).toBeGreaterThan(0)
      expect(message).toMatch(/^[\x20-\x7e]+$/)
    }
    const messages = factories.map(([, , factory]) => factory().message)
    expect(new Set(messages).size).toBe(messages.length)
  })

  it('returns a new error on every call', () => {
    for (const [, , factory] of factories) expect(factory()).not.toBe(factory())
  })

  it('does not pass for a size limit', () => {
    for (const [, , factory] of factories) expect(isTooLarge(factory())).toBe(false)
  })
})
