import type { AppRouter } from '@repo/trpc'
import type { inferRouterOutputs } from '@trpc/server'

// What the `billing` router sends, as the pages receive it: money is a decimal string, a moment
// is a Date (superjson).
type Billing = inferRouterOutputs<AppRouter>['billing']

export type BillingOverview = Billing['overview']
/** The live subscription of the customer. */
export type Subscription = NonNullable<BillingOverview['subscription']>
export type CreditBalances = BillingOverview['credits']
/**
 * Whether a new task would be taken now — the answer the queue itself would give —, and the
 * numbers it is explained by: what a task could spend, what tasks in work have set aside, how
 * many credits a new task needs and the launches of the day against their limit. «Тарифы» and
 * «Использование» read it alike.
 */
export type TaskCredits = Pick<
  CreditBalances,
  'spendable' | 'setAside' | 'minToStart' | 'today' | 'newTask'
>
/** Why a new task would not be taken. */
export type TaskRefusalReason = NonNullable<TaskCredits['newTask']['reason']>
/**
 * The renewal charge of the current period while it has no outcome: `at_bank` — its payment is
 * with the bank, `unanswered` — the request left and no answer is stored, `none` — no charge is
 * under way.
 */
export type RenewalCharge = BillingOverview['renewalCharge']
/** A tariff on sale with how it suits the customer's sites. */
export type PlanOffer = Billing['plans']['plans'][number]
/** The pack of credits on sale. */
export type PackOffer = NonNullable<Billing['plans']['pack']>
/** The table of «Точный расчёт»: credits per million tokens, a row for all models or one each. */
export type CreditConversion = NonNullable<Billing['plans']['creditConversion']>
/** A payment the customer can make now: the answer of a started checkout, a tariff's or a pack's. */
export type Checkout = Billing['startCheckout']
/** An order as its return page shows it. */
export type OrderState = Billing['syncOrder']
/** «Использование»: the credits left and what the current period of the tariff went to. */
export type BillingUsage = Billing['usage']
/** What the current period of the tariff went to. */
export type TariffUsage = NonNullable<BillingUsage['tariff']>
/** One line of the usage history. */
export type UsageEntry = Billing['usageHistory']['items'][number]
/** One order of the payment history. */
export type PaymentEntry = Billing['payments']['items'][number]
/** A binding of a payment method as its return page shows it. */
export type MethodBinding = Billing['syncPaymentMethod']
/** The answer of an unlink: the renewal charge that had been started before it. */
export type MethodUnlink = Billing['unlinkPaymentMethod']
/** The tariff the customer had last, once none is live. */
export type EndedSubscription = NonNullable<BillingOverview['ended']>
/** The answer of «Отключить автопродление»: the charge that had been started, the last day. */
export type AutoRenewalCancel = Billing['cancelAutoRenew']
/** The answer of «Включить автопродление»: on at once, or the page that binds a card first. */
export type AutoRenewalResume = Billing['resumeAutoRenew']
/** The coming charge of auto-renewal, as the page that asks for the consent shows it. */
export type ComingRenewal = NonNullable<Billing['autoRenewal']['renewal']>
