import {
  amountRubSchema,
  orderKindSchema,
  orderStatusSchema,
  subscriptionStatusSchema,
  taskRefusalReasons,
  taskStatuses,
  type CreditAccountKind,
} from '@repo/domain'
import { z } from 'zod'

// What the settings pages read. Money is a string with two decimals («4900.00»), credits are
// whole numbers, moments are Date. The schemas are the output schemas of the tRPC procedures.

const wholeCredits = z.number().int().nonnegative()
const positiveCount = z.number().int().positive()

/** A tariff with a monthly quota, as sold or as subscribed to. */
export const planSchema = z.object({
  id: z.uuid(),
  slug: z.string().min(1),
  name: z.string().min(1),
  /** RUB per month. */
  price: amountRubSchema,
  creditsPerMonth: positiveCount,
  /** Tariff credits a Moscow day may take; null: the plan has no daily limit. */
  creditsPerDay: positiveCount.nullable(),
  maxSites: positiveCount,
})
export type PlanDto = z.infer<typeof planSchema>

/** A pack of purchased credits. */
export const packSchema = z.object({
  id: z.uuid(),
  slug: z.string().min(1),
  name: z.string().min(1),
  /** RUB, paid once. */
  price: amountRubSchema,
  credits: positiveCount,
})
export type PackDto = z.infer<typeof packSchema>

export const planListSchema = z.object({
  /** Tariffs on sale, in the order they are shown. */
  plans: z.array(planSchema),
  /** The pack on sale; null when none is. */
  pack: packSchema.nullable(),
})
export type PlanListDto = z.infer<typeof planListSchema>

/** One subscription period: from `start` up to, but not including, `end`. */
const periodSchema = z.object({ start: z.date(), end: z.date() })

export const subscriptionOverviewSchema = z.object({
  id: z.uuid(),
  /** A live status only: an ended subscription is «no subscription». */
  status: subscriptionStatusSchema.extract(['trial', 'active', 'past_due']),
  plan: planSchema,
  period: periodSchema,
  /**
   * Whether the saved payment method is charged when the period ends. false: the customer did
   * not agree to it, switched it off, or no payment method is saved — the tariff then ends with
   * the period.
   */
  autoRenewal: z.boolean(),
  /** The plan of the next period when a change is scheduled. */
  nextPlan: planSchema.nullable(),
  /** The saved payment method by its Russian name, «Карта «Мир» •• 4444». */
  paymentMethod: z.object({ label: z.string().min(1) }).nullable(),
  /** Since when a renewal charge has been failing; null unless the status is past_due. */
  pastDueSince: z.date().nullable(),
})
export type SubscriptionOverviewDto = z.infer<typeof subscriptionOverviewSchema>

export const planOverviewSchema = z.object({
  /** null: the workspace has no live subscription, or the user has no workspace yet. */
  subscription: subscriptionOverviewSchema.nullable(),
})
export type PlanOverviewDto = z.infer<typeof planOverviewSchema>

const creditAccountShape = {
  balance: wholeCredits,
  /** Reserved by tasks that are not finished yet. */
  held: wholeCredits,
  /** What new tasks may still take: balance − held. */
  available: wholeCredits,
}
const availableIsFree = (account: { balance: number; held: number; available: number }) =>
  account.available === account.balance - account.held

const creditAccountSchema = z.object(creditAccountShape).refine(availableIsFree)

const giftAccountSchema = z
  .object({
    ...creditAccountShape,
    /**
     * The gift of the registration stands in the journal of this account. false: nothing was
     * granted to it yet, and the numbers beside it are zeros or a promise. A user who has no
     * workspace yet reads the gift that is granted together with it (`promisedCredits`):
     * `signupGiftCredits` as the balance and as available, nothing held.
     *
     * It is of the account, not of the user: a user whose gift stands on another workspace of
     * theirs reads false and zeros here, and `grantSignupGift` will still answer «already
     * granted». So false by itself never means that the gift is still to come — that is
     * decided by the key of the user, `ledgerKeys.signupGift(userId)` in `credit_ledger`, and
     * told by the numbers.
     */
    granted: z.boolean(),
  })
  .refine(availableIsFree)

const creditBalancesShape = {
  /** Credits of the tariff: granted anew every period. */
  tariff: creditAccountSchema,
  /**
   * Gift credits: granted once, with the personal workspace of the user, and shown as
   * promised before that; they do not expire.
   */
  gift: giftAccountSchema,
  /** Purchased credits: they do not expire. */
  pack: creditAccountSchema,
  /** «Осталось кредитов»: available on the three accounts. */
  totalAvailable: wholeCredits,
}
const totalIsAvailable = (credits: {
  tariff: { available: number }
  gift: { available: number }
  pack: { available: number }
  totalAvailable: number
}) =>
  credits.totalAvailable ===
  credits.tariff.available + credits.gift.available + credits.pack.available

/** The three credit accounts of a workspace as they stand. */
export const creditBalancesSchema = z.object(creditBalancesShape).refine(totalIsAvailable)
export type CreditBalancesDto = z.infer<typeof creditBalancesSchema>

/**
 * Whether a new task would be taken now, and why not: the answer the queue itself would give
 * to the first attempt of a task (`newTaskVerdict` of @repo/domain), so a page and the server
 * never disagree. A page chooses by the reason what it tells the customer. What a page cannot
 * know is the site of the task: `gift_site_used` is found only when a reserve is placed.
 */
export const newTaskSchema = z
  .object({
    allowed: z.boolean(),
    /** null exactly when the task would be taken. */
    reason: z.enum(taskRefusalReasons).nullable(),
  })
  .refine(({ allowed, reason }) => allowed === (reason === null))
export type NewTaskDto = z.infer<typeof newTaskSchema>

/**
 * The tariff credits of the Moscow day of a paid tariff: the limit of its plan, what the day
 * took — charged and set aside —, what is left of it and what the tariff can still give today.
 * `used` can stand above `limit` after a renewal onto a smaller plan; nothing is left then.
 */
export const tariffDaySchema = z
  .object({
    /** `plans.credits_per_day`; null: the plan has no daily limit. */
    limit: positiveCount.nullable(),
    /**
     * Charged: what the reserves placed in the day paid, and what charges of the day took from
     * free tariff credits in place of a gift or pack reserve.
     */
    charged: wholeCredits,
    /** Set aside: the tariff reserves placed in the day for tasks that are not finished yet. */
    held: wholeCredits,
    /** `charged` + `held`. */
    used: wholeCredits,
    /** max(0, `limit` − `used`); null exactly when `limit` is. */
    room: wholeCredits.nullable(),
    /** What the tariff can still give today: the room, or the free tariff credits when fewer. */
    left: wholeCredits,
  })
  .refine(({ charged, held, used }) => used === charged + held)
  .refine(({ limit, room }) => (limit === null) === (room === null))
  .refine(({ limit, used, room }) => limit === null || room === Math.max(0, limit - used))
  .refine(({ room, left }) => room === null || left <= room)
export type TariffDayDto = z.infer<typeof tariffDaySchema>

/** The numbers of that answer, beside the answer itself. */
const taskCreditsShape = {
  /**
   * What a task may take by the accounts: gift credits always, credits of the tariff and of a
   * pack only while the tariff is paid.
   */
  spendable: wholeCredits,
  /**
   * What a task may take now: `spendable` with the tariff credits no more than what is left of
   * the Moscow day.
   */
  spendableNow: wholeCredits,
  /** What tasks in work have set aside on the accounts a task may spend. */
  setAside: wholeCredits,
  /** How many spendable credits a new task needs to be taken. */
  minToStart: positiveCount,
  /** The tariff credits of the Moscow day; null without a paid tariff — there is no day then. */
  today: tariffDaySchema.nullable(),
  newTask: newTaskSchema,
}

/**
 * The credits of a workspace as the settings pages read them: the three accounts, and whether
 * a new task would be taken.
 */
export const creditsOverviewSchema = z
  .object({ ...creditBalancesShape, ...taskCreditsShape })
  .refine(totalIsAvailable)
export type CreditsOverviewDto = z.infer<typeof creditsOverviewSchema>

/**
 * `spendable`, `spendableNow`, `setAside`, `minToStart`, `today` and `newTask` of a credits
 * overview.
 */
export type TaskCreditsDto = Pick<CreditsOverviewDto, keyof typeof taskCreditsShape>

// A count of credits per million tokens, two decimals: "38.75".
const conversionNumber = z.string().regex(/^(?:0|[1-9]\d{0,9})\.\d{2}$/)

/**
 * How the work of a model is turned into credits, for «Точный расчёт»: credits per million
 * tokens of new text, of text read again and of text written — the prices in force of the
 * enabled models divided by the credit rate, rounded to two decimals.
 */
export const creditConversionSchema = z.object({
  /**
   * One row, `model` null, when one set of prices is in force for every enabled model that has
   * one; else a row per model, by its display name: a task on another model is charged by
   * other numbers than a single table states.
   */
  rows: z
    .array(
      z.object({
        model: z.string().min(1).nullable(),
        /** New text the model reads. */
        input: conversionNumber,
        /** Text the model reads again, from its cache. */
        cacheRead: conversionNumber,
        /** Text the model keeps for reading again; the price of new text unless it has its own. */
        cacheWrite: conversionNumber,
        /** Text the model writes. */
        output: conversionNumber,
      }),
    )
    .min(1),
})
export type CreditConversionDto = z.infer<typeof creditConversionSchema>

/** One order of the payment history. */
export const paymentSchema = z.object({
  id: z.uuid(),
  kind: orderKindSchema,
  /** The tariff or the pack paid for; null for a top-up. */
  planName: z.string().nullable(),
  /** The subscription period a tariff order pays for. */
  period: periodSchema.nullable(),
  amount: amountRubSchema,
  status: orderStatusSchema,
  /** Why the payment did not go through, as a short code: for logs and support. */
  failureReason: z.string().nullable(),
  /** The same as a sentence for the customer; null unless the order failed. */
  failureText: z.string().min(1).nullable(),
  refundedAmount: amountRubSchema.nullable(),
  refundedAt: z.date().nullable(),
  paidAt: z.date().nullable(),
  createdAt: z.date(),
})
export type PaymentDto = z.infer<typeof paymentSchema>

/** How many orders a page of the history may hold. */
export const MAX_PAYMENTS_PAGE = 100

export const paymentsQuerySchema = z.strictObject({
  /** `nextCursor` of the previous page; absent for the first one. */
  cursor: z.uuid().optional(),
  limit: z.number().int().min(1).max(MAX_PAYMENTS_PAGE).default(20),
})
export type PaymentsQuery = z.input<typeof paymentsQuerySchema>

export const paymentsPageSchema = z.object({
  /** Newest first. */
  items: z.array(paymentSchema),
  /** Pass it as `cursor` to get the next page; null on the last one. */
  nextCursor: z.uuid().nullable(),
})
export type PaymentsPageDto = z.infer<typeof paymentsPageSchema>

/**
 * What a task cost. `charged`: the task is done and what it cost is spent. `held`: the task is
 * in work, credits are set aside for it and it is charged when it is done. `unpaid`: the task
 * ended without a charge — it failed, was cancelled or was rolled back — and nothing was taken
 * for it. `free`: an undo, which takes no credit.
 */
export const usageOutcomes = ['charged', 'held', 'unpaid', 'free'] as const
export type UsageOutcome = (typeof usageOutcomes)[number]

/** Credits by the account they are of, in the order credits are spent. */
const creditsByAccountSchema = z.object({
  tariff: wholeCredits,
  gift: wholeCredits,
  pack: wholeCredits,
} satisfies Record<CreditAccountKind, unknown>)

/** One line of the usage history: a task that set credits aside, or an undo. */
export const usageEntrySchema = z
  .object({
    /** The task of the line: the cursor of the history. */
    id: z.uuid(),
    /** When the first reserve of the task was placed, which is when the task was queued. */
    at: z.date(),
    outcome: z.enum(usageOutcomes),
    /**
     * What the task was charged, on every account and in every period — the whole charge of a
     * task that was continued across a renewal —, or what is set aside for a task in work. null
     * when nothing was taken: an undo, a task that ended without a charge.
     */
    credits: positiveCount.nullable(),
    /** The same credits by the account that paid, or that the reserve stands on; null with them. */
    from: creditsByAccountSchema.nullable(),
    task: z.object({
      id: z.uuid(),
      /**
       * What the customer knows the task by: the summary of its latest turn, until the task
       * list of P12 names tasks otherwise. null before the first turn ends.
       */
      title: z.string().min(1).nullable(),
      status: z.enum(taskStatuses),
    }),
    site: z.object({ id: z.uuid(), name: z.string() }),
  })
  .refine(
    ({ outcome, credits }) => (credits !== null) === (outcome === 'charged' || outcome === 'held'),
  )
  .refine(({ credits, from }) =>
    from === null ? credits === null : credits === from.tariff + from.gift + from.pack,
  )
export type UsageEntryDto = z.infer<typeof usageEntrySchema>

/** How many lines a page of the usage history may hold. */
export const MAX_USAGE_PAGE = 100

export const usageHistoryQuerySchema = z.strictObject({
  /** `nextCursor` of the previous page; absent for the first one. */
  cursor: z.uuid().optional(),
  limit: z.number().int().min(1).max(MAX_USAGE_PAGE).default(20),
})
export type UsageHistoryQuery = z.input<typeof usageHistoryQuerySchema>

export const usageHistoryPageSchema = z.object({
  /** Newest first. */
  items: z.array(usageEntrySchema),
  /** Pass it as `cursor` to get the next page; null on the last one. */
  nextCursor: z.uuid().nullable(),
})
export type UsageHistoryPageDto = z.infer<typeof usageHistoryPageSchema>

/** What the current period of the tariff went to. */
export const tariffUsageSchema = z.object({
  /**
   * The credits of the tariff account that belong to the period, each part read from the
   * ledger by the stamp that says its period: what was granted is what was charged, what is
   * set aside, what expired and what is left — always.
   */
  credits: z
    .object({
      /** The quota the paid period was granted, and what an operator added to it since. */
      granted: wholeCredits,
      /** Charged to credits of this period by tasks that are done. */
      charged: wholeCredits,
      /** Set aside from credits of this period for tasks that are not finished yet. */
      held: wholeCredits,
      /**
       * Credits of this period that are gone without a charge: a reserve given back or left
       * unused once the tariff no longer took tasks, and what an operator took off the account.
       */
      expired: wholeCredits,
      /** What new tasks may still take. */
      left: wholeCredits,
      /**
       * Beside the meter, not in it: credits of an ended period still set aside for a task in
       * work. What that task does not use is not carried into this period.
       */
      heldEarlier: wholeCredits,
    })
    .refine(
      ({ granted, charged, held, expired, left }) => granted === charged + held + expired + left,
      { message: 'The parts of the period do not add up to what it was granted' },
    ),
  /**
   * The tariff credits of the Moscow day, as the answer about a new task tells them (`today`
   * beside it); null while the tariff is not paid — there is no day then.
   */
  today: tariffDaySchema.nullable(),
  /** Sites of the workspace, whatever their status, against the site limit of the plan. */
  sites: z.object({ count: wholeCredits, max: positiveCount }),
  /** Credits charged in the period per site, the largest first; a site without any is absent. */
  bySite: z.array(z.object({ siteId: z.uuid(), name: z.string(), credits: positiveCount })),
})
export type TariffUsageDto = z.infer<typeof tariffUsageSchema>

/** What an account that belongs to no period has: gift credits, purchased credits. */
const accountLeftSchema = z.object({
  /** What new tasks may still take. */
  left: wholeCredits,
  /** Reserved by tasks that are not finished yet. */
  held: wholeCredits,
})

const sameDay = (a: TariffDayDto | null, b: TariffDayDto | null): boolean =>
  a === null || b === null
    ? a === b
    : a.limit === b.limit &&
      a.charged === b.charged &&
      a.held === b.held &&
      a.used === b.used &&
      a.room === b.room &&
      a.left === b.left

/** «Настройки → Использование»: the credits left and what they went to. */
export const usageSummarySchema = z
  .object({
    /** The live subscription, as «Тарифы» shows it; null: no tariff. */
    subscription: subscriptionOverviewSchema.nullable(),
    /** null exactly when there is no live subscription. */
    tariff: tariffUsageSchema.nullable(),
    /**
     * Gift credits: they stay when a period or the tariff itself ends. `granted` as in the
     * overview (`creditBalancesSchema`): false with credits left is the gift a user without a
     * workspace is promised; false with none is a workspace the gift was never granted to.
     */
    gift: accountLeftSchema.extend({ granted: z.boolean() }),
    /** Purchased credits: they stay when a period or the tariff itself ends. */
    pack: accountLeftSchema,
    /** «Осталось кредитов»: on the tariff, of the gift and among purchased ones. */
    totalLeft: wholeCredits,
    /**
     * The first page of the history: of the current period of the tariff, or, without a live
     * subscription, of everything — there is no period then, and the history has no lower bound.
     */
    history: usageHistoryPageSchema,
    ...taskCreditsShape,
  })
  .refine(({ subscription, tariff }) => (subscription === null) === (tariff === null))
  // The meter of the tariff tells the day the answer about a new task is given by.
  .refine(({ tariff, today }) => tariff === null || sameDay(tariff.today, today))
  .refine(
    ({ tariff, gift, pack, totalLeft }) =>
      totalLeft === (tariff?.credits.left ?? 0) + gift.left + pack.left,
  )
export type UsageSummaryDto = z.infer<typeof usageSummarySchema>

/** What the customer chooses when paying for a tariff. */
export const checkoutRequestSchema = z.strictObject({
  /** plans.slug of a tariff on sale. */
  planSlug: z.string().min(1).max(50),
  /**
   * The consent to auto-renewal: true only when the customer ticked the box. The payment
   * method is saved and charged at the end of each period only then.
   */
  autoRenew: z.boolean(),
})
export type CheckoutRequest = z.infer<typeof checkoutRequestSchema>

/** A payment the customer can make now. */
export const checkoutSchema = z.object({
  orderId: z.uuid(),
  /** The ЮKassa page to send the customer to; they come back to the return page of the order. */
  confirmationUrl: z.url({ protocol: /^https?$/ }),
})
export type CheckoutDto = z.infer<typeof checkoutSchema>

/** An order as its return page shows it, after its payment was read back from ЮKassa. */
export const orderSyncSchema = z.object({
  orderId: z.uuid(),
  /** `pending`: the payment has no outcome yet, ask again. */
  status: orderStatusSchema,
  kind: orderKindSchema,
  /** The tariff or the pack paid for; null for a top-up. */
  planName: z.string().nullable(),
  /** How many credits the pack of a pack order holds; null for every other order. */
  packCredits: positiveCount.nullable(),
  amount: amountRubSchema,
  /** Why the payment did not go through, as a sentence for the customer; null unless failed. */
  failureText: z.string().min(1).nullable(),
  /**
   * The money arrived and was not applied: the order was already closed, the tariff was
   * already on, or the amount was not the order's. An operator returns it.
   */
  refundNeeded: z.boolean(),
  /** The live subscription of the workspace once the order is paid; null otherwise. */
  subscription: subscriptionOverviewSchema.nullable(),
})
export type OrderSyncDto = z.infer<typeof orderSyncSchema>

/** The start of binding a payment method. */
export const paymentMethodChangeSchema = z.object({
  /**
   * The ЮKassa page to send the customer to; nothing is charged there. They come back to the
   * return page of the binding.
   */
  confirmationUrl: z.url({ protocol: /^https?$/ }),
})
export type PaymentMethodChangeDto = z.infer<typeof paymentMethodChangeSchema>

/**
 * Where the binding the customer came back from stands. `pending`: ЮKassa has no outcome yet,
 * ask again. `active`: the method is bound and is the saved method of the subscription.
 * `inactive`: it was not bound, and the saved method is what it was. `none`: nothing is being
 * bound and the latest binding, if there was one, tells nothing any more.
 */
export const paymentMethodBindingStates = ['pending', 'active', 'inactive', 'none'] as const
export type PaymentMethodBindingState = (typeof paymentMethodBindingStates)[number]

/**
 * The charge that renews the current period of a subscription, while it has no outcome. A charge
 * that was started is neither stopped nor returned when the customer unlinks or replaces the
 * payment method: if its payment succeeds, the tariff renews. `none`: no charge was started for
 * the period, or it has ended. `at_bank`: the charge holds a payment — the bank decides.
 * `unanswered`: the request left, or is leaving, and no answer of the shop is stored — nobody
 * can tell yet whether a payment was made.
 */
export const renewalChargeStates = ['none', 'at_bank', 'unanswered'] as const
export type RenewalChargeState = (typeof renewalChargeStates)[number]

/** A binding as its return page shows it, after the method was read back from ЮKassa. */
export const paymentMethodSyncSchema = z.object({
  state: z.enum(paymentMethodBindingStates),
  /**
   * The renewal charge the bound method came too late for: it was started with the method saved
   * before, and still has no outcome. Anything but `none` only with `active`.
   */
  renewalCharge: z.enum(renewalChargeStates),
  /** The live subscription with the method it has now; null: no tariff. */
  subscription: subscriptionOverviewSchema.nullable(),
})
export type PaymentMethodSyncDto = z.infer<typeof paymentMethodSyncSchema>

/** What unlinking the saved payment method left under way. */
export const paymentMethodUnlinkSchema = z.object({
  /** The renewal charge that had been started before the method was unlinked. */
  renewalCharge: z.enum(renewalChargeStates),
})
export type PaymentMethodUnlinkDto = z.infer<typeof paymentMethodUnlinkSchema>

/**
 * What the live subscription of a workspace waits for beside what its overview shows. Both are
 * false and `none` without a live subscription.
 */
export const subscriptionWaitsSchema = z.object({
  /**
   * A binding of a payment method was started and has not been read back as bound or refused:
   * `billing.syncPaymentMethod` settles it. The id of the method is never sent.
   */
  bindingPending: z.boolean(),
  /** The renewal charge of the current period, whichever method it was started with. */
  renewalCharge: z.enum(renewalChargeStates),
})
export type SubscriptionWaitsDto = z.infer<typeof subscriptionWaitsSchema>

/** What switching auto-renewal off left as it was. */
export const autoRenewalCancelSchema = z.object({
  /**
   * The renewal charge that had been started before the switch: it is not stopped, and its
   * payment renews the tariff once more if it succeeds.
   */
  renewalCharge: z.enum(renewalChargeStates),
  /** The tariff works until this moment, unless that charge moves it. */
  periodEnd: z.date(),
})
export type AutoRenewalCancelDto = z.infer<typeof autoRenewalCancelSchema>

/**
 * What became of «switch auto-renewal on». With a saved payment method it is on at once. Without
 * one the customer is sent to the ЮKassa page that binds a card, where nothing is charged, and
 * auto-renewal is switched on when that binding is read back as saved — not before.
 */
export const autoRenewalResumeSchema = z.discriminatedUnion('needsPaymentMethod', [
  z.object({
    needsPaymentMethod: z.literal(false),
    /** The renewal charge of the period that is under way, started before the switch. */
    renewalCharge: z.enum(renewalChargeStates),
  }),
  z.object({
    needsPaymentMethod: z.literal(true),
    confirmationUrl: z.url({ protocol: /^https?$/ }),
  }),
])
export type AutoRenewalResumeDto = z.infer<typeof autoRenewalResumeSchema>

/** The tariff the customer wants from the next period on. */
export const planChangeRequestSchema = z.strictObject({
  /** plans.slug of a tariff on sale, other than the one the subscription has. */
  planSlug: z.string().min(1).max(50),
})
export type PlanChangeRequest = z.infer<typeof planChangeRequestSchema>

/**
 * Why the last tariff of a workspace is over. `not_renewed`: its paid period ended and was not
 * renewed — auto-renewal was off. `not_paid`: a renewal charge failed and nobody paid within
 * the grace. `refunded`: an operator returned its payment and ended it at once.
 */
export const subscriptionEndReasons = ['not_renewed', 'not_paid', 'refunded'] as const
export type SubscriptionEndReason = (typeof subscriptionEndReasons)[number]

/** The tariff a workspace had last, once it has no live one. */
export const endedSubscriptionSchema = z.object({
  planName: z.string().min(1),
  /**
   * When it ended: the end of its paid period (`not_renewed`), the moment an operator ended it
   * (`refunded`), or the moment its grace ran out and it was ended unpaid (`not_paid`) — the day
   * its customer had been told it would end.
   */
  endedAt: z.date(),
  reason: z.enum(subscriptionEndReasons),
})
export type EndedSubscriptionDto = z.infer<typeof endedSubscriptionSchema>
