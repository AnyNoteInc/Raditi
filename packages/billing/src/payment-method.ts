import { randomUUID } from 'node:crypto'

import { findPersonalWorkspace, type PrismaClient } from '@repo/db'
import {
  billingAutoRenewalUnavailable,
  billingNoLiveSubscription,
  billingNothingToChange,
  isLiveSubscription,
  liveSubscriptionStatuses,
  type SubscriptionStatus,
} from '@repo/domain'
import {
  YookassaApiError,
  YookassaError,
  type CreatePaymentMethodInput,
  type SavedPaymentMethod,
  type YookassaClient,
} from '@repo/yookassa'
import { z } from 'zod'

import type { BillingTx } from './accounts.ts'
import { writeBillingAudit } from './audit.ts'
import { confirmationUrlOf, paymentsUnavailable } from './checkout.ts'
import type { BillingDeps } from './deps.ts'
import {
  paymentMethodChangeSchema,
  paymentMethodSyncSchema,
  paymentMethodUnlinkSchema,
  renewalChargeStates,
  type PaymentMethodBindingState,
  type PaymentMethodChangeDto,
  type PaymentMethodSyncDto,
  type PaymentMethodUnlinkDto,
  type RenewalChargeState,
} from './dto.ts'
import { getPlanOverview } from './read-models.ts'
import { renewalChargeUnderWay } from './renewal-order.ts'
import { methodColumns } from './settlement.ts'

// The saved payment method of a subscription outside a payment: the customer replaces the
// method their tariff is renewed with, binds one to a tariff that has none, or unlinks it.
// A method is bound on a ЮKassa page where nothing is charged (POST /payment_methods). As with
// a payment, the notification and the customer's return are only reasons to look: the method
// is read back through the API, and that answer alone changes the subscription — once, under
// the lock of its row, and only for the binding the subscription waits for
// (`pending_payment_method_id`).
//
// Binding a method is not a consent to auto-renewal: `cancel_at_period_end` stays as it is. A
// tariff that renews goes on renewing with the new method, after a notice that names it; one
// that does not renew has a saved method and still ends with its period. One binding is the
// exception: the one a customer without a saved method starts by «Включить автопродление»
// (`resumeAutoRenew`). Its start is recorded as such, and when that very method is stored,
// auto-renewal is switched on in the same transaction — never before the method is saved.
//
// A renewal charge that was started before the method changed is not stopped and not returned:
// its request carries the method it was started with, and a payment that succeeds renews the
// tariff. The order of a charge is made under the lock of the subscription row, so an unlink
// and the storing of a bound method see it there, record it in their audit entry and tell the
// customer at once (`RenewalChargeState`).

/** audit_log actions of the saved payment method; the target is the subscription. */
export const paymentMethodAuditActions = {
  /** The customer left for the ЮKassa page to bind a method. */
  bindStart: 'billing.payment_method.bind_start',
  /** A bound method became the saved method of the subscription. */
  bound: 'billing.payment_method.bound',
  /** A binding ended without a saved method: the customer refused, or nobody can confirm it. */
  bindFailed: 'billing.payment_method.bind_failed',
  /** The customer unlinked the saved method: nothing is charged by itself any more. */
  unlink: 'billing.payment_method.unlink',
} as const

/**
 * audit_log action of auto-renewal switched on by the customer: at once, with a saved method
 * (`resumeAutoRenew`), or here, when the card they bound for it is stored. The customer's other
 * changes of a tariff are listed in `subscriptionChangeAuditActions`.
 */
export const AUTO_RENEWAL_RESUME_ACTION = 'billing.auto_renewal.resume'

/** Why a binding ended without a saved method: `meta.reason` of the entry. */
export const bindFailureReasons = {
  /** ЮKassa reports the method as `inactive`: the customer refused, or the page expired. */
  inactive: 'inactive',
  /** ЮKassa does not know the method (another shop, a stand that was restarted). */
  unknownToShop: 'unknown_to_shop',
} as const
type BindFailureReason = (typeof bindFailureReasons)[keyof typeof bindFailureReasons]

/** What a binding is read back with: the database, the clock and the shop's read. */
export type PaymentMethodSettlementDeps = Pick<BillingDeps, 'prisma' | 'now'> & {
  yookassa: Pick<YookassaClient, 'getPaymentMethod'>
}

/** What binding a payment method works with. A whole `YookassaClient` fits. */
export type PaymentMethodDeps = Pick<
  BillingDeps,
  'prisma' | 'appUrl' | 'appEnv' | 'autopayments' | 'now'
> & {
  yookassa: Pick<YookassaClient, 'createPaymentMethod' | 'getPaymentMethod'>
}

/** Where a binding stands after its method was read back on a notification. */
export type PaymentMethodSettlement =
  | {
      /** No live subscription waits for this method: it is not ours, or it was settled before. */
      state: 'unknown'
    }
  | { state: 'pending' | 'inactive'; subscriptionId: string }
  | {
      state: 'active'
      subscriptionId: string
      /** The renewal charge the method came too late for; `none` when there is none. */
      renewalCharge: RenewalChargeState
    }

const userInputSchema = z.strictObject({ userId: z.uuid() })
const settleInputSchema = z.strictObject({ paymentMethodId: z.string().min(1) })

const SYSTEM_ACTOR = { type: 'system', id: 'billing' } as const

/** Where ЮKassa sends the customer after the binding page, whatever its outcome. */
export const paymentMethodReturnUrl = (appUrl: string) =>
  `${appUrl}/settings/billing/return?method=1`

interface LiveSubscription {
  id: string
  workspaceId: string
  currentPeriodEnd: Date
  paymentMethodId: string | null
  pendingPaymentMethodId: string | null
}

/**
 * The live subscription of the workspace. The status belongs to the key: the unique index on
 * workspace_id covers live rows only.
 */
function liveSubscriptionOf(
  db: Pick<PrismaClient, 'subscription'>,
  workspaceId: string,
): Promise<LiveSubscription | null> {
  return db.subscription.findFirst({
    where: { workspaceId, status: { in: [...liveSubscriptionStatuses] } },
    select: {
      id: true,
      workspaceId: true,
      currentPeriodEnd: true,
      paymentMethodId: true,
      pendingPaymentMethodId: true,
    },
  })
}

interface LockedSubscription {
  id: string
  workspaceId: string
  status: SubscriptionStatus
  planId: string
  nextPlanId: string | null
  currentPeriodEnd: Date
  cancelAtPeriodEnd: boolean
  cancelledAt: Date | null
  paymentMethodId: string | null
  pendingPaymentMethodId: string | null
}

/**
 * The subscription, locked until the transaction ends: a renewal, another settlement of the
 * same binding and an unlink wait here. Undefined when the row is gone.
 */
async function lockSubscription(
  tx: Pick<BillingTx, '$queryRaw'>,
  subscriptionId: string,
): Promise<LockedSubscription | undefined> {
  const [row] = await tx.$queryRaw<LockedSubscription[]>`
    SELECT id, workspace_id AS "workspaceId", status::text AS status, plan_id AS "planId",
      next_plan_id AS "nextPlanId", current_period_end AS "currentPeriodEnd",
      cancel_at_period_end AS "cancelAtPeriodEnd", cancelled_at AS "cancelledAt",
      payment_method_id AS "paymentMethodId",
      pending_payment_method_id AS "pendingPaymentMethodId"
    FROM subscriptions WHERE id = ${subscriptionId}::uuid
    FOR NO KEY UPDATE
  `
  return row
}

/** One repeat with the same key after a failure whose outcome is unknown. */
async function createBinding(
  yookassa: Pick<YookassaClient, 'createPaymentMethod'>,
  request: CreatePaymentMethodInput,
  idempotenceKey: string,
): Promise<SavedPaymentMethod> {
  try {
    return await yookassa.createPaymentMethod(request, idempotenceKey)
  } catch (error) {
    if (!(error instanceof YookassaError) || !error.retryable) throw error
    return yookassa.createPaymentMethod(request, idempotenceKey)
  }
}

/**
 * Starts binding a bank card to the live subscription of the user's personal workspace and
 * returns the ЮKassa page to send the customer to. Nothing is charged there. The method that
 * page saves replaces the saved one, or becomes the first, when it is read back as bound
 * (`settlePaymentMethod`, `syncPaymentMethod`); until then the subscription only remembers which
 * binding it waits for. A binding started again takes the place of the one before it: only the
 * page of the latest can change the method.
 *
 * Refused with BILLING_AUTO_RENEWAL_UNAVAILABLE (the shop takes one-time payments only,
 * `autopayments` off: it binds no method, and it is not asked), BILLING_NO_LIVE_SUBSCRIPTION (no
 * workspace, or no tariff in trial, active or past_due) and BILLING_PAYMENTS_NOT_CONFIGURED (the
 * shop did not take the request or gave no page; nothing changed).
 */
export async function startPaymentMethodChange(
  deps: PaymentMethodDeps,
  input: { userId: string },
): Promise<PaymentMethodChangeDto> {
  const { userId } = userInputSchema.parse(input)
  return startBinding(deps, { userId, resumeAutoRenewal: false })
}

/**
 * `startPaymentMethodChange` with the reason the customer binds a card for. `resumeAutoRenewal`:
 * they pressed «Включить автопродление» without a saved method — the start is recorded as such,
 * and storing this very method switches auto-renewal on (`storeBound`). The caller has checked
 * that the tariff is paid for and does not renew.
 */
export async function startBinding(
  deps: PaymentMethodDeps,
  { userId, resumeAutoRenewal }: { userId: string; resumeAutoRenewal: boolean },
): Promise<PaymentMethodChangeDto> {
  const { prisma, yookassa, appUrl, appEnv } = deps
  // Before anything is read: a shop without autopayments binds nothing, whatever the tariff.
  if (!deps.autopayments) throw billingAutoRenewalUnavailable()
  const workspace = await findPersonalWorkspace(prisma, { userId, appEnv })
  const subscription = workspace === null ? null : await liveSubscriptionOf(prisma, workspace.id)
  if (subscription === null) throw billingNoLiveSubscription()

  const returnUrl = paymentMethodReturnUrl(appUrl)
  let method: SavedPaymentMethod
  try {
    method = await createBinding(
      yookassa,
      {
        type: 'bank_card',
        confirmation: { type: 'redirect', return_url: returnUrl },
        metadata: { subscription_id: subscription.id },
      },
      // Every start is a binding of its own: nothing is repeated under this key but the
      // request itself.
      randomUUID(),
    )
  } catch (error) {
    if (!(error instanceof YookassaError)) throw error
    throw paymentsUnavailable(error)
  }
  // Bound at once, without a page: the customer goes straight to the page that reads it back.
  const confirmationUrl = method.status === 'active' ? returnUrl : confirmationUrlOf(method)
  // subscriptions.pending_payment_method_id is varchar(64); an id of ЮKassa has 36 characters.
  if (method.status === 'inactive' || confirmationUrl === null || method.id.length > 64) {
    throw paymentsUnavailable()
  }

  await prisma.$transaction(
    async (tx) => {
      const stored = await tx.subscription.updateMany({
        where: { id: subscription.id, status: { in: [...liveSubscriptionStatuses] } },
        data: { pendingPaymentMethodId: method.id },
      })
      // The tariff ended while the shop was being asked: there is nothing to bind to.
      if (stored.count === 0) throw billingNoLiveSubscription()
      await writeBillingAudit(tx, {
        actor: { type: 'user', id: userId },
        workspaceId: subscription.workspaceId,
        action: paymentMethodAuditActions.bindStart,
        target: { type: 'subscription', id: subscription.id },
        meta: {
          paymentMethodId: method.id,
          replaces: subscription.paymentMethodId !== null,
          // The consent to auto-renewal, given before the card: storing this method keeps it.
          ...(resumeAutoRenewal ? { resumeAutoRenewal: true } : {}),
        },
      })
    },
    { isolationLevel: 'ReadCommitted' },
  )
  return paymentMethodChangeSchema.parse({ confirmationUrl } satisfies PaymentMethodChangeDto)
}

/** A binding a subscription waits for, and who looks at it: a user, or the platform. */
interface Binding {
  subscriptionId: string
  paymentMethodId: string
  userId?: string
}

/**
 * How a look at a binding ended. `superseded`: the subscription no longer waits for this
 * method — another binding took its place, the method was unlinked or the tariff ended.
 */
type BindingOutcome = 'pending' | 'active' | 'inactive' | 'superseded'

/** A look at a binding: how it ended, and the renewal charge a stored method came too late for. */
interface BindingLook {
  outcome: BindingOutcome
  /** Anything but `none` only with `active`. */
  renewalCharge: RenewalChargeState
}

const looked = (outcome: BindingOutcome): BindingLook => ({ outcome, renewalCharge: 'none' })

const actorOf = ({ userId }: Binding) =>
  userId === undefined ? SYSTEM_ACTOR : ({ type: 'user', id: userId } as const)

/**
 * Reads the method of a binding back and applies what ЮKassa says of it. Only `active` with
 * `saved` makes it the method of the subscription; `inactive`, and a method the shop does not
 * know, end the binding; anything else changes nothing. Throws whatever the read threw, except
 * «no such method».
 */
async function settleBinding(
  deps: PaymentMethodSettlementDeps,
  binding: Binding,
): Promise<BindingLook> {
  let method: SavedPaymentMethod
  try {
    method = await deps.yookassa.getPaymentMethod(binding.paymentMethodId)
  } catch (error) {
    if (!(error instanceof YookassaApiError && error.status === 404)) throw error
    // Nobody can confirm this binding or learn what became of it: without an end it would be
    // waited for on every look.
    return looked(await endBinding(deps.prisma, binding, bindFailureReasons.unknownToShop))
  }
  // An answer about another method says nothing of this one.
  if (method.id !== binding.paymentMethodId) return looked('pending')
  if (method.status === 'inactive') {
    return looked(await endBinding(deps.prisma, binding, bindFailureReasons.inactive))
  }
  if (method.status === 'active' && method.saved) return storeBound(deps.prisma, binding, method)
  return looked('pending')
}

/**
 * The bound method becomes the saved method of the subscription — if the subscription is live
 * and still waits for exactly this method; the loser of a race finds it stored and writes
 * nothing. The notice of the coming charge is void with the method it named: the mark is
 * cleared, and the next charge is announced again.
 *
 * Unless the charge of the period is already at the bank (`at_bank`): its payment was made with
 * the method saved before and nothing more can be charged for the period, so there is no charge
 * left to announce and the mark stays — a succeeded payment clears it with the period. A charge
 * without an answer may still be repeated, with the new method: that one is announced again.
 * Either way the entry records the charge the method came too late for, and the period it pays
 * for.
 */
function storeBound(
  prisma: PrismaClient,
  binding: Binding,
  method: SavedPaymentMethod,
): Promise<BindingLook> {
  return prisma.$transaction(
    async (tx) => {
      const subscription = await lockSubscription(tx, binding.subscriptionId)
      if (subscription === undefined || !isLiveSubscription(subscription.status)) {
        return looked('superseded')
      }
      if (subscription.pendingPaymentMethodId !== method.id) {
        if (subscription.paymentMethodId !== method.id) return looked('superseded')
        // Stored a moment ago by whoever won the race: what that one recorded is told here too.
        const { renewalCharge } = await latestBinding(tx, subscription)
        return { outcome: 'active', renewalCharge }
      }
      // Under the lock every charge that was started is seen.
      const renewalCharge = await renewalChargeUnderWay(tx, subscription)
      const columns = methodColumns(method)
      // The customer asked for auto-renewal and was sent to bind this card for it. Only a
      // tariff that is paid for and still does not renew is switched on.
      const resumedBy =
        subscription.status === 'active' && subscription.cancelAtPeriodEnd
          ? await resumeRequestedWith(tx, subscription.id, method.id)
          : null
      await tx.subscription.update({
        where: { id: subscription.id },
        data: {
          ...columns,
          pendingPaymentMethodId: null,
          ...(renewalCharge === 'at_bank' ? {} : { renewalNoticePeriodEnd: null }),
          ...(resumedBy === null ? {} : { cancelAtPeriodEnd: false, cancelledAt: null }),
        },
      })
      await writeBillingAudit(tx, {
        actor: actorOf(binding),
        workspaceId: subscription.workspaceId,
        action: paymentMethodAuditActions.bound,
        target: { type: 'subscription', id: subscription.id },
        meta: {
          paymentMethodId: method.id,
          replaced: subscription.paymentMethodId !== null,
          type: columns.paymentMethodType,
          cardType: columns.paymentMethodCardType,
          last4: columns.paymentMethodLast4,
          // Binding does not decide it: the method is charged only while auto-renewal is on —
          // as it was, or as the customer asked when starting this binding.
          autoRenewal: !subscription.cancelAtPeriodEnd || resumedBy !== null,
          renewalCharge,
          periodEnd: subscription.currentPeriodEnd.toISOString(),
        } satisfies BoundMeta & Record<string, unknown>,
      })
      if (resumedBy !== null) {
        const coming = await tx.plan.findUnique({
          where: { id: subscription.nextPlanId ?? subscription.planId },
          select: { slug: true, price: true },
        })
        await writeBillingAudit(tx, {
          // The customer's own word, whoever read the method back.
          actor: resumedBy,
          workspaceId: subscription.workspaceId,
          action: AUTO_RENEWAL_RESUME_ACTION,
          target: { type: 'subscription', id: subscription.id },
          meta: {
            via: 'binding',
            paymentMethodId: method.id,
            planSlug: coming?.slug ?? null,
            amount: coming?.price.toFixed(2) ?? null,
            periodEnd: subscription.currentPeriodEnd.toISOString(),
            renewalCharge,
          },
        })
      }
      return { outcome: 'active', renewalCharge }
    },
    { isolationLevel: 'ReadCommitted' },
  )
}

/** What a `bound` entry tells of the renewal charge its method came too late for. */
const boundMetaSchema = z.object({
  renewalCharge: z.enum(renewalChargeStates),
  /** The end of the period the subscription stood in: the period that charge pays for. */
  periodEnd: z.iso.datetime(),
})
type BoundMeta = z.infer<typeof boundMetaSchema>

/**
 * Who asked for auto-renewal when starting the binding of this method, or null when the binding
 * was started for the card alone. Told by the `bind_start` entry of the method, which is written
 * with `pending_payment_method_id` itself: the consent is kept where the binding is.
 */
async function resumeRequestedWith(
  db: Pick<BillingTx, 'auditLog'>,
  subscriptionId: string,
  paymentMethodId: string,
): Promise<{ type: 'user'; id: string } | typeof SYSTEM_ACTOR | null> {
  const start = await db.auditLog.findFirst({
    where: {
      action: paymentMethodAuditActions.bindStart,
      targetType: 'subscription',
      targetId: subscriptionId,
      meta: { path: ['paymentMethodId'], equals: paymentMethodId },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { actorType: true, actorId: true, meta: true },
  })
  const asked = z.object({ resumeAutoRenewal: z.literal(true) }).safeParse(start?.meta)
  if (start === null || !asked.success) return null
  return start.actorType === 'user' && start.actorId !== null
    ? { type: 'user', id: start.actorId }
    : SYSTEM_ACTOR
}

/**
 * The renewal charge the latest bound method of the subscription came too late for, for as long
 * as that is true: the subscription stands in the period the entry names and the charge of
 * that period still has no outcome. A period has one renewal order, so a pending one is the
 * charge the entry saw. What the entry said is told as it was said: a charge that had no answer
 * then may have been repeated with the new method since. An entry written before the charge was
 * recorded tells nothing.
 */
async function chargeBoundBeside(
  db: Pick<BillingTx, 'order'>,
  subscription: Pick<LiveSubscription, 'id' | 'currentPeriodEnd'>,
  meta: unknown,
): Promise<RenewalChargeState> {
  const said = boundMetaSchema.safeParse(meta)
  if (!said.success || said.data.renewalCharge === 'none') return 'none'
  if (said.data.periodEnd !== subscription.currentPeriodEnd.toISOString()) return 'none'
  return (await renewalChargeUnderWay(db, subscription)) === 'none'
    ? 'none'
    : said.data.renewalCharge
}

/** The binding ended without a method: the subscription stops waiting for it, once. */
function endBinding(
  prisma: PrismaClient,
  binding: Binding,
  reason: BindFailureReason,
): Promise<BindingOutcome> {
  return prisma.$transaction(
    async (tx) => {
      const subscription = await lockSubscription(tx, binding.subscriptionId)
      if (subscription?.pendingPaymentMethodId !== binding.paymentMethodId) return 'superseded'
      await tx.subscription.update({
        where: { id: subscription.id },
        data: { pendingPaymentMethodId: null },
      })
      await writeBillingAudit(tx, {
        actor: actorOf(binding),
        workspaceId: subscription.workspaceId,
        action: paymentMethodAuditActions.bindFailed,
        target: { type: 'subscription', id: subscription.id },
        meta: { paymentMethodId: binding.paymentMethodId, reason },
      })
      return 'inactive'
    },
    { isolationLevel: 'ReadCommitted' },
  )
}

/**
 * Reads the bound method back and applies its outcome to the subscription that waits for it:
 * what a `payment_method.active` notification leads to. The id is all a notification is
 * trusted with. Safe to call any number of times and at once. `unknown` when no live
 * subscription waits for the method, which is not an error. Throws whatever the API call
 * threw: the caller decides whether to ask again.
 */
export async function settlePaymentMethod(
  deps: PaymentMethodSettlementDeps,
  input: { paymentMethodId: string },
): Promise<PaymentMethodSettlement> {
  const { paymentMethodId } = settleInputSchema.parse(input)
  // subscriptions.pending_payment_method_id is varchar(64): a longer id is not a method of ours.
  if (paymentMethodId.length > 64) return { state: 'unknown' }
  const subscription = await deps.prisma.subscription.findFirst({
    where: {
      pendingPaymentMethodId: paymentMethodId,
      status: { in: [...liveSubscriptionStatuses] },
    },
    select: { id: true },
  })
  if (subscription === null) return { state: 'unknown' }
  const subscriptionId = subscription.id
  const { outcome, renewalCharge } = await settleBinding(deps, { subscriptionId, paymentMethodId })
  if (outcome === 'superseded') return { state: 'unknown' }
  return outcome === 'active'
    ? { state: outcome, subscriptionId, renewalCharge }
    : { state: outcome, subscriptionId }
}

/**
 * How the latest binding of the subscription ended, when it waits for none: told by its audit
 * entries, which are written with the change itself. The notification usually settles a
 * binding before the customer is back, and the return page still has to say what became of it
 * — and of the renewal charge the bound method came too late for, while that charge is still
 * under way. An unlink after it, or no binding at all, tells nothing.
 */
async function latestBinding(
  db: Pick<BillingTx, 'auditLog' | 'order'>,
  subscription: Pick<LiveSubscription, 'id' | 'currentPeriodEnd' | 'paymentMethodId'>,
): Promise<{ state: PaymentMethodBindingState; renewalCharge: RenewalChargeState }> {
  const { bound, bindFailed, unlink } = paymentMethodAuditActions
  const entry = await db.auditLog.findFirst({
    where: {
      targetType: 'subscription',
      targetId: subscription.id,
      action: { in: [bound, bindFailed, unlink] },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { action: true, meta: true },
  })
  if (entry?.action === bound && subscription.paymentMethodId !== null) {
    return {
      state: 'active',
      renewalCharge: await chargeBoundBeside(db, subscription, entry.meta),
    }
  }
  return { state: entry?.action === bindFailed ? 'inactive' : 'none', renewalCharge: 'none' }
}

/**
 * The binding of the user's subscription as its return page shows it. Reads the method the
 * subscription waits for back first, so the page works when the notification is late or never
 * comes; while ЮKassa cannot be reached the binding is shown as `pending` and the page asks
 * again. A binding that was settled before the customer came back is told by its outcome.
 * `none` for a user without a live tariff and for a tariff nothing was bound to. With `active`
 * comes the renewal charge the method came too late for, while it is under way: the page must
 * not promise the new method for a charge that left with the one before it.
 */
export async function syncPaymentMethod(
  deps: Pick<PaymentMethodDeps, 'prisma' | 'appEnv' | 'now' | 'yookassa'>,
  input: { userId: string },
): Promise<PaymentMethodSyncDto> {
  const { userId } = userInputSchema.parse(input)
  const { prisma, appEnv } = deps
  const workspace = await findPersonalWorkspace(prisma, { userId, appEnv })
  const subscription = workspace === null ? null : await liveSubscriptionOf(prisma, workspace.id)
  if (workspace === null || subscription === null) {
    return { state: 'none', renewalCharge: 'none', subscription: null }
  }

  let state: PaymentMethodBindingState
  let renewalCharge: RenewalChargeState
  const paymentMethodId = subscription.pendingPaymentMethodId
  if (paymentMethodId === null) {
    ;({ state, renewalCharge } = await latestBinding(prisma, subscription))
  } else {
    let look: BindingLook
    try {
      look = await settleBinding(deps, {
        subscriptionId: subscription.id,
        paymentMethodId,
        userId,
      })
    } catch (error) {
      if (!(error instanceof YookassaError) || !error.retryable) throw error
      // An outage of ЮKassa, which is not the customer's failure: the next look reads the method.
      look = looked('pending')
    }
    // What took the place of this binding is seen by the next look.
    state = look.outcome === 'superseded' ? 'pending' : look.outcome
    renewalCharge = look.renewalCharge
  }
  const overview = await getPlanOverview(prisma, workspace.id)
  return paymentMethodSyncSchema.parse({
    state,
    renewalCharge,
    subscription: overview.subscription,
  } satisfies PaymentMethodSyncDto)
}

/**
 * Unlinks the saved payment method of the user's subscription: every column that describes it
 * is cleared, a binding under way is forgotten, and auto-renewal is off — the tariff works to
 * the end of its period and no charge is started for it any more. ЮKassa has no call that
 * deletes a saved method: we stop using its id. Needs no shop, so it works while payments are
 * off.
 *
 * A renewal charge that was started before is not stopped, and unlinking does not wait for it:
 * the answer says where that charge stands, so that the customer is told at once. With a
 * payment (`at_bank`) it renews the tariff if the payment succeeds. Without one (`unanswered`)
 * the request has left or is leaving, and an answer that arrives is applied the same way. When
 * none arrives, the request is not repeated — auto-renewal is off. A notification about its
 * payment still finds the order, which holds no payment id, by the payment's own metadata, and
 * settles it (`settleOrderByPaymentId`). Without one `settleStuckOrders` fails the order as
 * `unknown_result` once a repeat is no longer safe, with an entry for an operator, who looks
 * the payment up in the shop and returns the money if it was taken. Until then the tariff does
 * not end.
 *
 * Refused with BILLING_NO_LIVE_SUBSCRIPTION (no workspace, or no live tariff) and
 * BILLING_NOTHING_TO_CHANGE (no method is saved).
 */
export async function unlinkPaymentMethod(
  deps: Pick<BillingDeps, 'prisma' | 'appEnv' | 'now'>,
  input: { userId: string },
): Promise<PaymentMethodUnlinkDto> {
  const { userId } = userInputSchema.parse(input)
  const { prisma, appEnv } = deps
  const workspace = await findPersonalWorkspace(prisma, { userId, appEnv })
  const found = workspace === null ? null : await liveSubscriptionOf(prisma, workspace.id)
  if (found === null) throw billingNoLiveSubscription()
  const now = deps.now?.() ?? new Date()

  const renewalCharge = await prisma.$transaction(
    async (tx) => {
      const subscription = await lockSubscription(tx, found.id)
      if (subscription === undefined || !isLiveSubscription(subscription.status)) {
        throw billingNoLiveSubscription()
      }
      const { paymentMethodId } = subscription
      if (paymentMethodId === null) throw billingNothingToChange()
      // Under the lock every charge that was started is seen.
      const underWay = await renewalChargeUnderWay(tx, subscription)
      // `cancelled_at` is the moment auto-renewal was switched off: one that is already
      // recorded stays.
      const alreadyOff = subscription.cancelAtPeriodEnd && subscription.cancelledAt !== null
      await tx.subscription.update({
        where: { id: subscription.id },
        data: {
          paymentMethodId: null,
          paymentMethodTitle: null,
          paymentMethodType: null,
          paymentMethodCardType: null,
          paymentMethodLast4: null,
          pendingPaymentMethodId: null,
          cancelAtPeriodEnd: true,
          cancelledAt: alreadyOff ? subscription.cancelledAt : now,
          // A notice that named this method announces nothing any more.
          renewalNoticePeriodEnd: null,
        },
      })
      await writeBillingAudit(tx, {
        actor: { type: 'user', id: userId },
        workspaceId: subscription.workspaceId,
        action: paymentMethodAuditActions.unlink,
        target: { type: 'subscription', id: subscription.id },
        meta: {
          paymentMethodId,
          autoRenewalWasOn: !subscription.cancelAtPeriodEnd,
          periodEnd: subscription.currentPeriodEnd.toISOString(),
          renewalCharge: underWay,
        },
      })
      return underWay
    },
    { isolationLevel: 'ReadCommitted' },
  )
  return paymentMethodUnlinkSchema.parse({ renewalCharge } satisfies PaymentMethodUnlinkDto)
}
