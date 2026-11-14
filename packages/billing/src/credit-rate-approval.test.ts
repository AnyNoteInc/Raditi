import { randomUUID } from 'node:crypto'

import { createPrismaClient, type Prisma, type PrismaClient } from '@repo/db'
import { creditAccountUnits, liveSubscriptionStatuses } from '@repo/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { getCreditConversion } from './credit-conversion.ts'
import { creditRateAt, creditRateStatus, taskRawCredits } from './credit-rate.ts'
import {
  approveCreditRateIn,
  creditRateAuditActions,
  creditRatePreview,
  parseCreditRates,
  type CreditRateApprovalInput,
  type CreditRatePreview,
  type CreditRates,
  type CreditRateState,
} from './credit-rate-approval.ts'
import {
  billingFixtures,
  inRolledBackTransaction,
  writeCreditRate,
  writeModelCall,
  writeModelPool,
  writeModelPrice,
  type TestModelPool,
} from './testing.ts'

type Tx = Prisma.TransactionClient

/** GPT-6 Sol at 4.65 RUB a Codex credit: 50, 5 and 250 Codex credits per million tokens. */
const SOL = {
  inputPer1m: '232.500000',
  cacheReadPer1m: '23.250000',
  cacheWritePer1m: null,
  outputPer1m: '1162.500000',
}
const SOURCE = { vatRate: '0.2200', sourceUrl: 'https://rates.example/2026-q4' }
const BASIS = 'Корзина выполненной работы на GPT-6 Sol по 4,65 ₽ за кредит Codex; утвердил владелец'

const file = (patch: Record<string, unknown> = {}) => ({
  rubPerCredit: '6.000000',
  basis: BASIS,
  prices: [{ provider: 'openai-chatgpt', model: 'gpt-6-sol-standard', ...SOL, ...SOURCE }],
  ...patch,
})

describe('a file of rates', () => {
  it('is read with the rate, its basis and the prices that start with it', () => {
    expect(parseCreditRates(file())).toEqual({ ok: true, rates: file() })
  })

  it('may change the rate alone', () => {
    expect(parseCreditRates(file({ prices: [] }))).toEqual({
      ok: true,
      rates: { rubPerCredit: '6.000000', basis: BASIS, prices: [] },
    })
  })

  it('is refused by its own name when it holds prices and no rate', () => {
    const { rubPerCredit: _, ...pricesOnly } = file()
    expect(parseCreditRates(pricesOnly)).toEqual({ ok: false, problem: 'prices_without_rate' })
    // Without prices the missing rate is one more field that does not pass.
    expect(parseCreditRates({ basis: BASIS, prices: [] })).toEqual({
      ok: false,
      problem: 'invalid',
      fields: ['rubPerCredit'],
    })
  })

  const price = (patch: Record<string, unknown>) =>
    file({ prices: [{ provider: 'p', model: 'm', ...SOL, ...SOURCE, ...patch }] })

  it.each([
    ['a rate of zero', file({ rubPerCredit: '0.000000' }), ['rubPerCredit']],
    ['a rate written as a number', file({ rubPerCredit: 6 }), ['rubPerCredit']],
    ['a rate with seven decimals', file({ rubPerCredit: '6.0000001' }), ['rubPerCredit']],
    ['a negative rate', file({ rubPerCredit: '-6' }), ['rubPerCredit']],
    ['a blank basis', file({ basis: '   ' }), ['basis']],
    ['a basis of several lines', file({ basis: 'корзина\nставки' }), ['basis']],
    ['a basis longer than its column', file({ basis: 'б'.repeat(1025) }), ['basis']],
    ['no list of prices', { rubPerCredit: '6', basis: BASIS }, ['prices']],
    ['an unknown field', file({ note: 'x' }), ['(файл)']],
    ['a price written as a number', price({ inputPer1m: 232.5 }), ['prices.0.inputPer1m']],
    ['a negative price', price({ outputPer1m: '-1' }), ['prices.0.outputPer1m']],
    ['a cache price left out', price({ cacheReadPer1m: undefined }), ['prices.0.cacheReadPer1m']],
    ['a VAT rate of one', price({ vatRate: '1.0000' }), ['prices.0.vatRate']],
    ['a VAT rate with five decimals', price({ vatRate: '0.22000' }), ['prices.0.vatRate']],
    ['a source that is not a link', price({ sourceUrl: 'rate card' }), ['prices.0.sourceUrl']],
    [
      'a source that is not http',
      price({ sourceUrl: 'ftp://rates.example' }),
      ['prices.0.sourceUrl'],
    ],
    ['a model slug with a space', price({ model: 'gpt 6' }), ['prices.0.model']],
    ['an unknown field of a price', price({ currency: 'RUB' }), ['prices.0']],
    [
      'a model priced twice',
      file({
        prices: [
          { provider: 'p', model: 'm', ...SOL, ...SOURCE },
          { provider: 'p', model: 'm', ...SOL, ...SOURCE, outputPer1m: '1' },
        ],
      }),
      ['(файл)'],
    ],
    ['a list in place of the file', [file()], ['(файл)']],
    ['nothing', null, ['(файл)']],
  ])('is refused with the fields that do not pass: %s', (_, value, fields) => {
    expect(parseCreditRates(value)).toEqual({ ok: false, problem: 'invalid', fields })
  })
})

describe('creditRatePreview', () => {
  const START = new Date('2026-10-11T09:00:00.000Z')
  /**
   * The tariffs and the pack of the seed: the pricing of 13.11.2026 (plan 72, ЦА1–ЦА3), the pack
   * of 06.11.2026 (plan 63, Ц4).
   */
  const PLANS = [
    { slug: 'start', kind: 'quota', price: '1990.00', credits: 200 },
    { slug: 'business', kind: 'quota', price: '9990.00', credits: 1000 },
    { slug: 'agency', kind: 'quota', price: '19990.00', credits: 2000 },
    { slug: 'pack', kind: 'pack', price: '1490.00', credits: 100 },
  ] as const
  const state = (patch: Partial<CreditRateState> = {}): CreditRateState => ({
    effectiveFrom: START,
    rubPerCredit: '6',
    previous: null,
    plans: PLANS,
    outstanding: { pack: 0, gift: 0 },
    models: [],
    ...patch,
  })
  const shares = (preview: CreditRatePreview) =>
    preview.plans.map((plan) => [plan.slug, plan.costRub, plan.sharePercent])

  it('counts the accounting cost behind every plan and its share of the price', () => {
    const preview = creditRatePreview(state())

    // At 6.00: 1 200, 6 000 and 12 000 RUB; 60.3, 60.1 and 60.0%; the pack 40.3%. The credits of
    // every tariff of 13.11.2026 cost more than half of its price at this rate.
    expect(shares(preview)).toEqual([
      ['start', '1200.00', '60.3'],
      ['business', '6000.00', '60.1'],
      ['agency', '12000.00', '60.0'],
      ['pack', '600.00', '40.3'],
    ])
    expect(preview).toMatchObject({
      effectiveFrom: START,
      rubPerCredit: '6.000000',
      previous: null,
      movePercent: null,
      exposure: { plans: ['start', 'business', 'agency'], move: false, confirmationNeeded: true },
    })
  })

  it.each([
    // Half of the price is reached at 4.975 for «Старт», 4.995 for «Бизнес», 4.9975 for
    // «Агентство».
    ['4.975', []],
    ['4.975001', ['start']],
    ['4.995', ['start']],
    ['4.995001', ['start', 'business']],
    ['4.9975', ['start', 'business']],
    ['4.997501', ['start', 'business', 'agency']],
  ])('asks for a confirmation above half of a tariff price: K = %s', (rubPerCredit, over) => {
    const { exposure } = creditRatePreview(state({ rubPerCredit }))
    expect(exposure).toEqual({ plans: over, move: false, confirmationNeeded: over.length > 0 })
  })

  it('compares the share before it is rounded for the eye', () => {
    const [plan] = creditRatePreview(
      state({
        rubPerCredit: '5.004',
        plans: [{ slug: 'edge', kind: 'quota', price: '1000.00', credits: 100 }],
      }),
    ).plans
    // 50.04% reads «50.0» and is above half all the same.
    expect(plan).toMatchObject({ costRub: '500.40', sharePercent: '50.0' })
    expect(
      creditRatePreview(
        state({
          rubPerCredit: '5.004',
          plans: [{ slug: 'edge', kind: 'quota', price: '1000.00', credits: 100 }],
        }),
      ).exposure.plans,
    ).toEqual(['edge'])
  })

  it('does not ask for a pack, and always asks for a tariff that costs nothing', () => {
    const preview = creditRatePreview(
      state({
        plans: [
          { slug: 'dear-pack', kind: 'pack', price: '1000.00', credits: 100 },
          { slug: 'free', kind: 'quota', price: '0.00', credits: 10 },
        ],
      }),
    )
    expect(shares(preview)).toEqual([
      ['dear-pack', '600.00', '60.0'],
      ['free', '60.00', null],
    ])
    expect(preview.exposure.plans).toEqual(['free'])
  })

  it.each([
    ['6.6', '+10.00', false],
    ['6.600001', '+10.00', true],
    ['6.61', '+10.17', true],
    ['5.4', '-10.00', false],
    ['5.399999', '-10.00', true],
    ['5', '-16.67', true],
    ['6', '+0.00', false],
  ])(
    'asks for a confirmation when the rate moves by more than a tenth: %s',
    (k, percent, moves) => {
      const previous = { rubPerCredit: '6.000000', effectiveFrom: new Date('2026-07-01T00:00:00Z') }
      const preview = creditRatePreview(state({ rubPerCredit: k, previous, plans: [] }))
      expect(preview.movePercent).toBe(percent)
      expect(preview.previous).toEqual(previous)
      expect(preview.exposure).toEqual({ plans: [], move: moves, confirmationNeeded: moves })
    },
  )

  it('values the pack and gift credits that are not spent', () => {
    const preview = creditRatePreview(state({ outstanding: { pack: 1_240, gift: 385 } }))
    expect(preview.outstanding).toEqual({
      pack: { credits: 1_240, costRub: '7440.00' },
      gift: { credits: 385, costRub: '2310.00' },
    })
  })

  it('tells nothing of a limit of a pass: only the credits of the customer bound it (КР6)', () => {
    expect(creditRatePreview(state())).not.toHaveProperty('keyLimit')
    expect(creditRatePreview(state())).not.toHaveProperty('steps')
  })

  const model = (name: string, modelClass: 'light' | 'standard' | 'heavy', prices: object | null) =>
    ({ provider: 'openai-chatgpt', model: name, modelClass, listed: true, prices }) as never

  it('prints credits per million tokens for every enabled model', () => {
    const preview = creditRatePreview(
      state({
        models: [
          model('sol', 'standard', SOL),
          model('unpriced', 'heavy', null),
          model('luna', 'light', {
            inputPer1m: '11.625',
            cacheReadPer1m: '1.1625',
            cacheWritePer1m: '14.53125',
            outputPer1m: '58.125',
          }),
        ],
      }),
    )
    expect(preview.models).toEqual([
      {
        provider: 'openai-chatgpt',
        model: 'sol',
        modelClass: 'standard',
        listed: true,
        // 232.5, 23.25 and 1 162.5 RUB ÷ 6.00; a write to the cache at the input price.
        creditsPer1m: { input: '38.75', cacheRead: '3.88', cacheWrite: '38.75', output: '193.75' },
      },
      {
        provider: 'openai-chatgpt',
        model: 'unpriced',
        modelClass: 'heavy',
        listed: true,
        creditsPer1m: null,
      },
      {
        provider: 'openai-chatgpt',
        model: 'luna',
        modelClass: 'light',
        listed: true,
        creditsPer1m: { input: '1.94', cacheRead: '0.19', cacheWrite: '2.42', output: '9.69' },
      },
    ])
    expect(preview.mixedClasses).toEqual([])
  })

  it('names the classes whose enabled models would have different prices', () => {
    const dearer = { ...SOL, outputPer1m: '1162.500001' }
    const mixed = (models: CreditRateState['models']) =>
      creditRatePreview(state({ models })).mixedClasses

    expect(mixed([model('a', 'standard', SOL), model('b', 'standard', dearer)])).toEqual([
      'standard',
    ])
    // Equal prices, however they are written; a cache price left out is the input price.
    expect(
      mixed([
        model('a', 'standard', SOL),
        model('b', 'standard', { ...SOL, inputPer1m: '232.5', cacheWritePer1m: '232.500000' }),
      ]),
    ).toEqual([])
    // Different classes are different profiles; a model without a price runs nothing.
    expect(
      mixed([
        model('a', 'standard', SOL),
        model('b', 'heavy', dearer),
        model('c', 'standard', null),
      ]),
    ).toEqual([])
    expect(
      mixed([
        model('a', 'light', SOL),
        model('b', 'light', dearer),
        model('c', 'heavy', SOL),
        model('d', 'heavy', dearer),
        model('e', 'standard', SOL),
      ]),
    ).toEqual(['light', 'heavy'])
  })
})

// On a disposable database only (`pnpm verify:db` sets the flag): an approval reads the whole
// catalogue — every enabled model, the newest price row of any model, every plan on sale — and
// the cases below state what it finds there. Nothing is committed: each case runs in a
// transaction that is rolled back, so the rate of the database is never written.
const databaseUrl = process.env.DATABASE_URL
const disposable = Boolean(databaseUrl && process.env.RADITI_GATEWAY_DB_TESTS === '1')

describe.skipIf(!disposable)('approving a credit rate with PostgreSQL', () => {
  let db: PrismaClient
  /** The tariffs the seed puts on sale. */
  const SEEDED_TARIFFS = ['start', 'business', 'agency']

  beforeAll(async () => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
    // What the cases stand on: a catalogue nobody has switched on, no rate, and the tariffs of
    // the seed held by no subscription — off sale they are outside the exposure.
    expect(await db.llmModel.count({ where: { enabled: true } })).toBe(0)
    expect(await db.creditRate.count()).toBe(0)
    expect(
      await db.subscription.count({
        where: {
          plan: { slug: { in: SEEDED_TARIFFS } },
          status: { in: [...liveSubscriptionStatuses] },
        },
      }),
    ).toBe(0)
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  // At 6.00 the credits of «Старт», «Бизнес» and «Агентство» of 13.11.2026 cost more than half of
  // their price — 60.3, 60.1 and 60.0% —, so on sale they ask every approval at that rate for a
  // confirmation. A case sees them off sale, in its own transaction, unless it is about them
  // (`asSeeded`).
  const rolledBack = <T>(work: (tx: Tx) => Promise<T>) =>
    inRolledBackTransaction(db, async (tx) => {
      await tx.plan.updateMany({
        where: { slug: { in: SEEDED_TARIFFS } },
        data: { isActive: false },
      })
      return work(tx)
    })
  const asSeeded = <T>(work: (tx: Tx) => Promise<T>) => inRolledBackTransaction(db, work)
  const HOUR = 3_600_000
  const fromNow = (ms: number) => new Date(Date.now() + ms)

  const priced = (pool: TestModelPool, patch: Record<string, unknown> = {}) => ({
    provider: pool.provider,
    model: pool.model,
    ...SOL,
    ...SOURCE,
    ...patch,
  })
  const request = (
    rates: Partial<CreditRates> = {},
    patch: Partial<CreditRateApprovalInput> = {},
  ): CreditRateApprovalInput => ({
    rates: { rubPerCredit: '6.000000', basis: BASIS, prices: [], ...rates },
    operator: 'owner',
    reason: 'Ставки на четвёртый квартал',
    ...patch,
  })
  /** What an approval may have written, as the transaction sees it. */
  const written = async (tx: Tx, pools: TestModelPool[] = []) => ({
    rates: await tx.creditRate.count(),
    prices: await tx.llmModelPrice.count({
      where: { modelId: { in: pools.map((pool) => pool.modelId) } },
    }),
    audit: await tx.auditLog.count({ where: { action: creditRateAuditActions.approve } }),
  })

  it('writes the listed prices and the rate with one instant, the first row ever', async () => {
    await rolledBack(async (tx) => {
      const sol = await writeModelPool(tx, { enabled: true })
      const luna = await writeModelPool(tx, { enabled: true, modelClass: 'light' })
      const before = Date.now()

      const approval = await approveCreditRateIn(
        tx,
        request({
          prices: [
            priced(sol),
            priced(luna, {
              inputPer1m: '11.625',
              cacheReadPer1m: null,
              cacheWritePer1m: '14.53125',
              outputPer1m: '58.125',
              vatRate: '0.2',
              sourceUrl: 'https://rates.example/luna',
            }),
          ],
        }),
      )

      if (!approval.approved) throw new Error('The first rate must be approved')
      expect(approval.prices).toBe(2)
      // The clock of the database, in whole milliseconds.
      expect(approval.effectiveFrom.getTime()).toBeGreaterThanOrEqual(before - 5_000)
      expect(approval.effectiveFrom.getTime()).toBeLessThanOrEqual(Date.now() + 5_000)
      expect(approval.preview).toMatchObject({ previous: null, movePercent: null })

      const rate = await tx.creditRate.findUniqueOrThrow({ where: { id: approval.rateId } })
      expect(rate).toMatchObject({ effectiveFrom: approval.effectiveFrom, basis: BASIS })
      expect(rate.rubPerCredit.toFixed(6)).toBe('6.000000')
      const prices = await tx.llmModelPrice.findMany({
        where: { modelId: { in: [sol.modelId, luna.modelId] } },
        orderBy: { inputPer1m: 'desc' },
      })
      // One instant for every row: the rate is not older than a price it converts.
      expect(prices.map((row) => row.effectiveFrom)).toEqual([
        approval.effectiveFrom,
        approval.effectiveFrom,
      ])
      // And one instant in SQL, where a timestamp has microseconds a JavaScript date drops:
      // `llm_model_prices` has no CHECK of whole milliseconds, the rows get theirs from here.
      const [same] = await tx.$queryRaw<{ rows: number }[]>`
        SELECT COUNT(*)::int AS rows
        FROM llm_model_prices p
        JOIN credit_rates c ON c.id = ${approval.rateId}::uuid
        WHERE p.model_id = ANY(${[sol.modelId, luna.modelId]}::uuid[])
          AND p.effective_from = c.effective_from
          AND p.effective_from = date_trunc('milliseconds', p.effective_from)
      `
      expect(same?.rows).toBe(2)
      expect(
        prices.map((row) => [
          row.modelId,
          row.inputPer1m.toFixed(6),
          row.cacheReadPer1m?.toFixed(6) ?? null,
          row.cacheWritePer1m?.toFixed(6) ?? null,
          row.outputPer1m.toFixed(6),
          row.vatRate.toFixed(4),
          row.sourceUrl,
        ]),
      ).toEqual([
        [sol.modelId, '232.500000', '23.250000', null, '1162.500000', '0.2200', SOURCE.sourceUrl],
        [
          luna.modelId,
          '11.625000',
          null,
          '14.531250',
          '58.125000',
          '0.2000',
          'https://rates.example/luna',
        ],
      ])

      // Credits can be reserved from that instant on, and a call costed with the new price at
      // that very instant is converted.
      expect(await creditRateStatus(tx, approval.effectiveFrom)).toMatchObject({
        verdict: 'usable',
        rate: { id: approval.rateId },
      })
      const workspace = await tx.workspace.create({ data: { name: 'Rate verification' } })
      const site = await tx.site.create({
        data: {
          workspaceId: workspace.id,
          name: 'Rate verification',
          url: `https://${randomUUID()}.example.ru`,
          stack: 'wordpress',
        },
      })
      const task = await tx.task.create({ data: { workspaceId: workspace.id, siteId: site.id } })
      await writeModelCall(tx, {
        taskId: task.id,
        pool: sol,
        priceId: prices[0]!.id,
        costRub: '101.37',
        occurredAt: approval.effectiveFrom,
      })
      const raw = await taskRawCredits(tx, { taskId: task.id, attempts: [1] })
      expect(raw.convertible && raw.credits.toFixed(3)).toBe('16.895')
    })
  })

  it('writes one audit entry that names the operator, the reason and no workspace', async () => {
    await rolledBack(async (tx) => {
      const sol = await writeModelPool(tx, { enabled: true })
      const approval = await approveCreditRateIn(tx, request({ prices: [priced(sol)] }))
      if (!approval.approved) throw new Error('The rate must be approved')

      expect(
        await tx.auditLog.findMany({ where: { action: creditRateAuditActions.approve } }),
      ).toMatchObject([
        {
          actorType: 'operator',
          actorId: 'owner',
          workspaceId: null,
          action: 'billing.credit_rate.approve',
          targetType: 'credit_rate',
          targetId: approval.rateId,
          meta: {
            reason: 'Ставки на четвёртый квартал',
            rubPerCredit: '6.000000',
            previousRubPerCredit: null,
            effectiveFrom: approval.effectiveFrom.toISOString(),
            prices: 1,
            confirmExposure: false,
            confirmMixedModels: false,
          },
          ip: null,
        },
      ])
    })
  })

  it('hands over the numbers before it writes, and writes nothing when that fails', async () => {
    await rolledBack(async (tx) => {
      const sol = await writeModelPool(tx, { enabled: true })
      const seen: CreditRatePreview[] = []

      await expect(
        approveCreditRateIn(tx, request({ prices: [priced(sol)] }), {
          preview: (preview) => {
            seen.push(preview)
            throw new Error('the terminal is gone')
          },
        }),
      ).rejects.toThrow('the terminal is gone')

      expect(seen).toHaveLength(1)
      expect(seen[0]?.models).toEqual([
        {
          provider: sol.provider,
          model: sol.model,
          modelClass: 'standard',
          listed: true,
          creditsPer1m: {
            input: '38.75',
            cacheRead: '3.88',
            cacheWrite: '38.75',
            output: '193.75',
          },
        },
      ])
      expect(await written(tx, [sol])).toEqual({ rates: 0, prices: 0, audit: 0 })
    })
  })

  it('takes a later instant, and the rate is not in force before it', async () => {
    await rolledBack(async (tx) => {
      const sol = await writeModelPool(tx, { enabled: true })
      const later = fromNow(24 * HOUR)

      const approval = await approveCreditRateIn(
        tx,
        request({ prices: [priced(sol)] }, { effectiveFrom: later }),
      )

      expect(approval).toMatchObject({ approved: true, effectiveFrom: later, prices: 1 })
      expect(await creditRateAt(tx, fromNow(23 * HOUR))).toBeNull()
      expect(await creditRateAt(tx, later)).toMatchObject({ rubPerCredit: '6.000000' })
      const [price] = await tx.llmModelPrice.findMany({ where: { modelId: sol.modelId } })
      expect(price?.effectiveFrom).toEqual(later)
    })
  })

  it('refuses an instant in the past', async () => {
    await rolledBack(async (tx) => {
      const sol = await writeModelPool(tx, { enabled: true })
      const seen: CreditRatePreview[] = []

      const approval = await approveCreditRateIn(
        tx,
        request({ prices: [priced(sol)] }, { effectiveFrom: fromNow(-60_000) }),
        { preview: (preview) => void seen.push(preview) },
      )

      expect(approval).toMatchObject({ approved: false, refusals: [{ reason: 'instant_past' }] })
      // The numbers are shown all the same: the operator sees what was asked for.
      expect(seen).toHaveLength(1)
      expect(await written(tx, [sol])).toEqual({ rates: 0, prices: 0, audit: 0 })
    })
  })

  it('refuses an instant that is not later than the newest rate', async () => {
    await rolledBack(async (tx) => {
      const scheduled = fromNow(HOUR)
      scheduled.setMilliseconds(0)
      await writeCreditRate(tx, { effectiveFrom: scheduled })
      const refused = {
        approved: false,
        refusals: [{ reason: 'instant_not_newest', newest: scheduled, table: 'credit_rates' }],
      }

      // The clock of the database is before a rate that is scheduled.
      expect(await approveCreditRateIn(tx, request())).toMatchObject(refused)
      expect(
        await approveCreditRateIn(tx, request({}, { effectiveFrom: scheduled })),
      ).toMatchObject(refused)
      expect(await written(tx)).toEqual({ rates: 1, prices: 0, audit: 0 })

      // A millisecond later the history is one line again.
      const next = new Date(scheduled.getTime() + 1)
      expect(await approveCreditRateIn(tx, request({}, { effectiveFrom: next }))).toMatchObject({
        approved: true,
        effectiveFrom: next,
      })
    })
  })

  it('refuses an instant that is not later than the newest price of any model', async () => {
    await rolledBack(async (tx) => {
      // A model nobody has switched on: its price is history all the same.
      const off = await writeModelPool(tx)
      const scheduled = fromNow(HOUR)
      await writeModelPrice(tx, off, { effectiveFrom: scheduled })

      const approval = await approveCreditRateIn(tx, request({}, { effectiveFrom: scheduled }))

      expect(approval).toMatchObject({
        approved: false,
        refusals: [{ reason: 'instant_not_newest', newest: scheduled, table: 'llm_model_prices' }],
      })
      expect(await written(tx)).toEqual({ rates: 0, prices: 0, audit: 0 })
    })
  })

  it('refuses a rate that would be older than the newest price of an enabled model', async () => {
    await rolledBack(async (tx) => {
      const sol = await writeModelPool(tx, { enabled: true })
      const scheduled = fromNow(HOUR)
      await writeModelPrice(tx, sol, { effectiveFrom: scheduled })

      // The rate would start now and the price of the model an hour later: from then on no
      // credit could be reserved.
      const approval = await approveCreditRateIn(tx, request())

      if (approval.approved) throw new Error('The rate must be refused')
      expect(approval.refusals).toEqual([
        { reason: 'instant_not_newest', newest: scheduled, table: 'llm_model_prices' },
        {
          reason: 'enabled_model_price_newer',
          provider: sol.provider,
          model: sol.model,
          priceFrom: scheduled,
        },
      ])
      expect(await written(tx)).toEqual({ rates: 0, prices: 0, audit: 0 })
    })
  })

  // The tariffs of the seed stay on sale: at 9.00 their exposure is what asks for a confirmation.
  it('refuses a price of a model the catalogue does not have, before anything is counted', async () => {
    await asSeeded(async (tx) => {
      const sol = await writeModelPool(tx, { enabled: true })
      const seen: CreditRatePreview[] = []

      const approval = await approveCreditRateIn(
        tx,
        request({
          prices: [
            priced(sol),
            // The slug of the model under another provider, and a model that is not there.
            priced(sol, { provider: 'openai-chatgpt' }),
            priced(sol, { model: 'gpt-7' }),
          ],
        }),
        { preview: (preview) => void seen.push(preview) },
      )

      expect(approval).toEqual({
        approved: false,
        preview: null,
        refusals: [
          { reason: 'unknown_model', provider: 'openai-chatgpt', model: sol.model },
          { reason: 'unknown_model', provider: sol.provider, model: 'gpt-7' },
        ],
      })
      expect(seen).toEqual([])
      expect(await written(tx, [sol])).toEqual({ rates: 0, prices: 0, audit: 0 })

      // First and alone, whatever else is wrong with the request: a start in the past and a
      // rate that needs a confirmation are told only once every listed model is found.
      const wrong = { rubPerCredit: '9.000000', prices: [priced(sol, { model: 'gpt-7' })] }
      const past = { effectiveFrom: fromNow(-HOUR) }
      expect(await approveCreditRateIn(tx, request(wrong, past))).toEqual({
        approved: false,
        preview: null,
        refusals: [{ reason: 'unknown_model', provider: sol.provider, model: 'gpt-7' }],
      })
      const found = await approveCreditRateIn(
        tx,
        request({ ...wrong, prices: [priced(sol)] }, past),
      )
      if (found.approved) throw new Error('The rate must be refused')
      expect(found.refusals.map(({ reason }) => reason)).toEqual([
        'instant_past',
        'exposure_unconfirmed',
      ])
      expect(await written(tx, [sol])).toEqual({ rates: 0, prices: 0, audit: 0 })
    })
  })

  describe('the exposure', () => {
    /** A tariff of 100 credits for 1 000 RUB: at 6.00 its credits cost 60% of its price. */
    const dearTariff = (tx: Tx, data: Partial<Prisma.PlanUncheckedCreateInput> = {}) =>
      tx.plan.create({
        data: {
          slug: `rate-test-${randomUUID()}`,
          name: 'Проверочный',
          kind: 'quota',
          price: '1000.00',
          creditsPerMonth: 100,
          maxSites: 1,
          isActive: true,
          ...data,
        },
      })

    it('needs a confirmation when a tariff on sale would cost more than half of its price', async () => {
      await rolledBack(async (tx) => {
        const plan = await dearTariff(tx)

        const refused = await approveCreditRateIn(tx, request())

        expect(refused).toMatchObject({
          approved: false,
          refusals: [{ reason: 'exposure_unconfirmed' }],
          preview: { exposure: { plans: [plan.slug], move: false, confirmationNeeded: true } },
        })
        expect(refused.preview?.plans.find(({ slug }) => slug === plan.slug)).toEqual({
          slug: plan.slug,
          kind: 'quota',
          price: '1000.00',
          credits: 100,
          costRub: '600.00',
          sharePercent: '60.0',
        })
        expect(await written(tx)).toEqual({ rates: 0, prices: 0, audit: 0 })

        const approved = await approveCreditRateIn(tx, request({}, { confirmExposure: true }))
        expect(approved.approved).toBe(true)
        expect(
          await tx.auditLog.findMany({ where: { action: creditRateAuditActions.approve } }),
        ).toMatchObject([{ meta: { confirmExposure: true, confirmMixedModels: false } }])
      })
    })

    it('counts a tariff that is off sale while somebody still has it', async () => {
      await rolledBack(async (tx) => {
        const plan = await dearTariff(tx, { isActive: false })
        // Off sale and held by nobody: not the platform's exposure.
        expect((await approveCreditRateIn(tx, request())).approved).toBe(true)

        const workspace = await tx.workspace.create({ data: { name: 'Rate verification' } })
        const start = fromNow(-HOUR)
        await tx.subscription.create({
          data: {
            workspaceId: workspace.id,
            planId: plan.id,
            status: 'active',
            currentPeriodStart: start,
            currentPeriodEnd: fromNow(30 * 24 * HOUR),
            periodAnchor: start,
          },
        })
        const again = await approveCreditRateIn(
          tx,
          request({ rubPerCredit: '6.100000' }, { effectiveFrom: fromNow(HOUR) }),
        )
        expect(again).toMatchObject({
          approved: false,
          refusals: [{ reason: 'exposure_unconfirmed' }],
          preview: { exposure: { plans: [plan.slug] } },
        })
      })
    })

    // The pricing of 13.11.2026 (plan 72): at 6.00 the operator confirms the exposure of every
    // tariff.
    it('shows the plans of the seed at their shares and asks a confirmation for those above half', async () => {
      await asSeeded(async (tx) => {
        const refused = await approveCreditRateIn(tx, request())

        expect(refused).toMatchObject({
          approved: false,
          refusals: [{ reason: 'exposure_unconfirmed' }],
          preview: { exposure: { plans: ['start', 'business', 'agency'], move: false } },
        })
        const seeded = new Map(refused.preview?.plans.map((plan) => [plan.slug, plan]))
        expect(seeded.get('start')).toMatchObject({ costRub: '1200.00', sharePercent: '60.3' })
        expect(seeded.get('business')).toMatchObject({ costRub: '6000.00', sharePercent: '60.1' })
        expect(seeded.get('agency')).toMatchObject({ costRub: '12000.00', sharePercent: '60.0' })
        expect(seeded.get('pack')).toMatchObject({ kind: 'pack', sharePercent: '40.3' })
        // «Оплата за действие» has no credits and is not a plan of this table.
        expect(seeded.has('payg')).toBe(false)

        const approved = await approveCreditRateIn(tx, request({}, { confirmExposure: true }))
        expect(approved.approved).toBe(true)
      })
    })

    it('needs a confirmation when the rate moves by more than a tenth of the rate in force', async () => {
      await rolledBack(async (tx) => {
        const earlier = fromNow(-HOUR)
        earlier.setMilliseconds(0)
        await writeCreditRate(tx, { effectiveFrom: earlier, rubPerCredit: '6.000000' })

        for (const rubPerCredit of ['6.610000', '5.390000']) {
          expect(await approveCreditRateIn(tx, request({ rubPerCredit }))).toMatchObject({
            approved: false,
            refusals: [{ reason: 'exposure_unconfirmed' }],
            preview: {
              previous: { rubPerCredit: '6.000000', effectiveFrom: earlier },
              exposure: { plans: [], move: true, confirmationNeeded: true },
            },
          })
        }
        expect(await written(tx)).toEqual({ rates: 1, prices: 0, audit: 0 })

        // A tenth exactly is not «more than a tenth».
        const approved = await approveCreditRateIn(tx, request({ rubPerCredit: '6.600000' }))
        expect(approved).toMatchObject({
          approved: true,
          preview: { movePercent: '+10.00', exposure: { confirmationNeeded: false } },
        })
        // The next move is counted from the row that is in force now.
        const confirmed = await approveCreditRateIn(
          tx,
          request(
            { rubPerCredit: '5.000000' },
            { confirmExposure: true, effectiveFrom: fromNow(HOUR) },
          ),
        )
        expect(confirmed).toMatchObject({
          approved: true,
          preview: { previous: { rubPerCredit: '6.600000' }, movePercent: '-24.24' },
        })
        // Both entries carry the moment of this one transaction: told apart by their rates.
        const entries = await tx.auditLog.findMany({
          where: { action: creditRateAuditActions.approve },
        })
        expect(
          entries
            .map(({ meta }) => meta as { rubPerCredit: string; previousRubPerCredit: string })
            .map((meta) => [meta.previousRubPerCredit, meta.rubPerCredit])
            .sort(),
        ).toEqual([
          ['6.000000', '6.600000'],
          ['6.600000', '5.000000'],
        ])
      })
    })

    it('counts the move from the rate that is in force at the start, a scheduled one included', async () => {
      await rolledBack(async (tx) => {
        // Nothing is in force now; a rate of 6.00 starts in an hour.
        const scheduled = fromNow(HOUR)
        scheduled.setMilliseconds(0)
        await writeCreditRate(tx, { effectiveFrom: scheduled, rubPerCredit: '6.000000' })

        const approval = await approveCreditRateIn(
          tx,
          request({ rubPerCredit: '6.610000' }, { effectiveFrom: fromNow(2 * HOUR) }),
        )

        // Against the clock there would be no rate to move from, and nothing to confirm.
        expect(approval).toMatchObject({
          approved: false,
          refusals: [{ reason: 'exposure_unconfirmed' }],
          preview: {
            previous: { rubPerCredit: '6.000000', effectiveFrom: scheduled },
            movePercent: '+10.17',
          },
        })
      })
    })

    it('values the pack and gift credits of all workspaces that are not spent', async () => {
      await rolledBack(async (tx) => {
        const base = await approveCreditRateIn(tx, request())
        if (!base.approved) throw new Error('The rate must be approved')

        const workspace = await tx.workspace.create({ data: { name: 'Rate verification' } })
        const account = (unit: 'credit_tariff' | 'credit_gift' | 'credit_pack', balance: number) =>
          tx.billingAccount.create({
            // Half of each balance is set aside for a task: it is outstanding all the same.
            data: { workspaceId: workspace.id, unit, balance, held: Math.floor(balance / 2) },
          })
        await account(creditAccountUnits.tariff, 300)
        await account(creditAccountUnits.gift, 35)
        await account(creditAccountUnits.pack, 240)

        const next = await approveCreditRateIn(
          tx,
          request({ rubPerCredit: '6.500000' }, { effectiveFrom: fromNow(HOUR) }),
        )

        if (!next.approved) throw new Error('The rate must be approved')
        const { pack, gift } = next.preview.outstanding
        // Tariff credits expire with their period and are not a debt that outlives it.
        expect(pack.credits - base.preview.outstanding.pack.credits).toBe(240)
        expect(gift.credits - base.preview.outstanding.gift.credits).toBe(35)
        expect(pack.costRub).toBe((pack.credits * 6.5).toFixed(2))
        expect(gift.costRub).toBe((gift.credits * 6.5).toFixed(2))
      })
    })
  })

  describe('a change of the rate alone', () => {
    it('writes the rate and no price', async () => {
      await rolledBack(async (tx) => {
        const sol = await writeModelPool(tx, { enabled: true })
        const earlier = fromNow(-HOUR)
        earlier.setMilliseconds(0)
        await writeModelPrice(tx, sol, { effectiveFrom: earlier })
        await writeCreditRate(tx, { effectiveFrom: earlier, rubPerCredit: '6.000000' })

        const approval = await approveCreditRateIn(tx, request({ rubPerCredit: '5.500000' }))

        if (!approval.approved) throw new Error('The rate must be approved')
        expect(approval.prices).toBe(0)
        expect(await written(tx, [sol])).toEqual({ rates: 2, prices: 1, audit: 1 })
        // The model keeps its prices, and they now come to more credits.
        expect(approval.preview.models).toEqual([
          {
            provider: sol.provider,
            model: sol.model,
            modelClass: 'standard',
            listed: false,
            creditsPer1m: {
              input: '42.27',
              cacheRead: '4.23',
              cacheWrite: '42.27',
              output: '211.36',
            },
          },
        ])
        expect(await creditRateStatus(tx, approval.effectiveFrom)).toMatchObject({
          verdict: 'usable',
          rate: { id: approval.rateId, rubPerCredit: '5.500000' },
        })
      })
    })
  })

  describe('different prices in one class', () => {
    const dearer = { outputPer1m: '1500.000000' }

    it('needs a confirmation when two enabled models of a class are priced differently', async () => {
      await rolledBack(async (tx) => {
        const first = await writeModelPool(tx, { enabled: true })
        const second = await writeModelPool(tx, { enabled: true })
        const rates = { prices: [priced(first), priced(second, dearer)] }

        const refused = await approveCreditRateIn(tx, request(rates))

        expect(refused).toMatchObject({
          approved: false,
          refusals: [{ reason: 'mixed_models_unconfirmed', classes: ['standard'] }],
          preview: { mixedClasses: ['standard'] },
        })
        expect(await written(tx, [first, second])).toEqual({ rates: 0, prices: 0, audit: 0 })

        const approved = await approveCreditRateIn(tx, request(rates, { confirmMixedModels: true }))
        expect(approved).toMatchObject({ approved: true, prices: 2 })
        expect(
          await tx.auditLog.findMany({ where: { action: creditRateAuditActions.approve } }),
        ).toMatchObject([{ meta: { confirmExposure: false, confirmMixedModels: true } }])
      })
    })

    it('compares the new prices of one model with the prices the other keeps', async () => {
      await rolledBack(async (tx) => {
        const kept = await writeModelPool(tx, { enabled: true })
        const repriced = await writeModelPool(tx, { enabled: true })
        const earlier = fromNow(-HOUR)
        earlier.setMilliseconds(0)
        await writeModelPrice(tx, kept, { effectiveFrom: earlier })
        await writeModelPrice(tx, repriced, { effectiveFrom: earlier })
        await writeCreditRate(tx, { effectiveFrom: earlier })

        expect(
          await approveCreditRateIn(tx, request({ prices: [priced(repriced, dearer)] })),
        ).toMatchObject({
          approved: false,
          refusals: [{ reason: 'mixed_models_unconfirmed', classes: ['standard'] }],
        })
        // Priced alike — both in the file, or one in the file as the other already is —, the
        // class is one price again.
        expect(
          (await approveCreditRateIn(tx, request({ prices: [priced(repriced)] }))).approved,
        ).toBe(true)
      })
    })

    it('asks nothing for models of different classes, for one switched off or for equal prices', async () => {
      await rolledBack(async (tx) => {
        const standard = await writeModelPool(tx, { enabled: true })
        const twin = await writeModelPool(tx, { enabled: true })
        const heavy = await writeModelPool(tx, { enabled: true, modelClass: 'heavy' })
        const off = await writeModelPool(tx, { enabled: false })

        const approval = await approveCreditRateIn(
          tx,
          request({
            prices: [
              priced(standard),
              priced(twin),
              priced(heavy, dearer),
              // Written for the day the model is switched on; not compared until then.
              priced(off, { outputPer1m: '9.000000' }),
            ],
          }),
        )

        expect(approval).toMatchObject({ approved: true, prices: 4, preview: { mixedClasses: [] } })
        // The table is of the enabled models.
        expect(approval.preview?.models.map(({ model }) => model).sort()).toEqual(
          [standard.model, twin.model, heavy.model].sort(),
        )
      })
    })
  })

  describe('the seeded catalogue of two Z.ai offers', () => {
    // The plan and the pay-per-token API have profiles of the same slugs and names: a price is
    // the profile's of the provider it names, and a switched-off profile counts for nothing.
    const profile = (tx: Tx, provider: string) =>
      tx.llmModel.findFirstOrThrow({
        where: { provider: { slug: provider }, slug: 'glm-5.3-standard' },
      })
    const glm = (provider: string, patch: Record<string, unknown> = {}) => ({
      provider,
      model: 'glm-5.3-standard',
      ...SOL,
      ...SOURCE,
      ...patch,
    })

    it('prices each offer by its provider and reads only the profiles switched on', async () => {
      await rolledBack(async (tx) => {
        const plan = await profile(tx, 'zai-coding')
        const api = await profile(tx, 'zai-api')
        expect(api).toMatchObject({ name: plan.name, enabled: false })
        await tx.llmModel.update({ where: { id: plan.id }, data: { enabled: true } })

        // The API's price differs; its profile is off, so nothing asks for a confirmation.
        const approval = await approveCreditRateIn(
          tx,
          request({
            prices: [glm('zai-coding'), glm('zai-api', { outputPer1m: '1500.000000' })],
          }),
        )
        if (!approval.approved) throw new Error('The rate must be approved')
        expect(approval).toMatchObject({ prices: 2, preview: { mixedClasses: [] } })
        expect(approval.preview.models.map(({ provider, model }) => [provider, model])).toEqual([
          ['zai-coding', 'glm-5.3-standard'],
        ])
        const outputs = await tx.llmModelPrice.findMany({
          where: { modelId: { in: [plan.id, api.id] } },
          select: { modelId: true, outputPer1m: true },
        })
        expect(
          Object.fromEntries(outputs.map((row) => [row.modelId, row.outputPer1m.toFixed(6)])),
        ).toEqual({ [plan.id]: '1162.500000', [api.id]: '1500.000000' })

        // «Точный расчёт»: one table, the plan's; the API's profile of the same name is not in it.
        const conversion = await getCreditConversion(tx, approval.effectiveFrom)
        expect(conversion?.rows).toEqual([expect.objectContaining({ model: null })])
        expect(conversion?.rows[0]?.output).toBe('193.75')

        // Both switched on at different prices: the operator is asked, as for any two models.
        await tx.llmModel.update({ where: { id: api.id }, data: { enabled: true } })
        expect(
          await approveCreditRateIn(tx, request({}, { effectiveFrom: fromNow(HOUR) })),
        ).toMatchObject({
          approved: false,
          refusals: [{ reason: 'mixed_models_unconfirmed', classes: ['standard'] }],
        })
      })
    })
  })

  it('lets one approval in at a time: the second waits for the first to end', async () => {
    let second: Promise<unknown> | undefined
    let waited = false
    await rolledBack(async (tx) => {
      const first = await approveCreditRateIn(tx, request())
      expect(first.approved).toBe(true)

      // Another connection, while the first transaction is still open. It writes no plan
      // before it approves, so what it waits for is the approval of the first: the tariffs of
      // the seed stay on sale for it, and it confirms their exposure.
      let done = false
      second = asSeeded((other) =>
        approveCreditRateIn(
          other,
          request({ rubPerCredit: '6.100000' }, { confirmExposure: true }),
        ),
      ).then((approval) => {
        done = true
        return approval
      })
      await new Promise((resolve) => setTimeout(resolve, 400))
      waited = !done
    })
    // The first transaction is over (rolled back): the second goes on and sees no row of it.
    expect(waited).toBe(true)
    expect(await second).toMatchObject({ approved: true, preview: { previous: null } })
  })

  it('tells every reason at once', async () => {
    await rolledBack(async (tx) => {
      const first = await writeModelPool(tx, { enabled: true })
      const second = await writeModelPool(tx, { enabled: true })
      const earlier = fromNow(-2 * HOUR)
      earlier.setMilliseconds(0)
      await writeCreditRate(tx, { effectiveFrom: earlier, rubPerCredit: '6.000000' })

      const approval = await approveCreditRateIn(
        tx,
        request(
          {
            rubPerCredit: '9.000000',
            prices: [priced(first), priced(second, { inputPer1m: '1' })],
          },
          { effectiveFrom: fromNow(-HOUR) },
        ),
      )

      if (approval.approved) throw new Error('The rate must be refused')
      expect(approval.refusals.map(({ reason }) => reason)).toEqual([
        'instant_past',
        'exposure_unconfirmed',
        'mixed_models_unconfirmed',
      ])
      expect(await written(tx, [first, second])).toEqual({ rates: 1, prices: 0, audit: 0 })
    })
  })

  it.each([
    ['no operator', { operator: undefined }],
    ['no reason', { reason: ' ' }],
    ['a rate of zero', { rates: { rubPerCredit: '0', basis: BASIS, prices: [] } }],
    ['an instant that is not a date', { effectiveFrom: new Date(Number.NaN) }],
    ['an unknown option', { dryRun: true }],
  ])('throws on a request with %s and writes nothing', async (_, patch) => {
    await rolledBack(async (tx) => {
      await expect(
        approveCreditRateIn(tx, { ...request(), ...patch } as CreditRateApprovalInput),
      ).rejects.toThrow()
      expect(await written(tx)).toEqual({ rates: 0, prices: 0, audit: 0 })
    })
  })
})

// The writers of a model call as methods of `billingFixtures`: committed rows, for a suite of
// another package that cannot keep its work in one transaction. On a disposable database only,
// like the cases above: a committed rate is the rate of the whole database while it stands.
describe.skipIf(!disposable)('the committed fixtures of a model call', () => {
  let db: PrismaClient

  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  it('commit a pool, a price, a call and a rate, and cleanup takes them all away', async () => {
    const fixtures = billingFixtures(db)
    // In 2001, as the suite of the reads: nothing real starts before it.
    const start = new Date('2001-03-01T09:00:00.000Z')
    try {
      const pool = await fixtures.modelPool()
      const price = await fixtures.modelPrice(pool, { effectiveFrom: start })
      const rate = await fixtures.creditRate({ effectiveFrom: start })
      const { workspaceId } = await fixtures.workspace()
      const { taskId } = await fixtures.task(workspaceId)
      const call = await fixtures.modelCall({
        taskId,
        pool,
        priceId: price.id,
        costRub: '60',
        occurredAt: new Date(start.getTime() + 1_000),
        turnStatus: 'completed',
      })
      const left = async () => ({
        rates: await db.creditRate.count({ where: { id: rate.id } }),
        prices: await db.llmModelPrice.count({ where: { id: price.id } }),
        models: await db.llmModel.count({ where: { id: pool.modelId } }),
        providers: await db.llmProvider.count({ where: { id: pool.providerId } }),
        drivers: await db.agentDriver.count({ where: { id: pool.driverId } }),
        accounts: await db.subscriptionAccount.count({ where: { id: pool.accountId } }),
        credentials: await db.credentialRef.count({ where: { id: pool.credentialRefId } }),
        usage: await db.tokenUsage.count({ where: { id: call.usageId } }),
        calls: await db.llmCall.count({ where: { id: call.callId } }),
        keys: await db.llmKey.count({ where: { id: call.keyId } }),
        turns: await db.taskTurn.count({ where: { taskId } }),
        tasks: await db.task.count({ where: { id: taskId } }),
      })

      // Committed: read outside any transaction, by the functions a charge will read them with.
      const counted = await left()
      const each = (rows: number) =>
        Object.fromEntries(Object.keys(counted).map((name) => [name, rows]))
      expect(counted).toEqual(each(1))
      expect(await creditRateAt(db, start)).toMatchObject({ id: rate.id, rubPerCredit: '6.000000' })
      const raw = await taskRawCredits(db, { taskId, attempts: [1] })
      expect(raw.convertible && raw.credits.toFixed(2)).toBe('10.00')

      await fixtures.cleanup()
      expect(await left()).toEqual(each(0))
    } finally {
      await fixtures.cleanup()
    }
  })
})
