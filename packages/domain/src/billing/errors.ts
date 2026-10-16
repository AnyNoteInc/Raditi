import { z } from 'zod'
import { badRequest, DomainError } from '../errors.ts'

/**
 * Billing failures the customer may meet. The codes are stable: the client text of each one is
 * chosen by its code, the English messages below are for the logs.
 */
export const billingErrorCodes = [
  'BILLING_PAYMENTS_NOT_CONFIGURED',
  'BILLING_PLAN_NOT_FOUND',
  'BILLING_ALREADY_ON_PLAN',
  'BILLING_NO_LIVE_SUBSCRIPTION',
  'BILLING_SUBSCRIPTION_PAST_DUE',
  'BILLING_SUBSCRIPTION_EXISTS',
  'BILLING_PACK_NEEDS_SUBSCRIPTION',
  'BILLING_ORDER_NOT_FOUND',
  'BILLING_PAYMENT_DECLINED',
  'BILLING_PAYMENT_IN_PROGRESS',
  'BILLING_NOTHING_TO_CHANGE',
  'BILLING_AUTO_RENEWAL_UNAVAILABLE',
  'BILLING_PLAN_SITE_LIMIT',
  'BILLING_TASK_NEEDS_SUBSCRIPTION',
  'BILLING_NOT_ENOUGH_CREDITS',
  'BILLING_DAILY_LIMIT_REACHED',
  'BILLING_CREDITS_HELD',
  'BILLING_UNPAID_WORK_LIMIT',
  'BILLING_CREDIT_RATE_MISSING',
] as const
export type BillingErrorCode = (typeof billingErrorCodes)[number]

/**
 * Why a task is not taken, more exactly than the code of the refusal says: the pages choose
 * their text by the reason, and so does the server when it refuses a request all the same.
 * `gift_*` and `trial_*` are of a workspace without a paid tariff, on its gift credits;
 * `past_due` and `ended` are of a tariff that is not paid when the gift cannot carry the task;
 * `empty`, `below_start`, `daily_limit` and `unpaid_limit` are of a paid tariff; `held` and
 * `rate_missing` are of both.
 */
export const taskRefusalReasons = [
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
] as const
export type TaskRefusalReason = (typeof taskRefusalReasons)[number]

/** The code each reason is refused with; several reasons share a code. */
export const taskRefusalCodes = Object.freeze({
  gift_spent: 'BILLING_TASK_NEEDS_SUBSCRIPTION',
  gift_below_start: 'BILLING_TASK_NEEDS_SUBSCRIPTION',
  trial_unpaid_limit: 'BILLING_TASK_NEEDS_SUBSCRIPTION',
  trial_daily_limit: 'BILLING_DAILY_LIMIT_REACHED',
  gift_site_used: 'BILLING_TASK_NEEDS_SUBSCRIPTION',
  empty: 'BILLING_NOT_ENOUGH_CREDITS',
  below_start: 'BILLING_NOT_ENOUGH_CREDITS',
  held: 'BILLING_CREDITS_HELD',
  daily_limit: 'BILLING_DAILY_LIMIT_REACHED',
  unpaid_limit: 'BILLING_UNPAID_WORK_LIMIT',
  past_due: 'BILLING_TASK_NEEDS_SUBSCRIPTION',
  ended: 'BILLING_TASK_NEEDS_SUBSCRIPTION',
  rate_missing: 'BILLING_CREDIT_RATE_MISSING',
} as const satisfies Record<TaskRefusalReason, BillingErrorCode>)

// Whole counts of credits: the numbers a refusal is explained with.
const refusalCreditsSchema = z.number().int().nonnegative()

/**
 * `DomainError.details` of a refused task. Read on the server only: a browser gets the code of
 * the error and nothing else, so the sentence with the numbers is built before the answer
 * leaves.
 */
export const taskRefusalDetailsSchema = z.strictObject({
  reason: z.enum(taskRefusalReasons),
  /** What a task could take now: the credits free on the accounts it may spend. */
  spendable: refusalCreditsSchema,
  /** What is set aside for other tasks in work on those accounts. */
  held: refusalCreditsSchema,
  /** How many spendable credits the task needed to be taken. */
  needed: refusalCreditsSchema,
})
export type TaskRefusalDetails = z.infer<typeof taskRefusalDetailsSchema>

const billingError = (
  code: BillingErrorCode,
  message: string,
  httpStatus: number,
  details?: TaskRefusalDetails,
): DomainError => new DomainError(code, message, httpStatus, details)

/** The ЮKassa shop is not set up: nothing can be paid for, on our side and for now. */
export const billingPaymentsNotConfigured = (): DomainError =>
  billingError('BILLING_PAYMENTS_NOT_CONFIGURED', 'Payments are not configured', 503)
/** No such plan, or it is no longer sold. */
export const billingPlanNotFound = (): DomainError =>
  billingError('BILLING_PLAN_NOT_FOUND', 'Plan not found', 404)
/** The plan asked for is the one the subscription has, or already switches to. */
export const billingAlreadyOnPlan = (): DomainError =>
  billingError('BILLING_ALREADY_ON_PLAN', 'The workspace is already on this plan', 409)
/** The action needs a subscription in trial, active or past_due. */
export const billingNoLiveSubscription = (): DomainError =>
  billingError('BILLING_NO_LIVE_SUBSCRIPTION', 'The workspace has no live subscription', 409)
/**
 * The action needs a tariff that is paid for, and this one is past due: the customer pays for
 * it first. Auto-renewal is not switched on for a tariff whose last charge failed.
 */
export const billingSubscriptionPastDue = (): DomainError =>
  billingError('BILLING_SUBSCRIPTION_PAST_DUE', 'The subscription is past due and unpaid', 409)
/** A first payment while a subscription is live: the plan is changed, not bought again. */
export const billingSubscriptionExists = (): DomainError =>
  billingError('BILLING_SUBSCRIPTION_EXISTS', 'The workspace already has a live subscription', 409)
/** A credit pack is sold only on top of a live tariff. */
export const billingPackNeedsSubscription = (): DomainError =>
  billingError('BILLING_PACK_NEEDS_SUBSCRIPTION', 'A credit pack needs a live subscription', 409)
/** No such order in this workspace. */
export const billingOrderNotFound = (): DomainError =>
  billingError('BILLING_ORDER_NOT_FOUND', 'Order not found', 404)
/** The bank or ЮKassa refused the payment; the customer may try another method. */
export const billingPaymentDeclined = (): DomainError =>
  billingError('BILLING_PAYMENT_DECLINED', 'The payment was declined', 402)
/**
 * The customer has confirmed the previous payment of the tariff and the bank has not answered
 * yet: a second payment would charge them twice, so the checkout waits for the first.
 */
export const billingPaymentInProgress = (): DomainError =>
  billingError('BILLING_PAYMENT_IN_PROGRESS', 'The previous payment is still being processed', 409)
/** Auto-renewal or a scheduled plan change is already in the state asked for. */
export const billingNothingToChange = (): DomainError =>
  billingError('BILLING_NOTHING_TO_CHANGE', 'There is nothing to resume or cancel', 409)
/**
 * The shop takes one-time payments only (YOOKASSA_AUTOPAYMENTS=off): no payment method is saved
 * or bound and auto-renewal is not switched on. The customer pays for the tariff without it.
 */
export const billingAutoRenewalUnavailable = (): DomainError =>
  billingError(
    'BILLING_AUTO_RENEWAL_UNAVAILABLE',
    'Auto-renewal is unavailable: the shop does not save payment methods',
    409,
  )
/** The workspace has more sites than the plan allows. */
export const billingPlanSiteLimit = (): DomainError =>
  billingError('BILLING_PLAN_SITE_LIMIT', 'The plan allows fewer sites than the workspace has', 409)
/**
 * A new task is taken only while the tariff is paid: not without a subscription, not after it
 * ended and not in past_due, which is live. Purchased credits do not replace the tariff. With
 * details it is also the refusal of a workspace whose gift credits cannot carry the task; the
 * reason says which case it is.
 */
export const billingTaskNeedsSubscription = (details?: TaskRefusalDetails): DomainError =>
  billingError(
    'BILLING_TASK_NEEDS_SUBSCRIPTION',
    'A task needs an active subscription',
    402,
    details,
  )
/** Nothing to reserve for a task: no credit is available on the tariff or among purchased ones. */
export const billingNotEnoughCredits = (details?: TaskRefusalDetails): DomainError =>
  billingError('BILLING_NOT_ENOUGH_CREDITS', 'The workspace has not enough credits', 402, details)
/**
 * The tasks for this Moscow calendar day are used up — those of the plan, or those a workspace
 * may start without a paid tariff; buying credits does not lift it today.
 */
export const billingDailyLimitReached = (details?: TaskRefusalDetails): DomainError =>
  billingError(
    'BILLING_DAILY_LIMIT_REACHED',
    'The daily task limit of the plan is reached',
    409,
    details,
  )
/**
 * The credits a task could spend are there, and all of them are set aside for tasks in work:
 * what those tasks do not use comes back when they end. Paying lifts it at once.
 */
export const billingCreditsHeld = (details?: TaskRefusalDetails): DomainError =>
  billingError(
    'BILLING_CREDITS_HELD',
    'Every spendable credit is held by tasks in work',
    409,
    details,
  )
/**
 * The work the workspace got without a charge has reached its bound: too many tasks ended
 * without a result. Nothing was charged for them; new tasks wait for an operator to look.
 */
export const billingUnpaidWorkLimit = (details?: TaskRefusalDetails): DomainError =>
  billingError(
    'BILLING_UNPAID_WORK_LIMIT',
    'The bound on unpaid work of the workspace is reached',
    409,
    details,
  )
/**
 * No credit rate can convert the work of a task: none is approved yet, or the newest price of a
 * model is younger than the rate. On our side and for now, like LLM_PRICE_MISSING.
 */
export const billingCreditRateMissing = (details?: TaskRefusalDetails): DomainError =>
  billingError('BILLING_CREDIT_RATE_MISSING', 'No usable credit rate', 503, details)

const refusalByCode = {
  BILLING_TASK_NEEDS_SUBSCRIPTION: billingTaskNeedsSubscription,
  BILLING_NOT_ENOUGH_CREDITS: billingNotEnoughCredits,
  BILLING_DAILY_LIMIT_REACHED: billingDailyLimitReached,
  BILLING_CREDITS_HELD: billingCreditsHeld,
  BILLING_UNPAID_WORK_LIMIT: billingUnpaidWorkLimit,
  BILLING_CREDIT_RATE_MISSING: billingCreditRateMissing,
} satisfies Record<(typeof taskRefusalCodes)[TaskRefusalReason], unknown>

// What else a verdict carries is dropped: the details hold these four fields and nothing more.
const givenRefusalSchema = z.object(taskRefusalDetailsSchema.shape)

/**
 * The error a refused task is answered with: the code of its reason, and the reason with its
 * three numbers as the details. A verdict is passed as it is.
 */
export function taskRefusal(refusal: TaskRefusalDetails): DomainError {
  const result = givenRefusalSchema.safeParse(refusal)
  if (!result.success) return badRequest('Invalid task refusal')
  return refusalByCode[taskRefusalCodes[result.data.reason]](result.data)
}
