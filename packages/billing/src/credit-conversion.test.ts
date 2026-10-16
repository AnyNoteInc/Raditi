import { createPrismaClient, type Prisma, type PrismaClient } from '@repo/db'
import { chargeForOutcome, creditsFromCost, Money, taskCharge, toCredits } from '@repo/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { getCreditConversion } from './credit-conversion.ts'
import { creditRatePreview } from './credit-rate-approval.ts'
import { creditConversionSchema } from './dto.ts'
import {
  inRolledBackTransaction,
  writeCreditRate,
  writeModelPool,
  writeModelPrice,
  type TestModelPriceData,
} from './testing.ts'

// The table of «Точный расчёт»: credits per million tokens, as the page prints them.

const databaseUrl = process.env.DATABASE_URL

/** GPT-6 Sol at 4.65 RUB a Codex credit: the prices the examples of the design are counted by. */
const SOL = {
  inputPer1m: '232.500000',
  cacheReadPer1m: '23.250000',
  cacheWritePer1m: null,
  outputPer1m: '1162.500000',
}
const K = '6.000000'
/** What the page prints for them: two decimals. */
const PRINTED = { input: '38.75', cacheRead: '3.88', cacheWrite: '38.75', output: '193.75' }

describe('the printed table of «Точный расчёт»', () => {
  const printed = () => {
    const { models } = creditRatePreview({
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      rubPerCredit: K,
      previous: null,
      plans: [],
      outstanding: { pack: 0, gift: 0 },
      models: [{ provider: 'p', model: 'm', modelClass: 'standard', listed: false, prices: SOL }],
    })
    const table = models[0]?.creditsPer1m
    if (table === null || table === undefined) throw new Error('The model has prices')
    return table
  }

  it('prints the prices of a model in credits per million tokens, to two decimals', () => {
    // 232.5, 23.25 and 1 162.5 RUB a million, divided by 6.00: 38.75, 3.875 and 193.75.
    expect(printed()).toEqual(PRINTED)
  })

  interface Work {
    /** Tokens the model read, of which four fifths came from its cache. */
    input: number
    output: number
  }
  const NEW_SHARE = '0.2'
  const CACHED_SHARE = '0.8'
  const millions = (tokens: number) => new Money(tokens).div(1_000_000)
  /** The work as a customer counts it by hand, from the printed table. */
  function byTable({ input, output }: Work) {
    const table = printed()
    return millions(input)
      .mul(NEW_SHARE)
      .mul(table.input)
      .plus(millions(input).mul(CACHED_SHARE).mul(table.cacheRead))
      .plus(millions(output).mul(table.output))
  }
  /** The same work as the charge counts it: the accounting cost divided by the credit rate. */
  function byCost({ input, output }: Work) {
    const costRub = millions(input)
      .mul(NEW_SHARE)
      .mul(SOL.inputPer1m)
      .plus(millions(input).mul(CACHED_SHARE).mul(SOL.cacheReadPer1m))
      .plus(millions(output).mul(SOL.outputPer1m))
    return {
      costRub,
      credits: creditsFromCost([{ costRub: costRub.toFixed(10), rubPerCredit: K }]),
    }
  }
  const STEP = toCredits(45)

  // The worked examples of the design (§1.5) that are given in tokens.
  it.each([
    [
      'a small edit: 250 thousand tokens in, 5 thousand out',
      { input: 250_000, output: 5_000 },
      '22.09',
      '3.68',
      5,
    ],
    [
      'a new block: 1.2 million in, 20 thousand out',
      { input: 1_200_000, output: 20_000 },
      '101.37',
      '16.90',
      17,
    ],
    [
      'a big task: 2 million in, 40 thousand out',
      { input: 2_000_000, output: 40_000 },
      '176.70',
      '29.46',
      29,
    ],
    [
      'the same block after one clarification, a quarter more work',
      { input: 1_500_000, output: 25_000 },
      '126.71',
      '21.12',
      21,
    ],
    ['three small edits in one message', { input: 750_000, output: 15_000 }, '66.26', '11.05', 11],
  ] as const)('gives the charge of %s', (_case, work, costRub, tableCredits, charged) => {
    const exact = byCost(work)
    const table = byTable(work)
    expect(exact.costRub.toFixed(2)).toBe(costRub)
    expect(table.toFixed(2)).toBe(tableCredits)
    // Counted by hand from the table and counted by the charge, the task costs the same.
    expect(taskCharge({ used: table, reserved: STEP }).credits).toBe(charged)
    expect(taskCharge({ used: exact.credits, reserved: STEP }).credits).toBe(charged)
  })

  it('gives the minimum for a done task whose only calls were the fault of the platform', () => {
    // Nothing billable: no token of the table is counted.
    const nothing = byTable({ input: 0, output: 0 })
    expect(taskCharge({ used: nothing, reserved: STEP })).toMatchObject({
      credits: 5,
      minimumApplied: true,
    })
  })

  it('gives nothing for a task that failed, whatever the table makes of its tokens', () => {
    const used = byTable({ input: 1_800_000, output: 26_000 })
    expect(chargeForOutcome({ outcome: 'failed', used, reserved: STEP }).credits).toBe(0)
  })

  it('never gives more than was set aside, however many tokens were counted', () => {
    // About 297 RUB of work, 49.5 credits: the charge stops at the 45 of the reserve.
    const used = byTable({ input: 3_400_000, output: 66_000 })
    expect(used.toNumber()).toBeGreaterThan(45)
    expect(taskCharge({ used, reserved: STEP })).toMatchObject({ credits: 45, capped: true })
    // And at the 12 a customer with 12 credits had.
    expect(taskCharge({ used, reserved: toCredits(12) }).credits).toBe(12)
  })

  it('may differ from the exact count by the rounding of the table, never by more than a credit', () => {
    // The table rounds 3.875 up to 3.88: on text read again it is five thousandths of a credit
    // a million tokens above the charge.
    for (const input of [250_000, 1_200_000, 2_000_000, 20_000_000]) {
      const work = { input, output: input / 50 }
      const difference = byTable(work).minus(byCost(work).credits).abs()
      expect(difference.lt(1)).toBe(true)
    }
  })
})

describe('credit conversion DTO', () => {
  const row = { model: null, ...PRINTED }

  it('accepts one table for every model and a row per model', () => {
    expect(creditConversionSchema.parse({ rows: [row] })).toEqual({ rows: [row] })
    const rows = [
      { ...row, model: 'Модель А' },
      { ...row, model: 'Модель Б', output: '200.00' },
    ]
    expect(creditConversionSchema.parse({ rows })).toEqual({ rows })
  })

  it.each([
    ['a table without a row', { rows: [] }],
    ['a number that is not printed to two decimals', { rows: [{ ...row, cacheRead: '3.875' }] }],
    ['a number', { rows: [{ ...row, input: 38.75 }] }],
    ['a negative number', { rows: [{ ...row, input: '-1.00' }] }],
    ['a row without the text written', { rows: [{ ...row, output: undefined }] }],
    ['a model without a name', { rows: [{ ...row, model: '' }] }],
  ])('refuses %s', (_case, table) => {
    expect(creditConversionSchema.safeParse(table).success).toBe(false)
  })
})

describe.skipIf(!databaseUrl)('PostgreSQL credit conversion', () => {
  let db: PrismaClient
  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  const PRICES_FROM = new Date('2026-09-01T00:00:00.000Z')
  const RATE_FROM = new Date('2026-09-01T00:00:00.000Z')
  const NOW = new Date('2026-10-04T12:00:00.000Z')
  type Tx = Prisma.TransactionClient

  /** An enabled model of its own with prices in force: nobody else ever sees it. */
  async function enabledModel(tx: Tx, name: string, prices: Partial<TestModelPriceData> = {}) {
    const pool = await writeModelPool(tx, { enabled: true })
    await tx.llmModel.update({ where: { id: pool.modelId }, data: { name } })
    const { effectiveFrom = PRICES_FROM, ...own } = prices
    await writeModelPrice(tx, pool, { effectiveFrom, ...SOL, ...own })
    return pool
  }
  const rate = (tx: Tx, effectiveFrom = RATE_FROM) => writeCreditRate(tx, { effectiveFrom })
  /** Everything is written in a transaction that never commits: a rate is the whole database's. */
  const conversion = (setup: (tx: Tx) => Promise<unknown>, now = NOW) =>
    inRolledBackTransaction(db, async (tx) => {
      await setup(tx)
      return getCreditConversion(tx, now)
    })

  it('has no table while no credit rate is in force', async () => {
    expect(await conversion((tx) => enabledModel(tx, 'Модель'))).toBeNull()
  })

  it('has no table while no enabled model has a price in force', async () => {
    expect(await conversion((tx) => rate(tx))).toBeNull()
    expect(
      await conversion(async (tx) => {
        await rate(tx)
        // A model that is switched off is charged for nothing.
        const pool = await writeModelPool(tx, { enabled: false })
        await writeModelPrice(tx, pool, { effectiveFrom: PRICES_FROM })
      }),
    ).toBeNull()
  })

  it('has no table while the rate is older than a price in force: nothing is charged by it', async () => {
    expect(
      await conversion(async (tx) => {
        await rate(tx)
        await enabledModel(tx, 'Модель', { effectiveFrom: new Date('2026-09-15T00:00:00.000Z') })
      }),
    ).toBeNull()
  })

  it('prints one table without a name when one model runs', async () => {
    expect(
      await conversion(async (tx) => {
        await rate(tx)
        await enabledModel(tx, 'Модель')
      }),
    ).toEqual({ rows: [{ model: null, ...PRINTED }] })
  })

  it('prints one table when every enabled model is costed by the same prices', async () => {
    expect(
      await conversion(async (tx) => {
        await rate(tx)
        await enabledModel(tx, 'Модель А')
        await enabledModel(tx, 'Модель Б')
      }),
    ).toEqual({ rows: [{ model: null, ...PRINTED }] })
  })

  it('prints a row per model, by its name, when their prices differ', async () => {
    expect(
      await conversion(async (tx) => {
        await rate(tx)
        await enabledModel(tx, 'Модель Б', { outputPer1m: '1200.000000' })
        await enabledModel(tx, 'Модель А')
      }),
    ).toEqual({
      rows: [
        { model: 'Модель А', ...PRINTED },
        { model: 'Модель Б', ...PRINTED, output: '200.00' },
      ],
    })
  })

  it('prints the price of text kept for reading again when a model has one of its own', async () => {
    expect(
      await conversion(async (tx) => {
        await rate(tx)
        await enabledModel(tx, 'Модель', { cacheWritePer1m: '290.625000' })
      }),
    ).toEqual({ rows: [{ model: null, ...PRINTED, cacheWrite: '48.44' }] })
  })

  it('counts by the prices and the rate in force at the moment asked about', async () => {
    const setup = async (tx: Tx) => {
      await rate(tx)
      const pool = await enabledModel(tx, 'Модель')
      // From November on: twice the prices, and a rate approved with them.
      const later = new Date('2026-11-01T00:00:00.000Z')
      await writeModelPrice(tx, pool, {
        effectiveFrom: later,
        inputPer1m: '465.000000',
        cacheReadPer1m: '46.500000',
        outputPer1m: '2325.000000',
      })
      await writeCreditRate(tx, { effectiveFrom: later, rubPerCredit: '12.000000' })
    }
    // The customer is insulated: the same table before and after.
    expect(await conversion(setup)).toEqual({ rows: [{ model: null, ...PRINTED }] })
    expect(await conversion(setup, new Date('2026-11-02T00:00:00.000Z'))).toEqual({
      rows: [{ model: null, ...PRINTED }],
    })
  })
})
