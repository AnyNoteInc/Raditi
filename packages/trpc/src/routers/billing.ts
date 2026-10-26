import {
  autoRenewalCancelSchema,
  autoRenewalResumeSchema,
  cancelAutoRenew,
  cancelPlanChange,
  checkoutRequestSchema,
  checkoutSchema,
  creditConversionSchema,
  creditsOverviewSchema,
  endedSubscriptionSchema,
  getCreditConversion,
  getCreditsOverview,
  getEndedSubscription,
  getPlanOverview,
  getPromisedCreditsOverview,
  getSubscriptionWaits,
  getUsageSummary,
  isSignupGiftGranted,
  listPayments,
  listPlans,
  listUsageHistory,
  orderSyncSchema,
  packSchema,
  paymentMethodChangeSchema,
  paymentMethodSyncSchema,
  paymentMethodUnlinkSchema,
  paymentsPageSchema,
  paymentsQuerySchema,
  planChangeRequestSchema,
  planSchema,
  promisedUsage,
  renewalChargeStates,
  resumeAutoRenew,
  schedulePlanChange,
  startCheckout,
  startPackCheckout,
  startPastDuePayment,
  startPaymentMethodChange,
  subscriptionOverviewSchema,
  subscriptionWaitsSchema,
  syncOrder,
  syncPaymentMethod,
  unlinkPaymentMethod,
  usageHistoryPageSchema,
  usageHistoryQuerySchema,
  usageSummarySchema,
  type BillingDeps,
  type CreditsOverviewDto,
  type PaymentMethodDeps,
  type PaymentsPageDto,
  type UsageHistoryPageDto,
} from '@repo/billing'
import { findPersonalWorkspace } from '@repo/db'
import {
  amountRubSchema,
  appEnvSchema,
  billingPaymentsNotConfigured,
  type AppEnv,
} from '@repo/domain'
import { z } from 'zod'

import { consentedProcedure, protectedProcedure, router, type Context } from '../trpc.ts'

// Billing is kept for the user's personal workspace. A user who has neither added a site nor
// paid has no workspace yet: no subscription, no sites, and no credits but the gift of the
// registration, which is shown as promised until the workspace is made and the gift with it.

/**
 * false: the shop takes one-time payments only (YOOKASSA_AUTOPAYMENTS=off), or is not set up at
 * all. No payment method is saved or bound and auto-renewal cannot be switched on: the pages do
 * not offer it. A method saved before stays, with its auto-renewal and the way to unlink it.
 */
const autoRenewalAvailable = z.boolean()

const overviewOutput = z.object({
  /** false: the shop is not set up. The state is shown, nothing can be paid for. */
  paymentsEnabled: z.boolean(),
  autoRenewalAvailable,
  /** null: no live subscription. */
  subscription: subscriptionOverviewSchema.nullable(),
  /**
   * The three accounts of credits, and whether a new task would be taken now: the pages choose
   * what they tell the customer by `credits.newTask.reason`.
   */
  credits: creditsOverviewSchema,
  /**
   * What the subscription waits for: a binding that `syncPaymentMethod` has to settle, and the
   * renewal charge of the period while it has no outcome.
   */
  ...subscriptionWaitsSchema.shape,
  /**
   * When an overdue tariff ends unless it is paid for: the moment the grace of
   * BILLING_PAST_DUE_DAYS runs out. null unless the subscription is past due, and while
   * payments are off: nobody is ended for a payment they have no way to make.
   */
  pastDueEndsAt: z.date().nullable(),
  /** The tariff the customer had last; null while one is live, or when there never was one. */
  ended: endedSubscriptionSchema.nullable(),
})

const DAY_MS = 24 * 60 * 60_000

/**
 * What a user who has not accepted the current documents is shown of their tariff, on the page
 * that asks for the consent: only what tells them that a charge is coming and lets them stop it.
 */
const autoRenewalOutput = z.object({
  /** null: no tariff that is paid for and renews by itself. */
  renewal: z
    .object({
      /** The tariff the customer has. */
      planName: z.string().min(1),
      /** The tariff of the next period when a change is scheduled; null otherwise. */
      nextPlanName: z.string().min(1).nullable(),
      /** What the saved payment method is charged at the end of the period, RUB. */
      amount: amountRubSchema,
      /** The end of the paid period: when the charge is made. */
      chargeAt: z.date(),
      /** The charge of the period that has already been started, if any. */
      renewalCharge: z.enum(renewalChargeStates),
      /**
       * Payments are on and the shop takes one-time payments only: auto-renewal that is switched
       * off there cannot be switched back on, and the page says so before the step. false while
       * payments are off: nothing is said of what a shop does not do.
       */
      oneTimeOnly: z.boolean(),
    })
    .nullable(),
})

/** The method is unlinked; `renewalCharge` tells of a charge that had been started before. */
const unlinkOutput = paymentMethodUnlinkSchema.extend({ unlinked: z.literal(true) })

const plansOutput = z.object({
  /** Tariffs on sale, in the order they are shown. */
  plans: z.array(
    planSchema.extend({
      /** The sites of the workspace fit the plan; a checkout refuses a plan they do not fit. */
      fitsSites: z.boolean(),
      /** The plan of the live subscription. */
      current: z.boolean(),
    }),
  ),
  /** The pack on sale; null when none is. */
  pack: packSchema.nullable(),
  /** Sites of the workspace, whatever their status: what `maxSites` is compared with. */
  siteCount: z.number().int().nonnegative(),
  /** Whether a tariff can be bought with the consent to auto-renewal; as in `overview`. */
  autoRenewalAvailable,
  /**
   * The table of «Точный расчёт»: credits per million tokens. null — the block is not shown —
   * while no credit rate is usable or no enabled model has a price in force.
   */
  creditConversion: creditConversionSchema.nullable(),
})

const usageOutput = z.intersection(
  usageSummarySchema,
  z.object({
    /** false: the shop is not set up, so no pack of credits can be bought. */
    paymentsEnabled: z.boolean(),
    /** Whether auto-renewal can be switched on; as in `overview`. */
    autoRenewalAvailable,
    /** The pack on sale, for the offer to buy more credits; null when none is. */
    packOnSale: packSchema.nullable(),
  }),
)

const noHistory: UsageHistoryPageDto = { items: [], nextCursor: null }

const noPayments: PaymentsPageDto = { items: [], nextCursor: null }

type Viewer = Pick<Context, 'prisma' | 'billing'> & { user: { id: string } }

/**
 * The environment decides which workspace is the personal one, as in project.create. With
 * payments on it is the one a checkout uses, so a page reads the workspace it pays for.
 */
const appEnvOf = ({ billing }: Pick<Context, 'billing'>): AppEnv =>
  billing?.appEnv ?? appEnvSchema.parse(process.env.APP_ENV)

/** The user's personal workspace; null while they have none. */
async function personalWorkspaceId(viewer: Viewer): Promise<string | null> {
  const { prisma, user } = viewer
  const workspace = await findPersonalWorkspace(prisma, {
    userId: user.id,
    appEnv: appEnvOf(viewer),
  })
  return workspace?.id ?? null
}

/**
 * Where a page that shows the gift of the registration reads from: the personal workspace, or —
 * for a user who has none — whether the gift was granted to the user all the same.
 */
type CreditsHome = { workspaceId: string } | { workspaceId: null; giftGranted: boolean }

/**
 * The personal workspace of the viewer; without one, whether the key of their gift stands in
 * the ledger (`isSignupGiftGranted`): the gift is promised while it does not.
 *
 * The workspace and the key are two reads, not one snapshot: a first site or a first checkout
 * that commits between them leaves the first at «no workspace» and the second at «granted».
 * So a key that is found sends the viewer for the workspace once more. Read after the key, it
 * is there — the workspace and its gift are made in one commit —, and the page shows the
 * credits where they stand. «No workspace» with the gift granted is answered only when the
 * second look finds none either: the gift stands on a workspace that is no longer personal.
 */
async function creditsHome(viewer: Viewer): Promise<CreditsHome> {
  const workspaceId = await personalWorkspaceId(viewer)
  if (workspaceId !== null) return { workspaceId }
  if (!(await isSignupGiftGranted(viewer.prisma, viewer.user.id))) {
    return { workspaceId: null, giftGranted: false }
  }
  const made = await personalWorkspaceId(viewer)
  return made === null ? { workspaceId: null, giftGranted: true } : { workspaceId: made }
}

/**
 * The credits of the viewer at `now`, with the answer about a new task: those of the personal
 * workspace, or — without one — the gift of the registration as it is promised.
 */
function creditsOf(
  { prisma }: Pick<Context, 'prisma'>,
  home: CreditsHome,
  now: Date,
): Promise<CreditsOverviewDto> {
  return home.workspaceId === null
    ? getPromisedCreditsOverview(prisma, { giftGranted: home.giftGranted, now })
    : getCreditsOverview(prisma, { workspaceId: home.workspaceId, now })
}

/**
 * What checkout, settlement and the binding of a payment method work with; refused while
 * payments are switched off.
 */
function billingDeps({
  prisma,
  billing,
}: Pick<Context, 'prisma' | 'billing'>): BillingDeps & PaymentMethodDeps {
  if (billing === null) throw billingPaymentsNotConfigured()
  const { yookassa, appUrl, appEnv, autopayments } = billing
  return { prisma, yookassa, appUrl, appEnv, autopayments }
}

/** What `autoRenewalAvailable` of an answer is: the switch of a shop that is set up. */
const autoRenewalAvailableIn = ({ billing }: Pick<Context, 'billing'>): boolean =>
  billing?.autopayments === true

/**
 * What a change that asks nothing of the shop works with — auto-renewal switched off, the
 * tariff of the next period: the database and the environment that tells the personal workspace.
 */
const changeDeps = (ctx: Pick<Context, 'prisma' | 'billing'>) => ({
  prisma: ctx.prisma,
  appEnv: appEnvOf(ctx),
})

export const billingRouter = router({
  /**
   * The tariff of the user and the credits left, for the settings pages, with the answer about
   * a new task (`credits.newTask`). A user without a workspace reads the gift of the
   * registration as promised: `credits.gift` available and not granted (`promisedCredits`).
   */
  overview: consentedProcedure.output(overviewOutput).query(async ({ ctx }) => {
    const home = await creditsHome(ctx)
    const { workspaceId } = home
    const [{ subscription }, credits, waits] = await Promise.all([
      getPlanOverview(ctx.prisma, workspaceId),
      creditsOf(ctx, home, new Date()),
      getSubscriptionWaits(ctx.prisma, workspaceId),
    ])
    // Asked only without a live tariff: a customer who has one is not told of the one before.
    const ended = subscription === null ? await getEndedSubscription(ctx.prisma, workspaceId) : null
    // The grace is counted as the scheduler counts it (`endPeriods` of @repo/billing).
    const pastDueEndsAt =
      subscription?.status === 'past_due' && ctx.billing !== null
        ? new Date(
            (subscription.pastDueSince ?? subscription.period.end).getTime() +
              ctx.billing.pastDueDays * DAY_MS,
          )
        : null
    return {
      paymentsEnabled: ctx.billing !== null,
      autoRenewalAvailable: autoRenewalAvailableIn(ctx),
      subscription,
      credits,
      ...waits,
      pastDueEndsAt,
      ended,
    }
  }),

  /**
   * The coming charge of auto-renewal, for the page that asks for the consent to the documents.
   * Open to a user who has not accepted them, like `cancelAutoRenew` (default «н» of
   * docs/plan/37-billing-plan.md): such a user is charged all the same and has to see it where
   * they are sent. Nothing but what the block of that page shows.
   */
  autoRenewal: protectedProcedure.output(autoRenewalOutput).query(async ({ ctx }) => {
    const workspaceId = await personalWorkspaceId(ctx)
    const { subscription } = await getPlanOverview(ctx.prisma, workspaceId)
    // An overdue tariff is not charged by itself: it waits for a payment made by hand.
    if (subscription === null || subscription.status !== 'active' || !subscription.autoRenewal) {
      return { renewal: null }
    }
    const { renewalCharge } = await getSubscriptionWaits(ctx.prisma, workspaceId)
    return {
      renewal: {
        planName: subscription.plan.name,
        nextPlanName: subscription.nextPlan?.name ?? null,
        amount: (subscription.nextPlan ?? subscription.plan).price,
        chargeAt: subscription.period.end,
        renewalCharge,
        oneTimeOnly: ctx.billing !== null && !autoRenewalAvailableIn(ctx),
      },
    }
  }),

  /**
   * What is on sale, how each tariff suits the user's sites, and how the work of a task is
   * turned into credits (`creditConversion`).
   */
  plans: consentedProcedure.output(plansOutput).query(async ({ ctx }) => {
    const workspaceId = await personalWorkspaceId(ctx)
    const [{ plans, pack }, { subscription }, siteCount, creditConversion] = await Promise.all([
      listPlans(ctx.prisma),
      getPlanOverview(ctx.prisma, workspaceId),
      // The count a checkout compares with the plan (startCheckout of @repo/billing).
      workspaceId === null ? 0 : ctx.prisma.site.count({ where: { workspaceId, deletedAt: null } }),
      getCreditConversion(ctx.prisma, new Date()),
    ])
    return {
      plans: plans.map((plan) => ({
        ...plan,
        fitsSites: siteCount <= plan.maxSites,
        current: plan.id === subscription?.plan.id,
      })),
      pack,
      siteCount,
      autoRenewalAvailable: autoRenewalAvailableIn(ctx),
      creditConversion,
    }
  }),

  /**
   * «Использование»: the credits left, what the current period of the tariff went to, the
   * first page of the history and the answer about a new task. A user without a workspace reads
   * the gift of the registration as promised, as in `overview`.
   */
  usage: consentedProcedure.output(usageOutput).query(async ({ ctx }) => {
    const home = await creditsHome(ctx)
    const now = new Date()
    const [usage, { pack }] = await Promise.all([
      home.workspaceId === null
        ? creditsOf(ctx, home, now).then(promisedUsage)
        : getUsageSummary(ctx.prisma, { workspaceId: home.workspaceId, now }),
      listPlans(ctx.prisma),
    ])
    return {
      ...usage,
      paymentsEnabled: ctx.billing !== null,
      autoRenewalAvailable: autoRenewalAvailableIn(ctx),
      packOnSale: pack,
    }
  }),

  /**
   * A page of the usage history — of the current period of the tariff, or of everything when
   * the customer has no tariff; `cursor` is `nextCursor` of the page before it. `billing.usage`
   * carries the first page.
   */
  usageHistory: consentedProcedure
    .input(usageHistoryQuerySchema)
    .output(usageHistoryPageSchema)
    .query(async ({ ctx, input }) => {
      const workspaceId = await personalWorkspaceId(ctx)
      return workspaceId === null ? noHistory : listUsageHistory(ctx.prisma, workspaceId, input)
    }),

  /**
   * «Оплата»: a page of the payment history, newest first; `cursor` is `nextCursor` of the
   * page before it.
   */
  payments: consentedProcedure
    .input(paymentsQuerySchema)
    .output(paymentsPageSchema)
    .query(async ({ ctx, input }) => {
      const workspaceId = await personalWorkspaceId(ctx)
      return workspaceId === null ? noPayments : listPayments(ctx.prisma, workspaceId, input)
    }),

  /**
   * Starts the payment of a tariff; the customer is sent to `confirmationUrl`. The consent to
   * auto-renewal is refused with BILLING_AUTO_RENEWAL_UNAVAILABLE while the shop takes one-time
   * payments only; so are `resumeAutoRenew` and `startPaymentMethodChange`.
   */
  startCheckout: consentedProcedure
    .input(checkoutRequestSchema)
    .output(checkoutSchema)
    .mutation(({ ctx, input }) =>
      startCheckout(billingDeps(ctx), { userId: ctx.user.id, ...input }),
    ),

  /**
   * Starts the payment of the credit pack on sale; the customer is sent to `confirmationUrl`.
   * Nothing is chosen: the pack and its price are the ones `plans` shows.
   */
  startPackCheckout: consentedProcedure
    .input(z.strictObject({}))
    .output(checkoutSchema)
    .mutation(({ ctx }) => startPackCheckout(billingDeps(ctx), { userId: ctx.user.id })),

  /**
   * The order as its return page shows it. A mutation: the payment is read back from the shop
   * and the order is settled here when the notification is late.
   */
  syncOrder: consentedProcedure
    .input(z.strictObject({ orderId: z.uuid() }))
    .output(orderSyncSchema)
    .mutation(({ ctx, input }) =>
      syncOrder(billingDeps(ctx), { userId: ctx.user.id, orderId: input.orderId }),
    ),

  /**
   * Starts the payment a customer makes by hand for a tariff whose renewal charge failed
   * («Оплатить сейчас»); the customer is sent to `confirmationUrl`. Nothing is chosen: the
   * tariff and its price are the ones the page shows.
   */
  startPastDuePayment: consentedProcedure
    .input(z.strictObject({}))
    .output(checkoutSchema)
    .mutation(({ ctx }) => startPastDuePayment(billingDeps(ctx), { userId: ctx.user.id })),

  /**
   * Switches auto-renewal off: the tariff works to the end of its period and is not charged
   * again. Open to a user who has not accepted a new edition of the documents: stopping the
   * charges must not wait for a consent (default «н» of docs/plan/37-billing-plan.md). It asks
   * nothing of the shop, so it works while payments are switched off as well. A renewal charge
   * that had been started is not stopped: the answer says where it stands.
   */
  cancelAutoRenew: protectedProcedure
    .input(z.strictObject({}))
    .output(autoRenewalCancelSchema)
    .mutation(({ ctx }) => cancelAutoRenew(changeDeps(ctx), { userId: ctx.user.id })),

  /**
   * Switches auto-renewal on. With a saved payment method it is on at once; without one the
   * customer is sent to `confirmationUrl` to bind a card, and auto-renewal is switched on when
   * that card is saved.
   */
  resumeAutoRenew: consentedProcedure
    .input(z.strictObject({}))
    .output(autoRenewalResumeSchema)
    .mutation(({ ctx }) => resumeAutoRenew(billingDeps(ctx), { userId: ctx.user.id })),

  /**
   * Schedules another tariff for the next period; nothing changes and nothing is charged today.
   * The answer is the subscription as «Тарифы» shows it now.
   */
  schedulePlanChange: consentedProcedure
    .input(planChangeRequestSchema)
    .output(subscriptionOverviewSchema)
    .mutation(({ ctx, input }) =>
      schedulePlanChange(changeDeps(ctx), { userId: ctx.user.id, ...input }),
    ),

  /** Takes the scheduled change of tariff back: the tariff the customer has renews. */
  cancelPlanChange: consentedProcedure
    .input(z.strictObject({}))
    .output(subscriptionOverviewSchema)
    .mutation(({ ctx }) => cancelPlanChange(changeDeps(ctx), { userId: ctx.user.id })),

  /**
   * Starts binding a card to the tariff, in place of the saved payment method or as the first
   * one; the customer is sent to `confirmationUrl`, where nothing is charged.
   */
  startPaymentMethodChange: consentedProcedure
    .input(z.strictObject({}))
    .output(paymentMethodChangeSchema)
    .mutation(({ ctx }) => startPaymentMethodChange(billingDeps(ctx), { userId: ctx.user.id })),

  /**
   * The binding as its return page shows it. A mutation: the method is read back from the shop
   * and stored here when the notification is late.
   */
  syncPaymentMethod: consentedProcedure
    .input(z.strictObject({}))
    .output(paymentMethodSyncSchema)
    .mutation(({ ctx }) => syncPaymentMethod(billingDeps(ctx), { userId: ctx.user.id })),

  /**
   * Unlinks the saved payment method and switches auto-renewal off. Open to a user who has not
   * accepted a new edition of the documents: stopping the charges must not wait for a consent
   * (default «н» of docs/plan/37-billing-plan.md). It asks nothing of the shop, so it works
   * while payments are switched off as well. A renewal charge that had been started is not
   * stopped: the answer says where it stands, and the page tells the customer.
   */
  unlinkPaymentMethod: protectedProcedure
    .input(z.strictObject({}))
    .output(unlinkOutput)
    .mutation(async ({ ctx }) => {
      const { renewalCharge } = await unlinkPaymentMethod(
        { prisma: ctx.prisma, appEnv: appEnvOf(ctx) },
        { userId: ctx.user.id },
      )
      return { unlinked: true as const, renewalCharge }
    }),
})
