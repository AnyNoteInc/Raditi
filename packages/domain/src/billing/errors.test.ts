import { describe, expect, it } from 'vitest'
import { DomainError, isDomainError, isTooLarge } from '../errors.ts'
import {
  billingAlreadyOnPlan,
  billingAutoRenewalUnavailable,
  billingCreditRateMissing,
  billingCreditsHeld,
  billingDailyLimitReached,
  billingErrorCodes,
  billingNotEnoughCredits,
  billingNoLiveSubscription,
  billingNothingToChange,
  billingOrderNotFound,
  billingPackNeedsSubscription,
  billingPaymentDeclined,
  billingPaymentInProgress,
  billingPaymentsNotConfigured,
  billingPlanNotFound,
  billingPlanSiteLimit,
  billingSubscriptionExists,
  billingSubscriptionPastDue,
  billingTaskNeedsSubscription,
  billingUnpaidWorkLimit,
  taskRefusal,
  taskRefusalCodes,
  taskRefusalDetailsSchema,
  taskRefusalReasons,
  type TaskRefusalDetails,
  type TaskRefusalReason,
} from './errors.ts'

const factories = [
  ['BILLING_PAYMENTS_NOT_CONFIGURED', 503, billingPaymentsNotConfigured],
  ['BILLING_PLAN_NOT_FOUND', 404, billingPlanNotFound],
  ['BILLING_ALREADY_ON_PLAN', 409, billingAlreadyOnPlan],
  ['BILLING_NO_LIVE_SUBSCRIPTION', 409, billingNoLiveSubscription],
  ['BILLING_SUBSCRIPTION_PAST_DUE', 409, billingSubscriptionPastDue],
  ['BILLING_SUBSCRIPTION_EXISTS', 409, billingSubscriptionExists],
  ['BILLING_PACK_NEEDS_SUBSCRIPTION', 409, billingPackNeedsSubscription],
  ['BILLING_ORDER_NOT_FOUND', 404, billingOrderNotFound],
  ['BILLING_PAYMENT_DECLINED', 402, billingPaymentDeclined],
  ['BILLING_PAYMENT_IN_PROGRESS', 409, billingPaymentInProgress],
  ['BILLING_NOTHING_TO_CHANGE', 409, billingNothingToChange],
  ['BILLING_AUTO_RENEWAL_UNAVAILABLE', 409, billingAutoRenewalUnavailable],
  ['BILLING_PLAN_SITE_LIMIT', 409, billingPlanSiteLimit],
  ['BILLING_TASK_NEEDS_SUBSCRIPTION', 402, billingTaskNeedsSubscription],
  ['BILLING_NOT_ENOUGH_CREDITS', 402, billingNotEnoughCredits],
  ['BILLING_DAILY_LIMIT_REACHED', 409, billingDailyLimitReached],
  ['BILLING_CREDITS_HELD', 409, billingCreditsHeld],
  ['BILLING_UNPAID_WORK_LIMIT', 409, billingUnpaidWorkLimit],
  ['BILLING_CREDIT_RATE_MISSING', 503, billingCreditRateMissing],
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
    expect(billingErrorCodes).toHaveLength(19)
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

describe('the refusal of a task', () => {
  const details = (reason: TaskRefusalReason, spendable = 3, held = 0, needed = 5) => ({
    reason,
    spendable,
    held,
    needed,
  })

  it('names every reason once, in one order', () => {
    expect(taskRefusalReasons).toEqual([
      'gift_spent',
      'gift_below_start',
      'trial_unpaid_limit',
      'trial_daily_limit',
      'gift_site_used',
      'empty',
      'below_start',
      'held',
      'daily_limit',
      'unpaid_limit',
      'past_due',
      'ended',
      'rate_missing',
    ])
    expect(new Set(taskRefusalReasons).size).toBe(13)
  })

  // The codes are what a browser gets; the reason stays on the server and in the read model.
  it.each([
    ['gift_spent', 'BILLING_TASK_NEEDS_SUBSCRIPTION', 402],
    ['gift_below_start', 'BILLING_TASK_NEEDS_SUBSCRIPTION', 402],
    ['trial_unpaid_limit', 'BILLING_TASK_NEEDS_SUBSCRIPTION', 402],
    ['trial_daily_limit', 'BILLING_DAILY_LIMIT_REACHED', 409],
    ['gift_site_used', 'BILLING_TASK_NEEDS_SUBSCRIPTION', 402],
    ['empty', 'BILLING_NOT_ENOUGH_CREDITS', 402],
    ['below_start', 'BILLING_NOT_ENOUGH_CREDITS', 402],
    ['held', 'BILLING_CREDITS_HELD', 409],
    ['daily_limit', 'BILLING_DAILY_LIMIT_REACHED', 409],
    ['unpaid_limit', 'BILLING_UNPAID_WORK_LIMIT', 409],
    ['past_due', 'BILLING_TASK_NEEDS_SUBSCRIPTION', 402],
    ['ended', 'BILLING_TASK_NEEDS_SUBSCRIPTION', 402],
    ['rate_missing', 'BILLING_CREDIT_RATE_MISSING', 503],
  ] as const)('%s is refused with %s (%i)', (reason, code, httpStatus) => {
    expect(taskRefusalCodes[reason]).toBe(code)
    const error = taskRefusal(details(reason))
    expect(isDomainError(error)).toBe(true)
    expect(error).toMatchObject({ name: 'DomainError', code, httpStatus })
    expect(error.details).toEqual(details(reason))
  })

  it('gives every reason a code, and only codes of this list', () => {
    expect(Object.keys(taskRefusalCodes)).toEqual([...taskRefusalReasons])
    expect(Object.isFrozen(taskRefusalCodes)).toBe(true)
    for (const code of Object.values(taskRefusalCodes)) expect(billingErrorCodes).toContain(code)
    expect(new Set(Object.values(taskRefusalCodes))).toEqual(
      new Set([
        'BILLING_TASK_NEEDS_SUBSCRIPTION',
        'BILLING_NOT_ENOUGH_CREDITS',
        'BILLING_DAILY_LIMIT_REACHED',
        'BILLING_CREDITS_HELD',
        'BILLING_UNPAID_WORK_LIMIT',
        'BILLING_CREDIT_RATE_MISSING',
      ]),
    )
  })

  it('carries the reason and the three numbers, and nothing else of a verdict', () => {
    const verdict = { allowed: false, ...details('held', 2, 90, 5), launchesToday: 4 }
    const error = taskRefusal(verdict)
    expect(error.code).toBe('BILLING_CREDITS_HELD')
    expect(error.details).toEqual({ reason: 'held', spendable: 2, held: 90, needed: 5 })
    expect(taskRefusalDetailsSchema.safeParse(error.details).success).toBe(true)
    // the verdict itself is not what the schema of the details accepts
    expect(taskRefusalDetailsSchema.safeParse(verdict).success).toBe(false)
  })

  it('returns a new error on every call and does not change what it is given', () => {
    const given = details('empty', 0, 0, 5)
    expect(taskRefusal(given)).not.toBe(taskRefusal(given))
    expect(taskRefusal(given).details).not.toBe(given)
    expect(given).toEqual(details('empty', 0, 0, 5))
  })

  it.each<[string, unknown]>([
    ['a reason that is not one', details('no_credits' as TaskRefusalReason)],
    ['a code in place of the reason', details('BILLING_CREDITS_HELD' as TaskRefusalReason)],
    ['no reason', { spendable: 3, held: 0, needed: 5 }],
    ['a missing number', { reason: 'empty', spendable: 0, held: 0 }],
    ['a fraction of a credit', details('below_start', 2.5)],
    ['a negative number', details('held', 0, -1)],
    ['a number as a string', { ...details('empty'), needed: '5' }],
    ['NaN', details('empty', Number.NaN)],
    ['null', null],
    ['nothing', undefined],
  ])('answers BAD_REQUEST to %s', (_name, given) => {
    const error = taskRefusal(given as TaskRefusalDetails)
    expect(error).toMatchObject({ name: 'DomainError', code: 'BAD_REQUEST', httpStatus: 400 })
    expect(error.details).toBeUndefined()
  })

  it('describes the details strictly: four fields, whole numbers that are not negative', () => {
    expect(taskRefusalDetailsSchema.parse(details('ended', 0, 0, 5))).toEqual(
      details('ended', 0, 0, 5),
    )
    expect(Object.keys(taskRefusalDetailsSchema.shape)).toEqual([
      'reason',
      'spendable',
      'held',
      'needed',
    ])
    for (const bad of [
      { ...details('ended'), allowed: false },
      { ...details('ended'), spendable: 1.5 },
      { ...details('ended'), held: -1 },
      { ...details('ended'), needed: '5' },
      { ...details('ended'), reason: 'unknown' },
    ]) {
      expect(taskRefusalDetailsSchema.safeParse(bad).success).toBe(false)
    }
  })

  it('lets a refusal thrown by its own factory carry the same details', () => {
    const refusals = [
      [billingTaskNeedsSubscription, 'gift_spent'],
      [billingNotEnoughCredits, 'empty'],
      [billingDailyLimitReached, 'daily_limit'],
      [billingCreditsHeld, 'held'],
      [billingUnpaidWorkLimit, 'unpaid_limit'],
      [billingCreditRateMissing, 'rate_missing'],
    ] as const
    for (const [factory, reason] of refusals) {
      const error = factory(details(reason))
      expect(error.code).toBe(taskRefusalCodes[reason])
      expect(error.details).toEqual(details(reason))
      expect(error).toMatchObject({
        message: taskRefusal(details(reason)).message,
        httpStatus: taskRefusal(details(reason)).httpStatus,
      })
    }
  })
})
