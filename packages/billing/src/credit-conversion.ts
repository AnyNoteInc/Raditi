import type { Prisma } from '@repo/db'

import { creditRatePreview } from './credit-rate-approval.ts'
import { creditRateStatus } from './credit-rate.ts'
import { creditConversionSchema, type CreditConversionDto } from './dto.ts'

// The table of «Точный расчёт» on «Тарифы»: how much of a model's work one credit is. Read
// only; the numbers are those the operator saw when the rate was approved (`creditRatePreview`).

type Reader = Pick<Prisma.TransactionClient, 'creditRate' | 'llmModelPrice' | 'llmModel'>

/**
 * How the work of the models is turned into credits at `now`: credits per million tokens, the
 * prices in force of the enabled models divided by the credit rate, rounded to two decimals as
 * `creditRatePreview` rounds them. One row without a name when every enabled model that has a
 * price is costed by the same numbers; else a row per model, by its display name — a task on
 * another model is charged by other numbers than a single table states.
 *
 * null — the page shows no table — while no credit rate is usable (`creditRateStatus`: none is
 * in force, or a price in force of an enabled model started after it) and while no enabled
 * model has a price in force: nothing could be charged by a table then.
 */
export async function getCreditConversion(
  db: Reader,
  now: Date,
): Promise<CreditConversionDto | null> {
  const { verdict, rate } = await creditRateStatus(db, now)
  if (verdict !== 'usable' || rate === null) return null
  const models = await db.llmModel.findMany({
    where: { enabled: true },
    orderBy: [{ name: 'asc' }, { slug: 'asc' }, { id: 'asc' }],
    select: {
      name: true,
      slug: true,
      modelClass: true,
      provider: { select: { slug: true } },
      prices: {
        where: { effectiveFrom: { lte: now } },
        orderBy: { effectiveFrom: 'desc' },
        take: 1,
        select: {
          inputPer1m: true,
          cacheReadPer1m: true,
          cacheWritePer1m: true,
          outputPer1m: true,
        },
      },
    },
  })
  const priced = models.flatMap(({ prices: [price], ...model }) =>
    price === undefined ? [] : [{ ...model, price }],
  )
  const preview = creditRatePreview({
    effectiveFrom: rate.effectiveFrom,
    rubPerCredit: rate.rubPerCredit,
    previous: null,
    plans: [],
    outstanding: { pack: 0, gift: 0 },
    models: priced.map(({ slug, provider, modelClass, price }) => ({
      provider: provider.slug,
      model: slug,
      modelClass,
      listed: false,
      prices: {
        inputPer1m: price.inputPer1m.toFixed(6),
        cacheReadPer1m: price.cacheReadPer1m?.toFixed(6) ?? null,
        cacheWritePer1m: price.cacheWritePer1m?.toFixed(6) ?? null,
        outputPer1m: price.outputPer1m.toFixed(6),
      },
    })),
  })
  // The preview keeps the order it was given.
  const rows = preview.models.flatMap(({ creditsPer1m }, index) =>
    creditsPer1m === null ? [] : [{ model: priced[index]?.name ?? null, ...creditsPer1m }],
  )
  const [first] = rows
  if (first === undefined) return null
  const same = rows.every(
    (row) =>
      row.input === first.input &&
      row.cacheRead === first.cacheRead &&
      row.cacheWrite === first.cacheWrite &&
      row.output === first.output,
  )
  return creditConversionSchema.parse({ rows: same ? [{ ...first, model: null }] : rows })
}
