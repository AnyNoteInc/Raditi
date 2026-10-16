import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { creditRateAuditActions, creditRateStatus } from '@repo/billing'
import { billingFixtures, type TestModelPool } from '@repo/billing/testing'
import { createPrismaClient, type PrismaClient } from '@repo/db'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { runBillingCommand } from './operator-cli.ts'

// `billing:rates` as an operator runs it: the real script in a process of its own, and the same
// command in this process where only its answer matters, on PostgreSQL. Only on a disposable
// database: the command commits a row of `credit_rates` — the credit rate of the whole
// database — and reads every enabled model and every plan on sale.
const databaseUrl = process.env.DATABASE_URL
const enabled = Boolean(databaseUrl && process.env.RADITI_GATEWAY_DB_TESTS === '1')
const cwd = fileURLToPath(new URL('../../', import.meta.url))

const OPERATOR = 'operator-test-rates'
/** GPT-6 Sol at 4.65 RUB a Codex credit. */
const SOL = {
  inputPer1m: '232.500000',
  cacheReadPer1m: '23.250000',
  cacheWritePer1m: null,
  outputPer1m: '1162.500000',
  vatRate: '0.2200',
  sourceUrl: 'https://rates.example/2026-q4',
}

describe.skipIf(!enabled)('billing:rates with PostgreSQL', () => {
  let db: PrismaClient
  let fixtures: ReturnType<typeof billingFixtures>
  let directory: string
  /** What every rate of the suite is marked with: `credit_rates.basis` starts with it. */
  const mark = `rates-it-${randomUUID()}`
  const env = { APP_ENV: 'test', DATABASE_URL: databaseUrl ?? '' }

  beforeAll(async () => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
    fixtures = billingFixtures(db)
    directory = mkdtempSync(join(tmpdir(), 'raditi-billing-rates-it-'))
    // What the cases stand on: a catalogue nobody has switched on and no rate.
    expect(await db.llmModel.count({ where: { enabled: true } })).toBe(0)
    expect(await db.creditRate.count()).toBe(0)
  })
  afterEach(async () => {
    await db.creditRate.deleteMany({ where: { basis: { startsWith: mark } } })
    await db.auditLog.deleteMany({
      where: { action: creditRateAuditActions.approve, actorId: OPERATOR },
    })
    await fixtures.cleanup()
  })
  afterAll(async () => {
    rmSync(directory, { recursive: true, force: true })
    await db.$disconnect()
  })

  const priced = (pool: TestModelPool, patch: Record<string, unknown> = {}) => ({
    provider: pool.provider,
    model: pool.model,
    ...SOL,
    ...patch,
  })
  /** A file of rates of the suite; the path to give to --file. */
  function ratesFile(content: { rubPerCredit?: string; prices?: object[]; basis?: null }): string {
    const path = join(directory, `${randomUUID()}.json`)
    const { basis, ...rates } = { rubPerCredit: '6.000000', prices: [], ...content }
    writeFileSync(
      path,
      JSON.stringify({ ...rates, ...(basis === null ? {} : { basis: `${mark} корзина` }) }),
    )
    return path
  }
  const args = (file: string, ...more: string[]) => [
    '--file',
    file,
    '--reason',
    'Ставки на четвёртый квартал',
    '--operator',
    OPERATOR,
    ...more,
  ]

  /** The real script in a process of its own. */
  function script(written: string[]) {
    return new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn(process.execPath, ['scripts/billing-rates.mjs', ...written], {
          cwd,
          env: { PATH: process.env.PATH, ...env },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        const stdout: Buffer[] = []
        const stderr: Buffer[] = []
        child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
        child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
        const timer = setTimeout(() => child.kill('SIGKILL'), 30_000)
        child.once('error', reject)
        child.once('close', (code) => {
          clearTimeout(timer)
          resolve({
            code,
            stdout: Buffer.concat(stdout).toString(),
            stderr: Buffer.concat(stderr).toString(),
          })
        })
      },
    )
  }

  /** The same command in this process: what it printed, and what it failed with. */
  async function command(written: string[]): Promise<{ printed: string; failure: string | null }> {
    const lines: string[] = []
    try {
      await runBillingCommand('rates', written, env, (text) => void lines.push(text))
      return { printed: lines.join(''), failure: null }
    } catch (error) {
      return { printed: lines.join(''), failure: (error as Error).message }
    }
  }

  const stored = async (pools: TestModelPool[] = []) => ({
    rates: await db.creditRate.findMany({ orderBy: { effectiveFrom: 'asc' } }),
    prices: await db.llmModelPrice.findMany({
      where: { modelId: { in: pools.map((pool) => pool.modelId) } },
      orderBy: { inputPer1m: 'desc' },
    }),
    audit: await db.auditLog.findMany({ where: { action: creditRateAuditActions.approve } }),
  })

  it('writes the prices and the first rate with one instant, in one transaction', async () => {
    const sol = await fixtures.modelPool({ enabled: true })
    const luna = await fixtures.modelPool({ enabled: true, modelClass: 'light' })
    const file = ratesFile({
      prices: [
        priced(sol),
        priced(luna, { inputPer1m: '11.625', cacheReadPer1m: '1.1625', outputPer1m: '58.125' }),
      ],
    })
    const before = Date.now()

    const result = await script(args(file))

    expect(result.stderr).toBe('')
    expect(result.code).toBe(0)
    const { rates, prices, audit } = await stored([sol, luna])
    expect(rates).toHaveLength(1)
    const [rate] = rates
    if (rate === undefined) throw new Error('No rate was written')
    expect(rate.rubPerCredit.toFixed(6)).toBe('6.000000')
    expect(rate.basis).toBe(`${mark} корзина`)
    // The clock of the database, in whole milliseconds.
    expect(rate.effectiveFrom.getTime()).toBeGreaterThanOrEqual(before - 5_000)
    expect(rate.effectiveFrom.getTime()).toBeLessThanOrEqual(Date.now() + 5_000)
    expect(prices.map((price) => [price.modelId, price.effectiveFrom])).toEqual([
      [sol.modelId, rate.effectiveFrom],
      [luna.modelId, rate.effectiveFrom],
    ])
    expect(prices.map((price) => price.outputPer1m.toFixed(6))).toEqual([
      '1162.500000',
      '58.125000',
    ])
    expect(audit).toMatchObject([
      {
        actorType: 'operator',
        actorId: OPERATOR,
        workspaceId: null,
        targetType: 'credit_rate',
        targetId: rate.id,
        meta: {
          reason: 'Ставки на четвёртый квартал',
          rubPerCredit: '6.000000',
          previousRubPerCredit: null,
          effectiveFrom: rate.effectiveFrom.toISOString(),
          prices: 2,
          confirmExposure: false,
          confirmMixedModels: false,
        },
      },
    ])
    // One transaction wrote the rate, both prices and the audit entry.
    const writers = await db.$queryRaw<{ writer: string }[]>`
      SELECT xmin::text AS writer FROM credit_rates WHERE id = ${rate.id}::uuid
      UNION ALL
      SELECT xmin::text FROM llm_model_prices
        WHERE model_id = ANY(${[sol.modelId, luna.modelId]}::uuid[])
      UNION ALL
      SELECT xmin::text FROM audit_log WHERE target_id = ${rate.id}
    `
    expect(writers).toHaveLength(4)
    expect(new Set(writers.map(({ writer }) => writer)).size).toBe(1)

    // What the operator saw, in the order it happened: the action, the numbers, the record.
    const at = `(${rate.effectiveFrom.toISOString()})`
    const lines = result.stdout.trimEnd().split('\n')
    expect(lines.slice(0, 5)).toEqual([
      'Действие: утвердить курс кредита 6.000000 ₽ учётной стоимости за кредит; ставок моделей в файле: 2.',
      `Оператор: ${OPERATOR}. Причина: Ставки на четвёртый квартал`,
      `Основание: ${mark} корзина`,
      expect.stringMatching(/^Начало действия: \d{2}\.\d{2}\.\d{4} \d{2}:\d{2}:\d{2} МСК /),
      'На момент начала действующего курса нет. Новый курс — 6.000000 ₽ учётной стоимости за кредит.',
    ])
    expect(lines[3]).toContain(at)
    // The plans of the seed at the shares of the plan.
    expect(lines).toContain('  start (тариф): 300 кредитов — 1800.00 ₽, 36.7 % цены 4900.00 ₽')
    expect(lines).toContain('  business (тариф): 800 кредитов — 4800.00 ₽, 37.2 % цены 12900.00 ₽')
    expect(lines).toContain('  agency (тариф): 2500 кредитов — 15000.00 ₽, 37.6 % цены 39900.00 ₽')
    expect(lines).toContain('  pack (пакет): 100 кредитов — 600.00 ₽, 30.2 % цены 1990.00 ₽')
    expect(lines).toContain(
      'Шаги попытки при этом курсе (предел одного ключа хода — 750 ₽): light — 20 кредитов, 120.00 ₽; standard — 45 кредитов, 270.00 ₽; heavy — 120 кредитов, 720.00 ₽.',
    )
    expect(lines).toContain(
      `  ${luna.provider}/${luna.model} (light): 1.94 / 0.19 / 1.94 / 9.69 — ставки из файла`,
    )
    expect(lines).toContain(
      `  ${sol.provider}/${sol.model} (standard): 38.75 / 3.88 / 38.75 / 193.75 — ставки из файла`,
    )
    expect(lines.at(-1)).toBe(
      `Записано: курс кредита ${rate.id} и ставки моделей (2) действуют с ${lines[3]!.slice('Начало действия: '.length, -1)}.`,
    )
    // From that instant credits can be reserved.
    expect(await creditRateStatus(db, rate.effectiveFrom)).toMatchObject({
      verdict: 'usable',
      rate: { id: rate.id },
    })
  })

  it('changes the rate alone and tells the move from the rate in force', async () => {
    const sol = await fixtures.modelPool({ enabled: true })
    const first = await command(args(ratesFile({ prices: [priced(sol)] })))
    expect(first.failure).toBeNull()

    const second = await command(args(ratesFile({ rubPerCredit: '6.300000' })))

    expect(second.failure).toBeNull()
    const { rates, prices, audit } = await stored([sol])
    expect(rates.map((rate) => rate.rubPerCredit.toFixed(6))).toEqual(['6.000000', '6.300000'])
    // No price row came with the second rate: the model keeps the prices of the first.
    expect(prices).toHaveLength(1)
    expect(audit).toHaveLength(2)
    expect(second.printed).toContain(
      'Действие: утвердить курс кредита 6.300000 ₽ учётной стоимости за кредит; ставки моделей не меняются.\n',
    )
    expect(second.printed).toContain(
      `Действующий курс — 6.000000 ₽ за кредит, с ${moscow(rates[0]!.effectiveFrom)} (${rates[0]!.effectiveFrom.toISOString()}). Новый курс — 6.300000 ₽, изменение +5.00 %.\n`,
    )
    expect(second.printed).toContain(
      `  ${sol.provider}/${sol.model} (standard): 36.90 / 3.69 / 36.90 / 184.52 — прежние ставки\n`,
    )
    // Above the limit of one turn key: 120 credits at 6.30 are 756 RUB.
    expect(second.printed).toContain(
      '  Шаг выше предела ключа: heavy. Такая попытка получит несколько ключей хода подряд.\n',
    )
    expect(second.printed).toMatch(/Записано: курс кредита [0-9a-f-]{36} и ставки моделей \(0\) /)
    expect(await creditRateStatus(db, rates[1]!.effectiveFrom)).toMatchObject({
      verdict: 'usable',
      rate: { rubPerCredit: '6.300000' },
    })
  })

  it('prints the numbers, refuses, exits non-zero and writes nothing', async () => {
    const sol = await fixtures.modelPool({ enabled: true })
    const twin = await fixtures.modelPool({ enabled: true })
    const yesterday = new Date(Date.now() - 86_400_000).toISOString()
    const file = ratesFile({
      rubPerCredit: '9.000000',
      prices: [priced(sol), priced(twin, { outputPer1m: '1500' })],
    })

    const result = await script(args(file, '--effective-from', yesterday))

    expect(result.code).toBe(1)
    const reasons = result.stderr.trimEnd().split('\n')
    expect(reasons).toHaveLength(4)
    expect(reasons[0]).toBe('Курс и ставки не записаны.')
    expect(reasons[1]).toMatch(/^- Момент начала раньше текущего времени базы данных — /)
    expect(reasons[2]).toBe(
      '- Нужно подтверждение --confirm-exposure: учётная стоимость тарифа выше половины его цены либо курс отличается от действующего больше чем на 10 % (строки выше).',
    )
    expect(reasons[3]).toBe(
      '- Нужно подтверждение --confirm-mixed-models: у включённых моделей одного класса разные ставки (standard).',
    )
    // The numbers were printed before the refusal: what «строки выше» points at.
    expect(result.stdout).toContain(`Начало действия: ${moscow(new Date(yesterday))} `)
    expect(result.stdout).toContain(
      '  start (тариф): 300 кредитов — 2700.00 ₽, 55.1 % цены 4900.00 ₽\n',
    )
    expect(result.stdout).toContain(
      'Разные ставки у включённых моделей одного класса: standard. Одна и та же задача будет стоить разное число кредитов в зависимости от аккаунта пула.\n',
    )
    expect(result.stdout).toContain(
      'Учётная стоимость выше половины цены у тарифов: start, business, agency.\n',
    )
    expect(result.stdout).not.toContain('Записано')
    expect(await stored([sol, twin])).toEqual({ rates: [], prices: [], audit: [] })
  })

  it('writes what was refused once the owner confirms it', async () => {
    const sol = await fixtures.modelPool({ enabled: true })
    const twin = await fixtures.modelPool({ enabled: true })
    const file = ratesFile({
      rubPerCredit: '9.000000',
      prices: [priced(sol), priced(twin, { outputPer1m: '1500' })],
    })

    // One confirmation is not the other.
    for (const option of ['--confirm-exposure', '--confirm-mixed-models']) {
      const half = await command(args(file, option))
      expect(half.failure).toMatch(/^Курс и ставки не записаны\.\n- Нужно подтверждение --confirm-/)
      expect(half.failure).not.toContain(option)
    }
    expect(await stored([sol, twin])).toEqual({ rates: [], prices: [], audit: [] })

    const both = await command(args(file, '--confirm-exposure', '--confirm-mixed-models'))

    expect(both.failure).toBeNull()
    const { rates, prices, audit } = await stored([sol, twin])
    expect(rates.map((rate) => rate.rubPerCredit.toFixed(6))).toEqual(['9.000000'])
    expect(prices.map((price) => price.outputPer1m.toFixed(2)).sort()).toEqual([
      '1162.50',
      '1500.00',
    ])
    expect(audit).toMatchObject([{ meta: { confirmExposure: true, confirmMixedModels: true } }])
  })

  it('takes a start ahead and refuses the next one that is not later', async () => {
    const sol = await fixtures.modelPool({ enabled: true })
    const ahead = new Date(Date.now() + 86_400_000)
    ahead.setMilliseconds(0)
    const scheduled = await command(
      args(ratesFile({ prices: [priced(sol)] }), '--effective-from', ahead.toISOString()),
    )
    expect(scheduled.failure).toBeNull()
    expect((await stored()).rates.map((rate) => rate.effectiveFrom)).toEqual([ahead])
    // Not in force yet: until then no credit can be reserved.
    expect((await creditRateStatus(db, new Date())).verdict).toBe('missing')

    // At the scheduled instant itself the history would not be one line.
    const notNewest = `- Момент начала не позже самой новой строки курса: она начинается ${moscow(ahead)} (${ahead.toISOString()}). Новая строка должна начинаться позже всех существующих: задайте --effective-from позже этого момента.`
    const same = await command(
      args(ratesFile({ rubPerCredit: '6.100000' }), '--effective-from', ahead.toISOString()),
    )
    expect(same.failure).toBe(`Курс и ставки не записаны.\n${notNewest}`)
    // And now a rate would be older than the price the model is to get tomorrow.
    const now = await command(args(ratesFile({ rubPerCredit: '6.100000' })))
    expect(now.failure).toBe(
      `Курс и ставки не записаны.\n${notNewest}\n- У включённой модели ${sol.provider}/${sol.model} есть ставка, которая начинается позже — ${moscow(ahead)} (${ahead.toISOString()}). Курс оказался бы старше этой ставки, и резервировать кредиты стало бы нельзя.`,
    )
    expect((await stored()).rates).toHaveLength(1)

    const later = new Date(ahead.getTime() + 1)
    const next = await command(
      args(ratesFile({ rubPerCredit: '6.100000' }), '--effective-from', later.toISOString()),
    )
    expect(next.failure).toBeNull()
    expect((await stored()).rates.map((rate) => rate.effectiveFrom)).toEqual([ahead, later])
  })

  it('refuses a start on a day the month does not have, and the day meant is still free', async () => {
    const year = new Date().getUTCFullYear() + 1
    const file = ratesFile({})

    // JavaScript reads 31 November as 1 December. Written, the row would start on a day nobody
    // typed, and no later run could put a row before it: the table only grows.
    const wrong = await script(args(file, '--effective-from', `${year}-11-31T00:00:00+03:00`))

    expect(wrong.code).toBe(1)
    expect(wrong.stdout).toBe('')
    expect(wrong.stderr).toBe('Неверные параметры команды биллинга. Используйте --help.\n')
    expect(await stored()).toEqual({ rates: [], prices: [], audit: [] })

    const meant = await script(args(file, '--effective-from', `${year}-11-30T00:00:00+03:00`))
    expect(meant.stderr).toBe('')
    expect(meant.code).toBe(0)
    expect((await stored()).rates.map((rate) => rate.effectiveFrom.toISOString())).toEqual([
      `${year}-11-29T21:00:00.000Z`,
    ])
  })

  it('refuses a model the catalogue does not have before it counts anything', async () => {
    const sol = await fixtures.modelPool({ enabled: true })
    const file = ratesFile({ prices: [priced(sol), priced(sol, { model: 'gpt-7' })] })

    const result = await command(args(file))

    expect(result.failure).toBe(
      `Курс и ставки не записаны.\n- В каталоге нет модели ${sol.provider}/gpt-7: проверьте slug провайдера и модели в файле.`,
    )
    expect(result.printed).not.toContain('Начало действия')
    expect(await stored([sol])).toEqual({ rates: [], prices: [], audit: [] })
  })

  it('refuses prices without a rate through the real script', async () => {
    const sol = await fixtures.modelPool({ enabled: true })
    const path = join(directory, 'prices-only.json')
    writeFileSync(path, JSON.stringify({ basis: `${mark} без курса`, prices: [priced(sol)] }))

    const result = await script(args(path))

    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe(
      'В файле есть ставки моделей, но нет курса кредита (rubPerCredit). Ставки без курса не записываются: добавьте курс и основание (basis).\n',
    )
    expect(await stored([sol])).toEqual({ rates: [], prices: [], audit: [] })
  })

  it('counts the pack and gift credits of the workspaces and a tariff somebody still has', async () => {
    const base = await command(args(ratesFile({})))
    expect(base.failure).toBeNull()
    const outstanding = (printed: string) => {
      const found =
        /из пакетов — (\d+) \((\d+\.\d{2}) ₽ учётной стоимости\), подарочные — (\d+) \((\d+\.\d{2}) ₽\)/.exec(
          printed,
        )
      if (found === null) throw new Error('The line of outstanding credits is missing')
      return {
        pack: Number(found[1]),
        packRub: found[2],
        gift: Number(found[3]),
        giftRub: found[4],
      }
    }
    const before = outstanding(base.printed)

    const { workspaceId } = await fixtures.workspace()
    await db.billingAccount.createMany({
      data: [
        { workspaceId, unit: 'credit_tariff', balance: 300 },
        { workspaceId, unit: 'credit_gift', balance: 35, held: 35 },
        { workspaceId, unit: 'credit_pack', balance: 240 },
      ],
    })
    // Off sale, and this workspace still has it: 100 credits for 1 000 RUB.
    const plan = await fixtures.plan({ price: '1000.00', creditsPerMonth: 100, isActive: false })
    await fixtures.subscription({ workspaceId, planId: plan.id })

    const next = await command(args(ratesFile({ rubPerCredit: '6.500000' })))

    expect(next.failure).toBe(
      'Курс и ставки не записаны.\n- Нужно подтверждение --confirm-exposure: учётная стоимость тарифа выше половины его цены либо курс отличается от действующего больше чем на 10 % (строки выше).',
    )
    expect(next.printed).toContain(
      `  ${plan.slug} (тариф): 100 кредитов — 650.00 ₽, 65.0 % цены 1000.00 ₽\n`,
    )
    expect(next.printed).toContain(
      `Учётная стоимость выше половины цены у тарифов: ${plan.slug}.\n`,
    )
    const after = outstanding(next.printed)
    expect(after.pack - before.pack).toBe(240)
    expect(after.gift - before.gift).toBe(35)
    expect(after.packRub).toBe((after.pack * 6.5).toFixed(2))
    expect(after.giftRub).toBe((after.gift * 6.5).toFixed(2))
  })
})

const moscowSeconds = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})
/** A moment as the command prints it for the eye. */
const moscow = (moment: Date) => `${moscowSeconds.format(moment).replace(',', '')} МСК`
