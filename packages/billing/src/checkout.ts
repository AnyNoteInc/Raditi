import { randomUUID } from 'node:crypto'

import { findPersonalWorkspace, type Order, type PrismaClient } from '@repo/db'
import {
  billingAutoRenewalUnavailable,
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
  conflict,
  liveSubscriptionStatuses,
  subscriptionAllowsTasks,
  type DomainError,
  type SubscriptionStatus,
} from '@repo/domain'
import {
  YookassaApiError,
  YookassaError,
  type CreatePaymentInput,
  type Payment,
  type YookassaClient,
} from '@repo/yookassa'
import { z } from 'zod'

import type { BillingDeps } from './deps.ts'
import {
  checkoutRequestSchema,
  checkoutSchema,
  orderSyncSchema,
  type CheckoutDto,
  type OrderSyncDto,
} from './dto.ts'
import { orderFailureReasons, paymentFailureText } from './failure-text.ts'
import { ensurePersonalWorkspaceWithGift } from './personal-workspace.ts'
import { getPlanOverview } from './read-models.ts'
import { isRenewalOrder } from './renewal-order.ts'
import { settleOrderRow, storedSettlement, type SettledOrder } from './settlement.ts'

const startCheckoutInputSchema = z.strictObject({
  userId: z.uuid(),
  ...checkoutRequestSchema.shape,
})
export type StartCheckoutInput = z.infer<typeof startCheckoutInputSchema>

const startPackCheckoutInputSchema = z.strictObject({ userId: z.uuid() })
export type StartPackCheckoutInput = z.infer<typeof startPackCheckoutInputSchema>

const startPastDuePaymentInputSchema = z.strictObject({ userId: z.uuid() })
export type StartPastDuePaymentInput = z.infer<typeof startPastDuePaymentInputSchema>

const syncOrderInputSchema = z.strictObject({ userId: z.uuid(), orderId: z.uuid() })
export type SyncOrderInput = z.infer<typeof syncOrderInputSchema>

/** Where ЮKassa sends the customer after the payment page, whatever its outcome. */
export const checkoutReturnUrl = (appUrl: string, orderId: string) =>
  `${appUrl}/settings/billing/return?order=${orderId}`

// ЮKassa shows the description to the customer and takes at most 128 characters; plans.name
// is at most 100.
const paymentDescription = (planName: string) =>
  `Радити: тариф «${planName}» на месяц`.slice(0, 128)
// The name of a pack says what it is: «Пакет из 100 кредитов».
const packDescription = (packName: string) => `Радити: «${packName}»`.slice(0, 128)

// A checkout looks again after it settled or cancelled an unfinished order. Twice is enough
// for one customer; more means requests of the same user keep undoing each other.
const MAX_ROUNDS = 3

/** A failure of the shop the customer cannot fix: what went wrong stays in `cause`, for logs. */
export function paymentsUnavailable(cause?: unknown): DomainError {
  const error = billingPaymentsNotConfigured()
  if (cause !== undefined) error.cause = cause
  return error
}

/** The page to pay on — or to bind a payment method on —, when the object still has one. */
export function confirmationUrlOf(object: Pick<Payment, 'confirmation'> | null): string | null {
  const url = object?.confirmation?.confirmation_url
  if (url === undefined || !URL.canParse(url)) return null
  return /^https?:$/.test(new URL(url).protocol) ? url : null
}

/**
 * Starts the payment of a tariff for the user's personal workspace and returns the ЮKassa
 * page to send the customer to. The workspace is created when the user has none, so the first
 * site and the first payment end in the same one; the gift of the registration is granted in
 * the transaction that makes it (`ensurePersonalWorkspaceWithGift`) and stays, whatever becomes
 * of the payment.
 *
 * Refused with BILLING_AUTO_RENEWAL_UNAVAILABLE (the consent to auto-renewal while the shop takes
 * one-time payments only, `autopayments` off: nothing is read and the shop is not asked; the
 * same tariff is paid for without the consent), BILLING_PLAN_NOT_FOUND (no such tariff on
 * sale), BILLING_SUBSCRIPTION_EXISTS (a live subscription: the plan is changed, not bought
 * again), BILLING_PLAN_SITE_LIMIT (more sites than the plan allows), BILLING_PAYMENT_DECLINED
 * (ЮKassa cancelled the payment at once), BILLING_PAYMENT_IN_PROGRESS (the customer has
 * confirmed the previous payment and the bank has not answered yet) and
 * BILLING_PAYMENTS_NOT_CONFIGURED (the shop did not take the request or cannot be asked; nothing
 * was charged). CONFLICT: other requests of the same user kept changing the checkout.
 *
 * A workspace has one unfinished tariff order. One found here is settled first; while its
 * payment is still open the same choice gets the same page again, and another choice cancels
 * it and starts anew.
 */
export async function startCheckout(
  deps: BillingDeps,
  input: StartCheckoutInput,
): Promise<CheckoutDto> {
  const { userId, planSlug, autoRenew } = startCheckoutInputSchema.parse(input)
  const { prisma, appEnv } = deps
  // The consent would be a request to save the method, which this shop answers with 403.
  if (autoRenew && !deps.autopayments) throw billingAutoRenewalUnavailable()
  const plan = await prisma.plan.findFirst({
    where: { slug: planSlug, kind: 'quota', isActive: true },
  })
  // orders.amount is positive: a tariff that costs nothing is not sold through a payment.
  if (plan === null || plan.maxSites === null || !plan.price.greaterThan(0)) {
    throw billingPlanNotFound()
  }
  const { maxSites } = plan
  const description = paymentDescription(plan.name)

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const { order, created } = await prisma.$transaction(
      async (tx) => {
        // Takes the lock of the user's row: their checkouts and first site go one at a time.
        // The gift of the registration is granted here when the user has none yet: a checkout
        // may be what makes the workspace. A refusal below takes it back with the rest of the
        // transaction, and the next site or checkout grants it.
        const workspace = await ensurePersonalWorkspaceWithGift(tx, { userId, appEnv })
        const workspaceId = workspace.id
        // The unfinished order is read before the live subscription. A settlement takes the
        // order out of `pending` and starts the subscription in one commit, so whenever that
        // commit lands, these two reads see the order still pending or the subscription
        // already live — never neither, which would make a second order for a tariff that is on.
        const unfinished = await tx.order.findFirst({
          where: { workspaceId, kind: 'subscription', status: 'pending' },
        })
        const live = await tx.subscription.findFirst({
          where: { workspaceId, status: { in: [...liveSubscriptionStatuses] } },
          select: { id: true },
        })
        if (live !== null) throw billingSubscriptionExists()
        if ((await tx.site.count({ where: { workspaceId } })) > maxSites) {
          throw billingPlanSiteLimit()
        }
        if (unfinished !== null) return { order: unfinished, created: false }
        const order = await tx.order.create({
          data: {
            workspaceId,
            userId,
            kind: 'subscription',
            planId: plan.id,
            amount: plan.price,
            status: 'pending',
            idempotenceKey: randomUUID(),
            savePaymentMethod: autoRenew,
          },
        })
        return { order, created: true }
      },
      { isolationLevel: 'ReadCommitted' },
    )
    if (created) return requestPayment(deps, order, description)

    const sameChoice =
      // An order of a tariff that is over — its renewal, or a payment by hand that was started
      // while it waited for one — pays for that subscription and never starts a new one.
      order.subscriptionId === null &&
      order.planId === plan.id &&
      order.savePaymentMethod === autoRenew &&
      order.amount.equals(plan.price)
    if (order.yookassaPaymentId === null) {
      // Its checkout broke off before a payment was stored, so nobody holds a page to pay on.
      // The same choice asks ЮKassa again with the order's key and gets that payment, if one
      // was made, instead of a second one.
      if (sameChoice) return requestPayment(deps, order, description)
      await supersede(prisma, order.id)
      continue
    }
    const read = await readBack(deps, order)
    if (read === null) {
      // The shop does not know the payment (another shop, a fake that was restarted): there
      // is no page of ours to pay it on, and the order would block every checkout for good.
      await supersede(prisma, order.id)
      continue
    }
    const { settlement, payment } = read
    // Paid, failed or cancelled meanwhile: the order stands in nobody's way any more. A paid
    // order does not prove a live tariff — a payment by hand that came after its tariff had
    // ended stays paid with nothing applied —, so the next round reads the subscription
    // itself: a first payment that started the tariff is refused there, by the tariff.
    if (settlement.state !== 'pending') continue
    if (!sameChoice) {
      // The customer changed their mind. If the old page is paid after all, settlement asks
      // an operator to return the money.
      await supersede(prisma, order.id)
      continue
    }
    const confirmationUrl = confirmationUrlOf(payment)
    // No page left and no outcome yet: the customer has confirmed, the bank is working.
    if (confirmationUrl === null) throw billingPaymentInProgress()
    return checkoutSchema.parse({ orderId: order.id, confirmationUrl })
  }
  throw conflict('The checkout of the workspace was changed by other requests; try again')
}

/**
 * Starts the payment of the credit pack on sale for the user's personal workspace and returns
 * the ЮKassa page to send the customer to. The credits are granted when the payment is settled,
 * to the account of purchased credits, and do not expire with the period.
 *
 * A pack is sold on top of a tariff that takes tasks (default «з» of
 * docs/plan/37-billing-plan.md): refused with BILLING_PACK_NEEDS_SUBSCRIPTION for a user
 * without a workspace or a subscription, and while the tariff is overdue or over. A tariff that
 * ends after this check does not undo the order: a pack that is paid is granted all the same.
 * BILLING_PLAN_NOT_FOUND: no pack is on sale. BILLING_PAYMENT_DECLINED and
 * BILLING_PAYMENTS_NOT_CONFIGURED as in `startCheckout`.
 *
 * Every call makes an order and a payment of its own: a customer may buy several packs, so an
 * unfinished pack order is neither given out again nor cancelled. The payment never asks to
 * save the method.
 */
export async function startPackCheckout(
  deps: BillingDeps,
  input: StartPackCheckoutInput,
): Promise<CheckoutDto> {
  const { userId } = startPackCheckoutInputSchema.parse(input)
  const { prisma, appEnv } = deps
  // One pack is sold today. Should there be several, the first one in the order they are
  // shown is the pack of the page (`listPlans`).
  const pack = await prisma.plan.findFirst({
    where: { kind: 'pack', isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { slug: 'asc' }],
  })
  // orders.amount is positive: a pack that costs or holds nothing is not sold through a payment.
  if (pack === null || pack.packCredits === null || !pack.price.greaterThan(0)) {
    throw billingPlanNotFound()
  }

  // No workspace is made here: a user without one has no tariff either.
  const workspace = await findPersonalWorkspace(prisma, { userId, appEnv })
  if (workspace === null) throw billingPackNeedsSubscription()
  const live = await prisma.subscription.findFirst({
    where: { workspaceId: workspace.id, status: { in: [...liveSubscriptionStatuses] } },
    select: { status: true },
  })
  if (!subscriptionAllowsTasks(live?.status ?? null)) throw billingPackNeedsSubscription()

  const order = await prisma.order.create({
    data: {
      workspaceId: workspace.id,
      userId,
      kind: 'pack',
      planId: pack.id,
      amount: pack.price,
      status: 'pending',
      idempotenceKey: randomUUID(),
      savePaymentMethod: false,
    },
  })
  return requestPayment(deps, order, packDescription(pack.name))
}

interface OverdueSubscription {
  id: string
  status: SubscriptionStatus
  planId: string
  nextPlanId: string | null
  cancelAtPeriodEnd: boolean
}

/**
 * Starts the payment a customer makes by hand for a tariff whose renewal charge failed
 * («Оплатить сейчас») and returns the ЮKassa page to send them to. The order is a subscription
 * order of that subscription with a key of its own: for the tariff of the coming period — the
 * scheduled one when a change is scheduled — at its price of today. The payment saves its
 * method exactly when auto-renewal is on, as a first payment does — unless the shop takes
 * one-time payments only (`autopayments` off): then nothing is saved, the method saved before
 * stays, and a tariff that renews goes on renewing with it. What a paid order does to the
 * subscription is settlement's business (`settleOrder`): a new month from the moment of the
 * payment.
 *
 * A workspace has one unfinished tariff order. One found here is settled first; while its
 * payment is still open and the customer would pay the same — the tariff, the amount, the
 * consent — they get the same page again; otherwise it is cancelled and a new one made. An
 * order that turns out to be paid sends the customer to its own page, which says so.
 *
 * Refused with BILLING_NO_LIVE_SUBSCRIPTION (no workspace, or no live tariff),
 * BILLING_NOTHING_TO_CHANGE (the tariff is paid for: nothing is owed), BILLING_PLAN_NOT_FOUND
 * (the tariff cannot be charged for any more), and with BILLING_PAYMENT_DECLINED,
 * BILLING_PAYMENT_IN_PROGRESS, BILLING_PAYMENTS_NOT_CONFIGURED and a CONFLICT as `startCheckout`.
 */
export async function startPastDuePayment(
  deps: BillingDeps,
  input: StartPastDuePaymentInput,
): Promise<CheckoutDto> {
  const { userId } = startPastDuePaymentInputSchema.parse(input)
  const { prisma, appEnv, appUrl, autopayments } = deps
  // No workspace is made here: a user without one has no tariff either.
  const workspace = await findPersonalWorkspace(prisma, { userId, appEnv })
  if (workspace === null) throw billingNoLiveSubscription()
  const workspaceId = workspace.id

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const { order, created, subscriptionId, plan, saveMethod } = await prisma.$transaction(
      async (tx) => {
        // The subscription is locked before the unfinished order is read: a settlement that
        // pays that order holds this lock until it commits, so the two are seen as it left
        // them — the order pending and the tariff overdue, or neither. The end of the grace
        // (`endPeriods`) passes a locked row by.
        const [subscription] = await tx.$queryRaw<OverdueSubscription[]>`
          SELECT id, status::text AS status, plan_id AS "planId", next_plan_id AS "nextPlanId",
            cancel_at_period_end AS "cancelAtPeriodEnd"
          FROM subscriptions
          WHERE workspace_id = ${workspaceId}::uuid
            AND status::text = ANY(${[...liveSubscriptionStatuses]}::text[])
          FOR NO KEY UPDATE
        `
        if (subscription === undefined) throw billingNoLiveSubscription()
        if (subscription.status !== 'past_due') throw billingNothingToChange()
        const plan = await tx.plan.findUnique({
          where: { id: subscription.nextPlanId ?? subscription.planId },
        })
        // A plan taken off sale is still paid for by those who have it; one that has lost its
        // quota or its price cannot be.
        if (
          plan === null ||
          plan.kind !== 'quota' ||
          plan.creditsPerMonth === null ||
          !plan.price.greaterThan(0)
        ) {
          throw billingPlanNotFound()
        }
        // The consent to auto-renewal stands as the customer left it; a shop that saves no
        // method is not asked to, and the order records that nothing of this payment is kept.
        const saveMethod = autopayments && !subscription.cancelAtPeriodEnd
        const unfinished = await tx.order.findFirst({
          where: { workspaceId, kind: 'subscription', status: 'pending' },
        })
        if (unfinished !== null) {
          return {
            order: unfinished,
            created: false,
            subscriptionId: subscription.id,
            plan,
            saveMethod,
          }
        }
        const order = await tx.order.create({
          data: {
            workspaceId,
            userId,
            kind: 'subscription',
            planId: plan.id,
            subscriptionId: subscription.id,
            amount: plan.price,
            status: 'pending',
            idempotenceKey: randomUUID(),
            savePaymentMethod: saveMethod,
          },
        })
        return { order, created: true, subscriptionId: subscription.id, plan, saveMethod }
      },
      { isolationLevel: 'ReadCommitted' },
    )
    const description = paymentDescription(plan.name)
    if (created) return requestPayment(deps, order, description)

    // The charge of a renewal that has no outcome: it is not the customer's to pay or to
    // close, and it decides about the tariff by itself.
    if (isRenewalOrder(order)) throw billingPaymentInProgress()
    const sameChoice =
      order.subscriptionId === subscriptionId &&
      order.planId === plan.id &&
      order.savePaymentMethod === saveMethod &&
      order.amount.equals(plan.price)
    if (order.yookassaPaymentId === null) {
      // As in `startCheckout`: the same choice asks ЮKassa again with the order's key.
      if (sameChoice) return requestPayment(deps, order, description)
      await supersede(prisma, order.id)
      continue
    }
    const read = await readBack(deps, order)
    if (read === null) {
      await supersede(prisma, order.id)
      continue
    }
    const { settlement, payment } = read
    // Paid a moment ago: the page of the order tells what became of it.
    if (settlement.state === 'paid') {
      return checkoutSchema.parse({
        orderId: order.id,
        confirmationUrl: checkoutReturnUrl(appUrl, order.id),
      })
    }
    // Failed or cancelled meanwhile: nothing stands in the way of a new order.
    if (settlement.state !== 'pending') continue
    if (!sameChoice) {
      // The tariff, its price or the consent changed since. If the old page is paid after all,
      // settlement asks an operator to return the money.
      await supersede(prisma, order.id)
      continue
    }
    const confirmationUrl = confirmationUrlOf(payment)
    // No page left and no outcome yet: the customer has confirmed, the bank is working.
    if (confirmationUrl === null) throw billingPaymentInProgress()
    return checkoutSchema.parse({ orderId: order.id, confirmationUrl })
  }
  throw conflict('The payment of the tariff was changed by other requests; try again')
}

/**
 * Settlement on behalf of a checkout: a shop that cannot be asked is «payments unavailable»
 * for the customer, not a failure of ours. null when the shop has no such payment.
 */
async function readBack(deps: BillingDeps, order: Order) {
  try {
    return await settleOrderRow(deps, order)
  } catch (error) {
    if (!(error instanceof YookassaError)) throw error
    if (error instanceof YookassaApiError && error.status === 404) return null
    throw paymentsUnavailable(error)
  }
}

/** We close an unfinished order ourselves: a new checkout takes its place. */
async function supersede(prisma: PrismaClient, orderId: string): Promise<void> {
  await prisma.order.updateMany({
    where: { id: orderId, status: 'pending' },
    data: { status: 'cancelled' },
  })
}

/** One repeat with the same key after a failure whose outcome is unknown. */
async function createPayment(
  yookassa: Pick<YookassaClient, 'createPayment'>,
  request: CreatePaymentInput,
  idempotenceKey: string,
): Promise<Payment> {
  try {
    return await yookassa.createPayment(request, idempotenceKey)
  } catch (error) {
    if (!(error instanceof YookassaError) || !error.retryable) throw error
    return yookassa.createPayment(request, idempotenceKey)
  }
}

/**
 * Creates the payment of a pending order, outside any transaction, and stores its id. The
 * request is built from the order and the name of what it buys, so a repeat with the order's
 * key is the same request — as long as the switch of autopayments has not been turned in
 * between. `description` is what the customer reads on the ЮKassa page.
 */
async function requestPayment(
  deps: BillingDeps,
  order: Order,
  description: string,
): Promise<CheckoutDto> {
  const { prisma, yookassa, appUrl, autopayments } = deps
  const request: CreatePaymentInput = {
    amount: { value: order.amount.toFixed(2), currency: 'RUB' },
    capture: true,
    // Proven on a real shop (AnyNote, 13.05.2026): a shop whose autopayments ЮKassa has not
    // approved answers 403 to `save_payment_method: true`, and a payment that leaves the field
    // out is accepted and paid. So with autopayments off the field is left out — of a pack and
    // of a payment by hand as well: whether such a shop takes an explicit `false` is not known.
    // With autopayments on the consent is said out loud, `true` or `false`. Assumed, tried on
    // no real shop: an explicit `false` is accepted and keeps the ЮKassa page from offering
    // the buyer to save the method, which it may do when the field is left out. A method the
    // buyer saved without our consent is never stored either way (`consentedMethod`).
    ...(autopayments ? { save_payment_method: order.savePaymentMethod } : {}),
    confirmation: { type: 'redirect', return_url: checkoutReturnUrl(appUrl, order.id) },
    description,
    metadata: { order_id: order.id, workspace_id: order.workspaceId },
  }
  let payment: Payment
  try {
    payment = await createPayment(yookassa, request, order.idempotenceKey)
  } catch (error) {
    const retryable = error instanceof YookassaError && error.retryable
    // Nobody was given a page to pay on, unless a concurrent request of the same order got
    // one and stored its payment: that order is left alone.
    await prisma.order.updateMany({
      where: { id: order.id, status: 'pending', yookassaPaymentId: null },
      data: {
        status: 'failed',
        failureReason: retryable
          ? orderFailureReasons.checkoutUnavailable
          : orderFailureReasons.checkoutRejected,
      },
    })
    throw paymentsUnavailable(error)
  }

  // The customer gets the page only if the order is still theirs to pay: a request that
  // closed it meanwhile must not be followed by a payment nobody waits for.
  const stored = await prisma.order.updateMany({
    where: {
      id: order.id,
      status: 'pending',
      OR: [{ yookassaPaymentId: null }, { yookassaPaymentId: payment.id }],
    },
    data: { yookassaPaymentId: payment.id },
  })
  if (stored.count === 0) {
    throw conflict('The order was closed while its payment was being created')
  }
  const confirmationUrl = confirmationUrlOf(payment)
  if (payment.status === 'pending' && confirmationUrl !== null) {
    return checkoutSchema.parse({ orderId: order.id, confirmationUrl })
  }

  // No page to pay on: ЮKassa cancelled the payment at once, or answered something we do not
  // expect. The payment is stored, so its outcome is read back and applied like any other.
  const read = await readBack(deps, { ...order, yookassaPaymentId: payment.id })
  if (read?.settlement.state === 'paid') {
    // Paid without a page. A first tariff is then on, which its page shows after a refresh; a
    // pack and a payment of an overdue tariff have no such state to refuse by, so their
    // customer goes straight to the page of the order.
    if (order.kind !== 'pack' && order.subscriptionId === null) throw billingSubscriptionExists()
    return checkoutSchema.parse({
      orderId: order.id,
      confirmationUrl: checkoutReturnUrl(appUrl, order.id),
    })
  }
  if (read?.settlement.state === 'failed') throw billingPaymentDeclined()
  throw paymentsUnavailable()
}

/**
 * The order as its return page shows it. Reads the payment back first, so the page works when
 * the notification is late or never comes; while ЮKassa cannot be reached the order is shown
 * as it is stored and the page asks again. A pending order whose payment the shop does not
 * know is cancelled. BILLING_ORDER_NOT_FOUND unless the order belongs to the user's personal
 * workspace.
 */
export async function syncOrder(deps: BillingDeps, input: SyncOrderInput): Promise<OrderSyncDto> {
  const { userId, orderId } = syncOrderInputSchema.parse(input)
  const { prisma, appEnv } = deps
  const workspace = await findPersonalWorkspace(prisma, { userId, appEnv })
  if (workspace === null) throw billingOrderNotFound()
  const order = await prisma.order.findFirst({ where: { id: orderId, workspaceId: workspace.id } })
  if (order === null) throw billingOrderNotFound()

  let settlement: SettledOrder | null = null
  try {
    settlement = (await settleOrderRow(deps, order)).settlement
  } catch (error) {
    if (!(error instanceof YookassaError)) throw error
    if (error instanceof YookassaApiError && error.status === 404) {
      // The shop does not know the payment, so nobody can pay the order: closed, as a checkout
      // closes it, instead of a page that fails on every poll. A closed order stays as it is.
      await supersede(prisma, order.id)
    } else if (!error.retryable) {
      throw error
    }
    // Otherwise an outage of ЮKassa, which is not the customer's failure: the order is shown
    // as it is stored, and the next poll reads the payment.
  }

  const row = await prisma.order.findUniqueOrThrow({
    where: { id: order.id },
    select: {
      id: true,
      status: true,
      kind: true,
      amount: true,
      failureReason: true,
      plan: { select: { name: true, packCredits: true } },
    },
  })
  settlement ??= await storedSettlement(prisma, row)
  const { subscription } =
    row.status === 'paid' ? await getPlanOverview(prisma, workspace.id) : { subscription: null }
  return orderSyncSchema.parse({
    orderId: order.id,
    status: row.status,
    kind: row.kind,
    planName: row.plan?.name ?? null,
    packCredits: row.kind === 'pack' ? (row.plan?.packCredits ?? null) : null,
    amount: row.amount.toFixed(2),
    failureText: row.status === 'failed' ? paymentFailureText(row.failureReason) : null,
    refundNeeded: settlement.refundNeeded,
    subscription,
  } satisfies OrderSyncDto)
}
