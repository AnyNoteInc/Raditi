import { findPersonalWorkspace, lockUserRow, type PrismaClient } from '@repo/db'
import {
  billingAlreadyOnPlan,
  billingAutoRenewalUnavailable,
  billingNoLiveSubscription,
  billingNothingToChange,
  billingPaymentInProgress,
  billingPlanNotFound,
  billingPlanSiteLimit,
  billingSubscriptionPastDue,
  conflict,
  liveSubscriptionStatuses,
  type SubscriptionStatus,
} from '@repo/domain'
import { z } from 'zod'

import type { BillingTx } from './accounts.ts'
import { writeBillingAudit } from './audit.ts'
import { switchAutoRenewalOff } from './auto-renewal.ts'
import type { BillingDeps } from './deps.ts'
import {
  autoRenewalCancelSchema,
  autoRenewalResumeSchema,
  planChangeRequestSchema,
  type AutoRenewalCancelDto,
  type AutoRenewalResumeDto,
  type SubscriptionOverviewDto,
} from './dto.ts'
import {
  AUTO_RENEWAL_RESUME_ACTION,
  startBinding,
  type PaymentMethodDeps,
} from './payment-method.ts'
import { getPlanOverview } from './read-models.ts'
import { renewalChargeUnderWay } from './renewal-order.ts'

// What the customer changes about a tariff they have, on «Тарифы»: auto-renewal off and on, and
// the tariff of the next period. Every change is made under the lock of the subscription row
// and leaves an audit entry in the same transaction.
//
// A renewal is charged only for what its notice named (renewal.ts). Whatever changes the coming
// charge — another tariff, auto-renewal switched on again — clears the mark
// `renewal_notice_period_end`, so the next pass writes a letter with what is true now and the
// charge follows that letter.
//
// A charge that was started is neither stopped nor returned. The order of a charge is made
// under the lock of the subscription row, so every change sees it there: switching auto-renewal
// off tells the customer where that charge stands, and the tariff of the next period cannot be
// changed while it has no outcome — its amount was announced and sent for one tariff and must
// not be applied as another.

/** audit_log actions of the customer's changes; the target is the subscription. */
export const subscriptionChangeAuditActions = {
  /** The customer switched auto-renewal off: the tariff ends with its period. */
  autoRenewalCancel: 'billing.auto_renewal.cancel',
  /**
   * Auto-renewal is on again, by the customer's word: at once with a saved method, or when the
   * card they bound for it was read back as saved.
   */
  autoRenewalResume: AUTO_RENEWAL_RESUME_ACTION,
  /** The customer chose another tariff for the next period. */
  planChangeSchedule: 'billing.plan_change.schedule',
  /** The customer took that choice back: the tariff they have renews. */
  planChangeCancel: 'billing.plan_change.cancel',
} as const

const userInputSchema = z.strictObject({ userId: z.uuid() })
const planChangeInputSchema = z.strictObject({
  userId: z.uuid(),
  ...planChangeRequestSchema.shape,
})

type ChangeDeps = Pick<BillingDeps, 'prisma' | 'appEnv' | 'now'>

/**
 * The live subscription of the user's personal workspace. The status belongs to the key: the
 * unique index on workspace_id covers live rows only. BILLING_NO_LIVE_SUBSCRIPTION without one.
 */
async function liveSubscriptionOf(
  { prisma, appEnv }: Pick<ChangeDeps, 'prisma' | 'appEnv'>,
  userId: string,
) {
  const workspace = await findPersonalWorkspace(prisma, { userId, appEnv })
  const found =
    workspace === null
      ? null
      : await prisma.subscription.findFirst({
          where: { workspaceId: workspace.id, status: { in: [...liveSubscriptionStatuses] } },
          select: {
            id: true,
            workspaceId: true,
            status: true,
            cancelAtPeriodEnd: true,
            paymentMethodId: true,
          },
        })
  if (found === null) throw billingNoLiveSubscription()
  return found
}

interface LockedSubscription {
  id: string
  workspaceId: string
  status: SubscriptionStatus
  planId: string
  nextPlanId: string | null
  currentPeriodEnd: Date
  cancelAtPeriodEnd: boolean
  paymentMethodId: string | null
}

/**
 * The subscription, locked until the transaction ends: a renewal, a settlement and every other
 * change wait here. Only a tariff that is paid for or waits for its payment is changed:
 * BILLING_NO_LIVE_SUBSCRIPTION when the row is gone, over, or in `trial`, which has no rules.
 */
async function lockChangeable(
  tx: Pick<BillingTx, '$queryRaw'>,
  subscriptionId: string,
): Promise<LockedSubscription> {
  const [row] = await tx.$queryRaw<LockedSubscription[]>`
    SELECT id, workspace_id AS "workspaceId", status::text AS status, plan_id AS "planId",
      next_plan_id AS "nextPlanId", current_period_end AS "currentPeriodEnd",
      cancel_at_period_end AS "cancelAtPeriodEnd", payment_method_id AS "paymentMethodId"
    FROM subscriptions WHERE id = ${subscriptionId}::uuid
    FOR NO KEY UPDATE
  `
  if (row === undefined || (row.status !== 'active' && row.status !== 'past_due')) {
    throw billingNoLiveSubscription()
  }
  return row
}

/** plans.slug by id, as an audit entry names a tariff; null for no plan. */
async function planSlugOf(tx: Pick<BillingTx, 'plan'>, planId: string | null) {
  if (planId === null) return null
  const plan = await tx.plan.findUnique({ where: { id: planId }, select: { slug: true } })
  return plan?.slug ?? null
}

/** The tariff the next charge pays for, as an audit entry names it. */
async function comingCharge(
  tx: Pick<BillingTx, 'plan'>,
  subscription: Pick<LockedSubscription, 'planId' | 'nextPlanId'>,
): Promise<{ planSlug: string | null; amount: string | null }> {
  const plan = await tx.plan.findUnique({
    where: { id: subscription.nextPlanId ?? subscription.planId },
    select: { slug: true, price: true },
  })
  return { planSlug: plan?.slug ?? null, amount: plan?.price.toFixed(2) ?? null }
}

/**
 * Switches auto-renewal of the user's tariff off: it works to the end of its period and is not
 * charged again. The saved payment method stays, so auto-renewal can be switched back on. Needs
 * no shop, so it works while payments are off.
 *
 * A renewal charge that was started before is not stopped, and the switch does not wait for it:
 * the answer says where that charge stands, so that the customer is told at once (as after an
 * unlink, `unlinkPaymentMethod`).
 *
 * Refused with BILLING_NO_LIVE_SUBSCRIPTION (no workspace, or no live tariff) and
 * BILLING_NOTHING_TO_CHANGE (auto-renewal is already off).
 */
export async function cancelAutoRenew(
  deps: ChangeDeps,
  input: { userId: string },
): Promise<AutoRenewalCancelDto> {
  const { userId } = userInputSchema.parse(input)
  const found = await liveSubscriptionOf(deps, userId)
  const now = deps.now?.() ?? new Date()

  return deps.prisma.$transaction(
    async (tx) => {
      const stopped = await switchAutoRenewalOff(tx, { subscriptionId: found.id, now })
      // Under the lock the switch took, every charge that was started is seen.
      const renewalCharge = await renewalChargeUnderWay(tx, {
        id: stopped.subscriptionId,
        currentPeriodEnd: stopped.periodEnd,
      })
      await writeBillingAudit(tx, {
        actor: { type: 'user', id: userId },
        workspaceId: stopped.workspaceId,
        action: subscriptionChangeAuditActions.autoRenewalCancel,
        target: { type: 'subscription', id: stopped.subscriptionId },
        meta: {
          status: stopped.status,
          periodEnd: stopped.periodEnd.toISOString(),
          paymentMethodSaved: stopped.paymentMethodSaved,
          renewalCharge,
        },
      })
      return autoRenewalCancelSchema.parse({
        renewalCharge,
        periodEnd: stopped.periodEnd,
      } satisfies AutoRenewalCancelDto)
    },
    { isolationLevel: 'ReadCommitted' },
  )
}

/**
 * Switches auto-renewal of the user's tariff on. With a saved payment method it is on at once:
 * `cancel_at_period_end` and `cancelled_at` are cleared, and so is the notice mark — the coming
 * charge is announced before it is made. Unless the charge of the period is already at the bank:
 * nothing more can be charged for the period, so there is nothing left to announce and the mark
 * stays (as when a method is replaced, `storeBound`).
 *
 * Without a saved method nothing is switched on here: the binding of a card is started and the
 * answer carries the ЮKassa page to send the customer to. Auto-renewal is switched on when that
 * very binding is read back as saved (`settlePaymentMethod`, `syncPaymentMethod`) — a binding
 * the customer refuses, or another one started in its place on «Оплата», switches nothing on.
 *
 * Only for a tariff that is paid for: BILLING_SUBSCRIPTION_PAST_DUE while it waits for a payment
 * (that payment is made by hand and decides about the method itself). BILLING_NO_LIVE_SUBSCRIPTION
 * without a live tariff, BILLING_NOTHING_TO_CHANGE when auto-renewal is on already, and
 * BILLING_PAYMENTS_NOT_CONFIGURED when the shop gave no page to bind a card on.
 *
 * Refused before any of it with BILLING_AUTO_RENEWAL_UNAVAILABLE while the shop takes one-time
 * payments only (`autopayments` off) — with a saved method as well: a charge of it would be
 * refused by the shop. Nothing is read and the shop is not asked. Auto-renewal that is on
 * already is not touched by the switch: it stays on until the customer or an operator stops it.
 */
export async function resumeAutoRenew(
  deps: PaymentMethodDeps,
  input: { userId: string },
): Promise<AutoRenewalResumeDto> {
  const { userId } = userInputSchema.parse(input)
  if (!deps.autopayments) throw billingAutoRenewalUnavailable()
  const found = await liveSubscriptionOf(deps, userId)
  if (found.status !== 'active') {
    throw found.status === 'past_due' ? billingSubscriptionPastDue() : billingNoLiveSubscription()
  }
  if (!found.cancelAtPeriodEnd) throw billingNothingToChange()

  if (found.paymentMethodId === null) {
    const { confirmationUrl } = await startBinding(deps, { userId, resumeAutoRenewal: true })
    return autoRenewalResumeSchema.parse({
      needsPaymentMethod: true,
      confirmationUrl,
    } satisfies AutoRenewalResumeDto)
  }

  return deps.prisma.$transaction(
    async (tx) => {
      const subscription = await lockChangeable(tx, found.id)
      if (subscription.status !== 'active') throw billingSubscriptionPastDue()
      if (!subscription.cancelAtPeriodEnd) throw billingNothingToChange()
      // Unlinked while this request was on its way: the customer asks again and binds a card.
      if (subscription.paymentMethodId === null) {
        throw conflict('The payment method was unlinked while auto-renewal was being resumed')
      }
      const renewalCharge = await renewalChargeUnderWay(tx, subscription)
      await tx.subscription.update({
        where: { id: subscription.id },
        data: {
          cancelAtPeriodEnd: false,
          cancelledAt: null,
          ...(renewalCharge === 'at_bank' ? {} : { renewalNoticePeriodEnd: null }),
        },
      })
      await writeBillingAudit(tx, {
        actor: { type: 'user', id: userId },
        workspaceId: subscription.workspaceId,
        action: subscriptionChangeAuditActions.autoRenewalResume,
        target: { type: 'subscription', id: subscription.id },
        meta: {
          via: 'saved_method',
          paymentMethodId: subscription.paymentMethodId,
          // What the customer agreed to be charged for, as the page named it.
          ...(await comingCharge(tx, subscription)),
          periodEnd: subscription.currentPeriodEnd.toISOString(),
          renewalCharge,
        },
      })
      return autoRenewalResumeSchema.parse({
        needsPaymentMethod: false,
        renewalCharge,
      } satisfies AutoRenewalResumeDto)
    },
    { isolationLevel: 'ReadCommitted' },
  )
}

/** The subscription as «Тарифы» shows it after a change. */
async function overviewAfter(
  prisma: PrismaClient,
  workspaceId: string,
): Promise<SubscriptionOverviewDto> {
  const { subscription } = await getPlanOverview(prisma, workspaceId)
  // Ended between the change and this read: the page shows «no tariff» on its next look.
  if (subscription === null) throw billingNoLiveSubscription()
  return subscription
}

/**
 * Schedules another tariff for the next period of the user's subscription (default «б» of
 * docs/plan/37-billing-plan.md): nothing changes today and nothing is recalculated — the
 * renewal applies the scheduled tariff and charges its price; a payment made by hand for an
 * overdue tariff does the same. The notice mark is cleared: the letter before the charge has to
 * name the new amount. Works with auto-renewal off as well; the tariff then changes only if it
 * is renewed, which the page says. A second choice replaces the first.
 *
 * Refused with BILLING_PLAN_NOT_FOUND (no such tariff on sale), BILLING_NO_LIVE_SUBSCRIPTION,
 * BILLING_ALREADY_ON_PLAN (the tariff the subscription has, or already switches to: the choice
 * is taken back with `cancelPlanChange`), BILLING_PLAN_SITE_LIMIT (the workspace has more sites
 * than the tariff allows, default «м») and BILLING_PAYMENT_IN_PROGRESS (the renewal charge of
 * the period is under way).
 */
export async function schedulePlanChange(
  deps: ChangeDeps,
  input: { userId: string; planSlug: string },
): Promise<SubscriptionOverviewDto> {
  const { userId, planSlug } = planChangeInputSchema.parse(input)
  const { prisma } = deps
  const plan = await prisma.plan.findFirst({
    where: { slug: planSlug, kind: 'quota', isActive: true },
  })
  // What a renewal could not charge for is not offered: a tariff without a price. The quota and
  // the site limit of a quota plan are never null in the database; the types do not know it.
  if (
    plan === null ||
    plan.maxSites === null ||
    plan.creditsPerMonth === null ||
    !plan.price.greaterThan(0)
  ) {
    throw billingPlanNotFound()
  }
  const { maxSites } = plan
  const found = await liveSubscriptionOf(deps, userId)

  await prisma.$transaction(
    async (tx) => {
      // The user's first lock, as in project.create: a site added at this very moment is
      // counted either here or there.
      if (!(await lockUserRow(tx, userId))) throw billingNoLiveSubscription()
      const subscription = await lockChangeable(tx, found.id)
      if (plan.id === subscription.planId || plan.id === subscription.nextPlanId) {
        throw billingAlreadyOnPlan()
      }
      if ((await tx.site.count({ where: { workspaceId: subscription.workspaceId } })) > maxSites) {
        throw billingPlanSiteLimit()
      }
      if ((await renewalChargeUnderWay(tx, subscription)) !== 'none') {
        throw billingPaymentInProgress()
      }
      const current = await planSlugOf(tx, subscription.planId)
      const replaced = await planSlugOf(tx, subscription.nextPlanId)
      await tx.subscription.update({
        where: { id: subscription.id },
        data: { nextPlanId: plan.id, renewalNoticePeriodEnd: null },
      })
      await writeBillingAudit(tx, {
        actor: { type: 'user', id: userId },
        workspaceId: subscription.workspaceId,
        action: subscriptionChangeAuditActions.planChangeSchedule,
        target: { type: 'subscription', id: subscription.id },
        meta: {
          fromPlanSlug: current,
          toPlanSlug: plan.slug,
          // The choice this one took the place of.
          replacedPlanSlug: replaced,
          amount: plan.price.toFixed(2),
          status: subscription.status,
          periodEnd: subscription.currentPeriodEnd.toISOString(),
          autoRenewal: subscription.paymentMethodId !== null && !subscription.cancelAtPeriodEnd,
        },
      })
    },
    { isolationLevel: 'ReadCommitted' },
  )
  return overviewAfter(prisma, found.workspaceId)
}

/**
 * Takes the scheduled change of tariff back: the tariff the subscription has renews. The notice
 * mark is cleared, as when the change was scheduled: the letter has to name the amount again.
 *
 * Refused with BILLING_NO_LIVE_SUBSCRIPTION, BILLING_NOTHING_TO_CHANGE (no change is scheduled)
 * and BILLING_PAYMENT_IN_PROGRESS (the renewal charge of the period is under way: it was sent
 * for the scheduled tariff, and a payment that succeeds applies it).
 */
export async function cancelPlanChange(
  deps: ChangeDeps,
  input: { userId: string },
): Promise<SubscriptionOverviewDto> {
  const { userId } = userInputSchema.parse(input)
  const { prisma } = deps
  const found = await liveSubscriptionOf(deps, userId)

  await prisma.$transaction(
    async (tx) => {
      const subscription = await lockChangeable(tx, found.id)
      const { nextPlanId } = subscription
      if (nextPlanId === null) throw billingNothingToChange()
      if ((await renewalChargeUnderWay(tx, subscription)) !== 'none') {
        throw billingPaymentInProgress()
      }
      const current = await planSlugOf(tx, subscription.planId)
      const cancelled = await planSlugOf(tx, nextPlanId)
      await tx.subscription.update({
        where: { id: subscription.id },
        data: { nextPlanId: null, renewalNoticePeriodEnd: null },
      })
      await writeBillingAudit(tx, {
        actor: { type: 'user', id: userId },
        workspaceId: subscription.workspaceId,
        action: subscriptionChangeAuditActions.planChangeCancel,
        target: { type: 'subscription', id: subscription.id },
        meta: {
          planSlug: current,
          cancelledPlanSlug: cancelled,
          status: subscription.status,
          periodEnd: subscription.currentPeriodEnd.toISOString(),
        },
      })
    },
    { isolationLevel: 'ReadCommitted' },
  )
  return overviewAfter(prisma, found.workspaceId)
}
