import { DomainError } from '../errors.ts'

/**
 * Billing failures the customer may meet. The codes are stable: the client text of each one is
 * chosen by its code, the English messages below are for the logs.
 */
export const billingErrorCodes = [
  'BILLING_PAYMENTS_NOT_CONFIGURED',
  'BILLING_PLAN_NOT_FOUND',
  'BILLING_ALREADY_ON_PLAN',
  'BILLING_NO_LIVE_SUBSCRIPTION',
  'BILLING_SUBSCRIPTION_EXISTS',
  'BILLING_PACK_NEEDS_SUBSCRIPTION',
  'BILLING_ORDER_NOT_FOUND',
  'BILLING_PAYMENT_DECLINED',
  'BILLING_NOTHING_TO_CHANGE',
  'BILLING_PLAN_SITE_LIMIT',
] as const
export type BillingErrorCode = (typeof billingErrorCodes)[number]

const billingError = (code: BillingErrorCode, message: string, httpStatus: number): DomainError =>
  new DomainError(code, message, httpStatus)

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
/** A first payment while a subscription is live: the plan is changed, not bought again. */
export const billingSubscriptionExists = (): DomainError =>
  billingError('BILLING_SUBSCRIPTION_EXISTS', 'The workspace already has a live subscription', 409)
/** An edit pack is sold only on top of a live tariff. */
export const billingPackNeedsSubscription = (): DomainError =>
  billingError('BILLING_PACK_NEEDS_SUBSCRIPTION', 'An edit pack needs a live subscription', 409)
/** No such order in this workspace. */
export const billingOrderNotFound = (): DomainError =>
  billingError('BILLING_ORDER_NOT_FOUND', 'Order not found', 404)
/** The bank or ЮKassa refused the payment; the customer may try another method. */
export const billingPaymentDeclined = (): DomainError =>
  billingError('BILLING_PAYMENT_DECLINED', 'The payment was declined', 402)
/** Auto-renewal or a scheduled plan change is already in the state asked for. */
export const billingNothingToChange = (): DomainError =>
  billingError('BILLING_NOTHING_TO_CHANGE', 'There is nothing to resume or cancel', 409)
/** The workspace has more sites than the plan allows. */
export const billingPlanSiteLimit = (): DomainError =>
  billingError('BILLING_PLAN_SITE_LIMIT', 'The plan allows fewer sites than the workspace has', 409)
