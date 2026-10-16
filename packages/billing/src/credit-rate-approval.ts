import type { ModelClass } from '@repo/db'
import {
  attemptStepCredits,
  creditAccountUnits,
  creditRateCoversPrice,
  decimalStringSchema,
  liveSubscriptionStatuses,
  Money,
  rubPerCreditSchema,
} from '@repo/domain'
import { z } from 'zod'

import type { BillingTx } from './accounts.ts'
import { writeBillingAudit } from './audit.ts'
import { creditRateAt, TURN_KEY_LIMIT_RUB } from './credit-rate.ts'
import type { BillingDeps } from './deps.ts'
import { operatorActionSchema } from './refund.ts'

// The one act that writes the accounting rates of the models and the credit rate K (spec §17,
// «Учётные ставки»; docs/plan/37-billing-plan.md, «Курс кредита и команда ставок»). Nothing else
// in the product writes `llm_model_prices` or `credit_rates`: the operator command
// `billing:rates` calls `approveCreditRate`, which writes the listed price rows and one rate row
// with one `effective_from` in one transaction — so a rate is never older than a price it
// converts — or writes nothing and says why. What the rate does to the platform's money is
// counted first and handed to the caller before anything is written.

export const creditRateAuditActions = { approve: 'billing.credit_rate.approve' } as const

/** A tariff whose credits cost more than this share of its price needs `confirmExposure`. */
export const EXPOSURE_SHARE_LIMIT = '0.5'
/** A rate that differs from the one in force by more than this share needs `confirmExposure`. */
export const RATE_MOVE_LIMIT = '0.1'

// One line without control characters: printed to a terminal and kept in a row.
const oneLine = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(/^\P{Cc}+$/u)

// The slugs of `llm_providers` (varchar 64) and `llm_models` (varchar 128).
const slug = (max: number) =>
  z
    .string()
    .max(max)
    .regex(/^[a-z0-9][a-z0-9._-]*$/)

// RUB per million tokens including VAT, Decimal(14,6) — the precision of `llm_model_prices`.
const pricePer1m = decimalStringSchema(8, 6)

const modelPriceSchema = z.strictObject({
  provider: slug(64),
  model: slug(128),
  inputPer1m: pricePer1m,
  /** null: cached input is costed at the input price. */
  cacheReadPer1m: pricePer1m.nullable(),
  /** null: a write to the cache is costed at the input price. */
  cacheWritePer1m: pricePer1m.nullable(),
  outputPer1m: pricePer1m,
  /** A share below one, Decimal(5,4): "0.2200" for 22%. */
  vatRate: decimalStringSchema(1, 4).refine((value) => value.startsWith('0')),
  sourceUrl: z.url({ protocol: /^https?$/ }).max(1024),
})

/**
 * What the owner approves, as the file of `billing:rates` holds it: the credit rate, how it was
 * derived, and the price rows that start with it — none for a change of the rate alone.
 */
export const creditRatesSchema = z
  .strictObject({
    rubPerCredit: rubPerCreditSchema,
    /** Basket, model, rates, date, who approved: `credit_rates.basis`. */
    basis: oneLine(1024),
    prices: z.array(modelPriceSchema).max(100),
  })
  // A model is priced once: two rows of one model could not start at one instant.
  .refine(
    ({ prices }) =>
      new Set(prices.map(({ provider, model }) => `${provider}/${model}`)).size === prices.length,
  )

export type CreditRates = z.infer<typeof creditRatesSchema>

/** Why a file of rates is not taken. */
export type CreditRatesProblem =
  /** Price rows and no `rubPerCredit`: prices are never written without a rate. */
  | { problem: 'prices_without_rate' }
  /** The fields that do not pass, as paths into the file: `prices.0.inputPer1m`. */
  | { problem: 'invalid'; fields: string[] }

/**
 * Reads what a file of rates holds. Prices without a rate are told apart from every other
 * mistake: that file asks for the one thing the command exists to prevent.
 */
export function parseCreditRates(
  value: unknown,
): { ok: true; rates: CreditRates } | ({ ok: false } & CreditRatesProblem) {
  const parsed = creditRatesSchema.safeParse(value)
  if (parsed.success) return { ok: true, rates: parsed.data }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const { rubPerCredit, prices } = value as { rubPerCredit?: unknown; prices?: unknown }
    if (rubPerCredit === undefined && Array.isArray(prices) && prices.length > 0) {
      return { ok: false, problem: 'prices_without_rate' }
    }
  }
  const fields = parsed.error.issues.map((issue) => issue.path.join('.') || '(файл)')
  return { ok: false, problem: 'invalid', fields: [...new Set(fields)].slice(0, 20) }
}

// ─── What a rate does to the platform's money ─────────────────────────────────

/** The prices of a model as a call is costed with them. */
export interface ModelPrices {
  inputPer1m: string
  cacheReadPer1m: string | null
  cacheWritePer1m: string | null
  outputPer1m: string
}

/** What the preview is counted from: the rate asked for and the state it would start in. */
export interface CreditRateState {
  effectiveFrom: Date
  /** The rate asked for. */
  rubPerCredit: string
  /** The rate in force at `effectiveFrom` before the new row; null for the first row ever. */
  previous: { rubPerCredit: string; effectiveFrom: Date } | null
  /** The tariffs and packs on sale or held by a live subscription. */
  plans: readonly {
    slug: string
    kind: 'quota' | 'pack'
    /** RUB, two decimals. */
    price: string
    /** Credits a month of a tariff; credits of a pack. */
    credits: number
  }[]
  /** Σ balance of the pack accounts and of the gift accounts of all workspaces. */
  outstanding: { pack: number; gift: number }
  /** The enabled models with the prices in force at `effectiveFrom` once the rows are written. */
  models: readonly {
    provider: string
    model: string
    modelClass: ModelClass
    /** null: the model has no price at that moment and cannot run. */
    prices: ModelPrices | null
    /** The prices are of this approval. */
    listed: boolean
  }[]
}

export interface PlanExposure {
  slug: string
  kind: 'quota' | 'pack'
  price: string
  credits: number
  /** credits × K: the accounting cost behind the plan used in full, RUB, two decimals. */
  costRub: string
  /** costRub ÷ price in percent, one decimal; null for a plan that costs nothing. */
  sharePercent: string | null
}

export interface OutstandingCredits {
  credits: number
  /** credits × K, RUB, two decimals. */
  costRub: string
}

export interface StepCost {
  modelClass: keyof typeof attemptStepCredits
  credits: number
  /** step × K, RUB, two decimals. */
  costRub: string
  /** Above `TURN_KEY_LIMIT_RUB`: one key cannot hold the whole step. */
  aboveKeyLimit: boolean
}

export interface ModelCredits {
  provider: string
  model: string
  modelClass: ModelClass
  listed: boolean
  /** Credits per million tokens, two decimals; null for a model without a price. */
  creditsPer1m: { input: string; cacheRead: string; cacheWrite: string; output: string } | null
}

/** The numbers an approval is decided by — shown before anything is written. */
export interface CreditRatePreview {
  effectiveFrom: Date
  rubPerCredit: string
  previous: { rubPerCredit: string; effectiveFrom: Date } | null
  /** (K − previous) ÷ previous in percent, signed, two decimals; null for the first row. */
  movePercent: string | null
  plans: PlanExposure[]
  outstanding: { pack: OutstandingCredits; gift: OutstandingCredits }
  steps: StepCost[]
  models: ModelCredits[]
  /**
   * Classes whose enabled models would have different prices in force: the same request would
   * cost different credits by the pool's choice of account. Needs `confirmMixedModels`.
   */
  mixedClasses: ModelClass[]
  exposure: {
    /** Tariffs whose credits cost more than half of their price. */
    plans: string[]
    /** The rate moves by more than a tenth of the rate in force. */
    move: boolean
    /** Either of the two: the approval needs `confirmExposure`. */
    confirmationNeeded: boolean
  }
}

const rub = (amount: InstanceType<typeof Money>) => amount.toFixed(2)

/** The prices as a call is costed: a cache price that is not set is the input price. */
const effectivePrices = (prices: ModelPrices): string[] =>
  [
    prices.inputPer1m,
    prices.cacheReadPer1m ?? prices.inputPer1m,
    prices.cacheWritePer1m ?? prices.inputPer1m,
    prices.outputPer1m,
  ].map((price) => new Money(price).toFixed(6))

/**
 * What a credit rate means for the platform, from the state it would start in. Pure: the
 * database is read by `approveCreditRate`. Shares and the move are compared exactly, before
 * they are rounded for the eye.
 */
export function creditRatePreview(state: CreditRateState): CreditRatePreview {
  const rate = new Money(state.rubPerCredit)
  const costOf = (credits: number) => rate.mul(credits)

  const plans = state.plans.map((plan): PlanExposure & { over: boolean } => {
    const cost = costOf(plan.credits)
    const price = new Money(plan.price)
    const share = price.isZero() ? null : cost.div(price)
    return {
      ...plan,
      costRub: rub(cost),
      sharePercent: share === null ? null : share.mul(100).toFixed(1),
      // A plan given away has no price to hold its cost: it always asks for the confirmation.
      over: share === null ? cost.gt(0) : share.gt(EXPOSURE_SHARE_LIMIT),
    }
  })
  const overLimit = plans.filter((plan) => plan.kind === 'quota' && plan.over).map((p) => p.slug)

  const move =
    state.previous === null
      ? null
      : rate.minus(state.previous.rubPerCredit).div(state.previous.rubPerCredit)
  const moves = move !== null && move.abs().gt(RATE_MOVE_LIMIT)

  const models = state.models.map(({ prices, ...model }): ModelCredits => {
    if (prices === null) return { ...model, creditsPer1m: null }
    const [input, cacheRead, cacheWrite, output] = effectivePrices(prices).map((price) =>
      new Money(price).div(rate).toFixed(2),
    ) as [string, string, string, string]
    return { ...model, creditsPer1m: { input, cacheRead, cacheWrite, output } }
  })
  const pricesByClass = new Map<ModelClass, Set<string>>()
  for (const { modelClass, prices } of state.models) {
    if (prices === null) continue
    const seen = pricesByClass.get(modelClass) ?? new Set<string>()
    seen.add(effectivePrices(prices).join('/'))
    pricesByClass.set(modelClass, seen)
  }

  return {
    effectiveFrom: state.effectiveFrom,
    rubPerCredit: rate.toFixed(6),
    previous: state.previous,
    movePercent:
      move === null ? null : `${move.isNegative() ? '' : '+'}${move.mul(100).toFixed(2)}`,
    plans: plans.map(({ over: _, ...plan }) => plan),
    outstanding: {
      pack: { credits: state.outstanding.pack, costRub: rub(costOf(state.outstanding.pack)) },
      gift: { credits: state.outstanding.gift, costRub: rub(costOf(state.outstanding.gift)) },
    },
    steps: (Object.keys(attemptStepCredits) as (keyof typeof attemptStepCredits)[]).map(
      (modelClass) => {
        const cost = costOf(attemptStepCredits[modelClass])
        return {
          modelClass,
          credits: attemptStepCredits[modelClass],
          costRub: rub(cost),
          aboveKeyLimit: cost.gt(TURN_KEY_LIMIT_RUB),
        }
      },
    ),
    models,
    mixedClasses: [...pricesByClass].filter(([, seen]) => seen.size > 1).map(([name]) => name),
    exposure: {
      plans: overLimit,
      move: moves,
      confirmationNeeded: overLimit.length > 0 || moves,
    },
  }
}

// ─── The approval ─────────────────────────────────────────────────────────────

/**
 * Why an approval wrote nothing. Unknown models are told first and alone — all of them, before
 * anything is counted; once every listed model is found, every reason that holds is told, not
 * only the first.
 */
export type CreditRateRefusal =
  /** A listed price names a model the catalogue does not have. */
  | { reason: 'unknown_model'; provider: string; model: string }
  /** The instant asked for is earlier than the clock of the database. */
  | { reason: 'instant_past'; now: Date }
  /** The instant is not later than the newest row of rates or of prices that exists. */
  | { reason: 'instant_not_newest'; newest: Date; table: 'credit_rates' | 'llm_model_prices' }
  /**
   * An enabled model has a price row that starts after the instant: once it is in force the
   * rate would be older than it, and no credit could be reserved.
   */
  | { reason: 'enabled_model_price_newer'; provider: string; model: string; priceFrom: Date }
  /** `preview.exposure.confirmationNeeded` without `confirmExposure`. */
  | { reason: 'exposure_unconfirmed' }
  /** `preview.mixedClasses` without `confirmMixedModels`. */
  | { reason: 'mixed_models_unconfirmed'; classes: ModelClass[] }

export type CreditRateApproval =
  | {
      approved: true
      preview: CreditRatePreview
      rateId: string
      /** The one instant of the rate row and of every price row written with it. */
      effectiveFrom: Date
      /** How many price rows were written. */
      prices: number
    }
  /** Nothing was written. `preview` is null when a listed model is unknown. */
  | { approved: false; preview: CreditRatePreview | null; refusals: CreditRateRefusal[] }

// A JavaScript date holds whole milliseconds, which is what `credit_rates.effective_from` takes.
const instantSchema = z.date().refine((value) => Number.isFinite(value.getTime()))

const approvalSchema = z.strictObject({
  rates: creditRatesSchema,
  /** When the rows start. Absent: the clock of the database at the moment of the approval. */
  effectiveFrom: instantSchema.optional(),
  /** The owner has seen the exposure and the move of the rate and approves them. */
  confirmExposure: z.boolean().default(false),
  /** The owner approves different prices for the enabled models of one class. */
  confirmMixedModels: z.boolean().default(false),
  ...operatorActionSchema.shape,
})
export type CreditRateApprovalInput = z.input<typeof approvalSchema>

export interface CreditRateApprovalHooks {
  /**
   * Called once with the numbers of the approval before anything is written — also when the
   * approval is then refused. What it throws stops the approval with nothing written.
   */
  preview?: (preview: CreditRatePreview) => void
}

type ApprovalTx = Pick<
  BillingTx,
  | '$executeRaw'
  | '$queryRaw'
  | 'creditRate'
  | 'llmModel'
  | 'llmModelPrice'
  | 'plan'
  | 'billingAccount'
  | 'auditLog'
>

const wholeCredits = (sum: { toFixed(): string } | null): number => Number(sum?.toFixed() ?? 0)

const priceColumns = {
  effectiveFrom: true,
  inputPer1m: true,
  cacheReadPer1m: true,
  cacheWritePer1m: true,
  outputPer1m: true,
} as const

interface StoredPrice {
  inputPer1m: { toFixed(digits: number): string }
  cacheReadPer1m: { toFixed(digits: number): string } | null
  cacheWritePer1m: { toFixed(digits: number): string } | null
  outputPer1m: { toFixed(digits: number): string }
}

const storedPrices = (row: StoredPrice): ModelPrices => ({
  inputPer1m: row.inputPer1m.toFixed(6),
  cacheReadPer1m: row.cacheReadPer1m?.toFixed(6) ?? null,
  cacheWritePer1m: row.cacheWritePer1m?.toFixed(6) ?? null,
  outputPer1m: row.outputPer1m.toFixed(6),
})

/**
 * `approveCreditRate` inside the transaction of its caller. The product calls the function
 * below, which opens the transaction; this one is exported for the tests, which roll theirs
 * back.
 */
export async function approveCreditRateIn(
  tx: ApprovalTx,
  input: CreditRateApprovalInput,
  hooks: CreditRateApprovalHooks = {},
): Promise<CreditRateApproval> {
  const request = approvalSchema.parse(input)
  const { rates } = request

  // One approval at a time: the second one sees the rows of the first. Readers are not held up.
  await tx.$executeRaw`LOCK TABLE credit_rates IN SHARE ROW EXCLUSIVE MODE`
  const [clock] = await tx.$queryRaw<{ now: Date }[]>`
    SELECT date_trunc('milliseconds', clock_timestamp()) AS now
  `
  if (clock === undefined) throw new Error('The database gave no clock')
  const effectiveFrom = request.effectiveFrom ?? clock.now

  // The listed prices, each with the model it is of.
  const listed: { modelId: string; sourceUrl: string; vatRate: string; prices: ModelPrices }[] = []
  const unknown: CreditRateRefusal[] = []
  for (const { provider, model, sourceUrl, vatRate, ...prices } of rates.prices) {
    const found = await tx.llmModel.findFirst({
      where: { slug: model, provider: { slug: provider } },
      select: { id: true },
    })
    if (found === null) unknown.push({ reason: 'unknown_model', provider, model })
    else listed.push({ modelId: found.id, sourceUrl, vatRate, prices })
  }
  if (unknown.length > 0) return { approved: false, preview: null, refusals: unknown }

  const refusals: CreditRateRefusal[] = []
  if (effectiveFrom.getTime() < clock.now.getTime()) {
    refusals.push({ reason: 'instant_past', now: clock.now })
  }
  // The history of both tables is one line: a new row starts after every row that exists.
  const newestRate = await tx.creditRate.findFirst({
    orderBy: { effectiveFrom: 'desc' },
    select: { effectiveFrom: true },
  })
  const newestPrice = await tx.llmModelPrice.findFirst({
    orderBy: { effectiveFrom: 'desc' },
    select: { effectiveFrom: true },
  })
  const newest = [
    { table: 'credit_rates' as const, row: newestRate },
    { table: 'llm_model_prices' as const, row: newestPrice },
  ]
    .flatMap(({ table, row }) => (row === null ? [] : [{ table, at: row.effectiveFrom }]))
    .sort((a, b) => b.at.getTime() - a.at.getTime())[0]
  if (newest !== undefined && newest.at.getTime() >= effectiveFrom.getTime()) {
    refusals.push({ reason: 'instant_not_newest', newest: newest.at, table: newest.table })
  }

  const enabled = await tx.llmModel.findMany({
    where: { enabled: true },
    orderBy: [{ modelClass: 'asc' }, { slug: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      slug: true,
      modelClass: true,
      provider: { select: { slug: true } },
      prices: { orderBy: { effectiveFrom: 'desc' }, select: priceColumns },
    },
  })
  for (const model of enabled) {
    const [last] = model.prices
    // The rate must cover the newest price row of every enabled model, in force or not yet.
    if (last !== undefined && !creditRateCoversPrice(effectiveFrom, last.effectiveFrom)) {
      refusals.push({
        reason: 'enabled_model_price_newer',
        provider: model.provider.slug,
        model: model.slug,
        priceFrom: last.effectiveFrom,
      })
    }
  }

  const plans = await tx.plan.findMany({
    where: {
      kind: { in: ['quota', 'pack'] },
      OR: [
        { isActive: true },
        { subscriptions: { some: { status: { in: [...liveSubscriptionStatuses] } } } },
      ],
    },
    orderBy: [{ sortOrder: 'asc' }, { slug: 'asc' }],
    select: { slug: true, kind: true, price: true, creditsPerMonth: true, packCredits: true },
  })
  const balances = await tx.billingAccount.groupBy({
    by: ['unit'],
    where: { unit: { in: [creditAccountUnits.pack, creditAccountUnits.gift] } },
    _sum: { balance: true },
  })
  const outstanding = (unit: string) =>
    wholeCredits(balances.find((row) => row.unit === unit)?._sum.balance ?? null)
  const previous = await creditRateAt(tx, effectiveFrom)

  const preview = creditRatePreview({
    effectiveFrom,
    rubPerCredit: rates.rubPerCredit,
    previous:
      previous === null
        ? null
        : { rubPerCredit: previous.rubPerCredit, effectiveFrom: previous.effectiveFrom },
    plans: plans.flatMap((plan) => {
      const credits = plan.kind === 'pack' ? plan.packCredits : plan.creditsPerMonth
      if (plan.kind === 'payg' || credits === null) return []
      return [{ slug: plan.slug, kind: plan.kind, price: plan.price.toFixed(2), credits }]
    }),
    outstanding: {
      pack: outstanding(creditAccountUnits.pack),
      gift: outstanding(creditAccountUnits.gift),
    },
    models: enabled.map((model) => {
      const own = listed.find(({ modelId }) => modelId === model.id)
      // Once the rows are written, a listed model runs on its new prices; another one on its
      // newest row that has started by then.
      const inForce = model.prices.find(
        (price) => price.effectiveFrom.getTime() <= effectiveFrom.getTime(),
      )
      return {
        provider: model.provider.slug,
        model: model.slug,
        modelClass: model.modelClass,
        listed: own !== undefined,
        prices: own?.prices ?? (inForce === undefined ? null : storedPrices(inForce)),
      }
    }),
  })
  if (preview.exposure.confirmationNeeded && !request.confirmExposure) {
    refusals.push({ reason: 'exposure_unconfirmed' })
  }
  if (preview.mixedClasses.length > 0 && !request.confirmMixedModels) {
    refusals.push({ reason: 'mixed_models_unconfirmed', classes: preview.mixedClasses })
  }

  hooks.preview?.(preview)
  if (refusals.length > 0) return { approved: false, preview, refusals }

  await tx.llmModelPrice.createMany({
    data: listed.map(({ modelId, sourceUrl, vatRate, prices }) => ({
      modelId,
      effectiveFrom,
      ...prices,
      vatRate,
      sourceUrl,
    })),
  })
  const rate = await tx.creditRate.create({
    data: { effectiveFrom, rubPerCredit: rates.rubPerCredit, basis: rates.basis },
    select: { id: true },
  })
  await writeBillingAudit(tx, {
    actor: { type: 'operator', id: request.operator },
    action: creditRateAuditActions.approve,
    target: { type: 'credit_rate', id: rate.id },
    meta: {
      reason: request.reason,
      rubPerCredit: preview.rubPerCredit,
      previousRubPerCredit: preview.previous?.rubPerCredit ?? null,
      effectiveFrom: effectiveFrom.toISOString(),
      prices: listed.length,
      confirmExposure: request.confirmExposure,
      confirmMixedModels: request.confirmMixedModels,
    },
  })
  return { approved: true, preview, rateId: rate.id, effectiveFrom, prices: listed.length }
}

/**
 * Approves a credit rate, with or without new prices of the models: the listed price rows and
 * one row of `credit_rates` are written with one `effective_from` in one transaction, with one
 * entry of audit_log (`billing.credit_rate.approve`, the operator and the reason). The first
 * row ever is written the same way; no prices is a change of the rate alone.
 *
 * `effectiveFrom` is the clock of the database unless given; a later instant is allowed. Nothing
 * is written — and the answer says why — when:
 *   - a listed price names a model the catalogue does not have: every such model is told, and
 *     nothing else is looked at (the answer has no preview). Once the listed models are found,
 *     every reason below that holds is told at once:
 *   - the instant is earlier than the clock of the database;
 *   - the instant is not later than the newest row of rates or of prices that exists;
 *   - an enabled model has a price row that starts after the instant: the rate would be older
 *     than it, and that is the state in which no credit can be reserved;
 *   - a tariff's credits would cost more than half of its price, or the rate moves by more
 *     than a tenth of the rate in force, and `confirmExposure` is not given;
 *   - the enabled models of one class would have different prices in force, and
 *     `confirmMixedModels` is not given.
 *
 * `hooks.preview` gets the numbers before anything is written, refused or not. Prices without
 * a rate cannot be asked for: the input always carries the rate (`parseCreditRates` tells the
 * operator so). Nothing is seeded and nothing here runs by itself: approving a row is the
 * owner's act.
 */
export function approveCreditRate(
  deps: Pick<BillingDeps, 'prisma'>,
  input: CreditRateApprovalInput,
  hooks: CreditRateApprovalHooks = {},
): Promise<CreditRateApproval> {
  // Checked before the transaction opens: a malformed request never takes the lock.
  approvalSchema.parse(input)
  return deps.prisma.$transaction((tx) => approveCreditRateIn(tx, input, hooks), {
    isolationLevel: 'ReadCommitted',
  })
}
