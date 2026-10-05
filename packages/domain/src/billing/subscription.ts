import { z } from 'zod'
import { conflict } from '../errors.ts'

/**
 * Statuses of a workspace's subscription to a quota plan — the database enum
 * SubscriptionStatus (table subscriptions), not a model subscription of the pool.
 * `cancelled`: the paid period ended by the customer's choice. `expired`: it ended because a
 * payment did not arrive. `trial` exists in the database and is not used yet.
 */
export const subscriptionStatuses = ['trial', 'active', 'past_due', 'cancelled', 'expired'] as const
export const subscriptionStatusSchema = z.enum(subscriptionStatuses)
export type SubscriptionStatus = z.infer<typeof subscriptionStatusSchema>

/**
 * Live statuses: a workspace has at most one such subscription (the partial unique index on
 * subscriptions.workspace_id). The other two are final.
 */
export const liveSubscriptionStatuses: readonly SubscriptionStatus[] = [
  'trial',
  'active',
  'past_due',
]

export const subscriptionEvents = [
  'first_payment_succeeded',
  'renewal_succeeded',
  'renewal_declined',
  'period_ended_without_renewal',
  'past_due_grace_ended',
  'past_due_payment_succeeded',
] as const
export type SubscriptionEvent = (typeof subscriptionEvents)[number]

/** `from: null` — the workspace has no live subscription: the first payment creates one. */
const transitions: Record<
  SubscriptionEvent,
  { from: SubscriptionStatus | null; to: SubscriptionStatus }
> = {
  first_payment_succeeded: { from: null, to: 'active' },
  // the saved payment method was charged for the next period
  renewal_succeeded: { from: 'active', to: 'active' },
  // the bank refused the charge; a network failure is not this event, the charge is retried
  renewal_declined: { from: 'active', to: 'past_due' },
  // auto-renewal is off: never switched on, switched off, or the payment method was removed
  period_ended_without_renewal: { from: 'active', to: 'cancelled' },
  past_due_grace_ended: { from: 'past_due', to: 'expired' },
  // The customer paid by hand before the grace ran out. The row stays, its periods restart:
  // the new period is billingPeriod(paidAt, 0) and paidAt must be stored as the new
  // period_anchor, otherwise nextBillingPeriod refuses the next renewal.
  past_due_payment_succeeded: { from: 'past_due', to: 'active' },
}

/**
 * The status after an event. `current` is the status of the workspace's live subscription,
 * null when there is none. `cancelled` and `expired` never change: a later purchase is a new
 * subscription with its own anchor, so its first payment comes with `current` null.
 * Throws a conflict for every other combination, `trial` included.
 */
export function nextSubscriptionStatus(
  current: SubscriptionStatus | null,
  event: SubscriptionEvent,
): SubscriptionStatus {
  const transition = Object.hasOwn(transitions, event) ? transitions[event] : undefined
  if (transition === undefined || transition.from !== current) {
    throw conflict(`Subscription in status ${current ?? 'none'} cannot handle ${event}`)
  }
  return transition.to
}

/** One of the statuses the partial unique index covers; null — no subscription at all. */
export function isLiveSubscription(status: SubscriptionStatus | null): boolean {
  return status !== null && liveSubscriptionStatuses.includes(status)
}

/**
 * Whether the customer may queue new tasks: only while the tariff is paid. Not in `past_due`,
 * not after the subscription ended, and not in `trial`, which has no rules yet.
 */
export function subscriptionAllowsTasks(status: SubscriptionStatus | null): boolean {
  return status === 'active'
}
