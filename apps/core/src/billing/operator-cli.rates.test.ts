import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { CreditRatePreview, CreditRateRefusal } from '@repo/billing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  billingHelp,
  parseBillingArguments,
  ratesFileProblemText,
  ratesRefusalText,
  ratesReport,
  runBillingCommand,
} from './operator-cli.ts'

const REFUSED = /^Неверные параметры команды биллинга\. Используйте --help\.$/
/** The options a text names, as an operator would copy them. */
const optionsNamed = (text: string) => [...new Set(text.match(/--[a-z][a-z-]*/g))]
const READ = [
  '--file',
  '--reason',
  '--operator',
  '--effective-from',
  '--confirm-exposure',
  '--confirm-mixed-models',
]

describe('billing:rates options', () => {
  it('reads the file and the reason; nothing is confirmed unless said', () => {
    expect(parseBillingArguments('rates', ['--file', 'q4.json', '--reason', 'Ставки Q4'])).toEqual({
      command: 'rates',
      help: false,
      value: {
        file: 'q4.json',
        reason: 'Ставки Q4',
        confirmExposure: false,
        confirmMixedModels: false,
      },
    })
  })

  it('reads the start as an instant with its offset, and the two confirmations', () => {
    expect(
      parseBillingArguments('rates', [
        '--',
        '--confirm-mixed-models',
        '--file',
        '/srv/rates/2026-q4.json',
        '--effective-from',
        '2026-11-01T00:00:00+03:00',
        '--reason',
        '  Новый квартал  ',
        '--confirm-exposure',
        '--operator',
        'Виктория',
      ]),
    ).toEqual({
      command: 'rates',
      help: false,
      value: {
        file: '/srv/rates/2026-q4.json',
        reason: 'Новый квартал',
        operator: 'Виктория',
        effectiveFrom: new Date('2026-10-31T21:00:00.000Z'),
        confirmExposure: true,
        confirmMixedModels: true,
      },
    })
  })

  it.each([
    ['2026-11-01T00:00Z', '2026-11-01T00:00:00.000Z'],
    ['2026-11-01T00:00:00Z', '2026-11-01T00:00:00.000Z'],
    ['2026-11-01T00:00:00.5Z', '2026-11-01T00:00:00.500Z'],
    ['2026-11-01T00:00:00.123Z', '2026-11-01T00:00:00.123Z'],
    ['2026-11-01T03:00:00.123+03:00', '2026-11-01T00:00:00.123Z'],
    ['2026-10-31T19:00:00-05:00', '2026-11-01T00:00:00.000Z'],
    // The last day of a month, the last moment of a day and 29 February of a leap year exist.
    ['2026-10-31T23:59:59.999+03:00', '2026-10-31T20:59:59.999Z'],
    ['2028-02-29T00:00:00+03:00', '2028-02-28T21:00:00.000Z'],
  ])('takes the instant %s', (written, instant) => {
    const options = parseBillingArguments('rates', [
      '--file',
      'f',
      '--reason',
      'r',
      '--effective-from',
      written,
    ])
    expect(options).toMatchObject({ value: { effectiveFrom: new Date(instant) } })
  })

  const base = ['--file', 'rates.json', '--reason', 'r']
  it.each([
    ['no option', []],
    ['no file', ['--reason', 'r']],
    ['no reason', ['--file', 'rates.json']],
    ['the file without its option', ['rates.json', '--reason', 'r']],
    ['the file named twice', [...base, '--file', 'other.json']],
    ['an empty reason', ['--file', 'rates.json', '--reason', ' ']],
    ['a confirmation said twice', [...base, '--confirm-exposure', '--confirm-exposure']],
    ['a confirmation with a value', [...base, '--confirm-exposure', 'yes']],
    ['an option of another command', [...base, '--take-credits']],
    ['a dry run nobody offers', [...base, '--dry-run']],
    ['a start without a value', [...base, '--effective-from']],
    // Read by the clock of whoever runs the command: refused, not guessed.
    ['a start without an offset', [...base, '--effective-from', '2026-11-01T00:00:00']],
    ['a start that is a date alone', [...base, '--effective-from', '2026-11-01']],
    ['a start with microseconds', [...base, '--effective-from', '2026-11-01T00:00:00.123456Z']],
    ['a start that is no moment', [...base, '--effective-from', '2026-13-01T00:00:00Z']],
    // JavaScript would read these as 2 March, 1 December, 1 March and 2 November: refused, so
    // that the row never starts at a moment the operator did not write.
    ['a day the month does not have', [...base, '--effective-from', '2026-02-30T00:00:00Z']],
    ['the 31st of a month of 30 days', [...base, '--effective-from', '2026-11-31T00:00:00+03:00']],
    [
      '29 February of a year that is not a leap year',
      [...base, '--effective-from', '2027-02-29T00:00:00+03:00'],
    ],
    ['the hour 24', [...base, '--effective-from', '2026-11-01T24:00:00Z']],
    ['a start in words', [...base, '--effective-from', 'завтра']],
    ['a rate on the command line', [...base, '--rub-per-credit', '6.00']],
  ])('refuses %s with the fixed text', (_, args) => {
    expect(() => parseBillingArguments('rates', args)).toThrow(REFUSED)
  })

  it('says in its help what the file holds and what each option is for', () => {
    const usage = billingHelp('rates')
    expect(optionsNamed(usage).sort()).toEqual([...READ].sort())
    for (const field of [
      'rubPerCredit',
      'basis',
      'prices',
      'provider',
      'model',
      'inputPer1m',
      'cacheReadPer1m',
      'cacheWritePer1m',
      'outputPer1m',
      'vatRate',
      'sourceUrl',
    ]) {
      expect(usage).toContain(field)
    }
    expect(usage).toContain('Пустой prices — изменение одного курса.')
    expect(usage).toContain(
      '\n--confirm-exposure — нужен, когда учётная стоимость тарифа выше половины его цены или курс отличается от действующего больше чем на 10 %.\n',
    )
    expect(usage).toContain(
      '\n--confirm-mixed-models — нужен, когда у включённых моделей одного класса оказались бы разные ставки.\n',
    )
    // Unlike the other commands, a second run is a second row.
    expect(usage).toContain('Повтор команды не безопасен')
    expect(usage).toContain('Нужны APP_ENV и DATABASE_URL.\n')
  })
})

describe('billing:rates report', () => {
  const START = new Date('2026-10-11T09:00:00.000Z')
  const preview = (patch: Partial<CreditRatePreview> = {}): CreditRatePreview => ({
    effectiveFrom: START,
    rubPerCredit: '6.000000',
    previous: null,
    movePercent: null,
    plans: [
      {
        slug: 'start',
        kind: 'quota',
        price: '4900.00',
        credits: 300,
        costRub: '1800.00',
        sharePercent: '36.7',
      },
      {
        slug: 'pack',
        kind: 'pack',
        price: '1990.00',
        credits: 100,
        costRub: '600.00',
        sharePercent: '30.2',
      },
    ],
    outstanding: {
      pack: { credits: 1240, costRub: '7440.00' },
      gift: { credits: 385, costRub: '2310.00' },
    },
    steps: [
      { modelClass: 'light', credits: 20, costRub: '120.00', aboveKeyLimit: false },
      { modelClass: 'standard', credits: 45, costRub: '270.00', aboveKeyLimit: false },
      { modelClass: 'heavy', credits: 120, costRub: '720.00', aboveKeyLimit: false },
    ],
    models: [
      {
        provider: 'openai-chatgpt',
        model: 'gpt-6-sol-standard',
        modelClass: 'standard',
        listed: true,
        creditsPer1m: { input: '38.75', cacheRead: '3.88', cacheWrite: '38.75', output: '193.75' },
      },
    ],
    mixedClasses: [],
    exposure: { plans: [], move: false, confirmationNeeded: false },
    ...patch,
  })

  it('prints the first rate: the plans, what is not spent, the steps and the models', () => {
    expect(ratesReport(preview())).toEqual([
      'Начало действия: 11.10.2026 12:00:00 МСК (2026-10-11T09:00:00.000Z).',
      'На момент начала действующего курса нет. Новый курс — 6.000000 ₽ учётной стоимости за кредит.',
      'Учётная стоимость тарифов и пакетов, выбранных целиком (кредиты × курс), и её доля в цене:',
      '  start (тариф): 300 кредитов — 1800.00 ₽, 36.7 % цены 4900.00 ₽',
      '  pack (пакет): 100 кредитов — 600.00 ₽, 30.2 % цены 1990.00 ₽',
      'Не потраченные кредиты всех рабочих пространств: из пакетов — 1240 (7440.00 ₽ учётной стоимости), подарочные — 385 (2310.00 ₽).',
      'Шаги попытки при этом курсе (предел одного ключа хода — 750 ₽): light — 20 кредитов, 120.00 ₽; standard — 45 кредитов, 270.00 ₽; heavy — 120 кредитов, 720.00 ₽.',
      'Кредитов за 1 млн токенов по включённым моделям (вход / кэш / запись в кэш / выход):',
      '  openai-chatgpt/gpt-6-sol-standard (standard): 38.75 / 3.88 / 38.75 / 193.75 — ставки из файла',
    ])
  })

  it('prints a change: the rate in force, the move and everything that asks for a confirmation', () => {
    const lines = ratesReport(
      preview({
        rubPerCredit: '9.000000',
        previous: { rubPerCredit: '6.000000', effectiveFrom: new Date('2026-06-30T21:00:00Z') },
        movePercent: '+50.00',
        plans: [
          {
            slug: 'start',
            kind: 'quota',
            price: '4900.00',
            credits: 300,
            costRub: '2700.00',
            sharePercent: '55.1',
          },
          {
            slug: 'free',
            kind: 'quota',
            price: '0.00',
            credits: 10,
            costRub: '90.00',
            sharePercent: null,
          },
        ],
        steps: [
          { modelClass: 'light', credits: 20, costRub: '180.00', aboveKeyLimit: false },
          { modelClass: 'standard', credits: 45, costRub: '405.00', aboveKeyLimit: false },
          { modelClass: 'heavy', credits: 120, costRub: '1080.00', aboveKeyLimit: true },
        ],
        models: [
          {
            provider: 'openai-chatgpt',
            model: 'gpt-6-sol-standard',
            modelClass: 'standard',
            listed: false,
            creditsPer1m: {
              input: '25.83',
              cacheRead: '2.58',
              cacheWrite: '25.83',
              output: '129.17',
            },
          },
          {
            provider: 'kimi-code',
            model: 'k3-256k-standard',
            modelClass: 'standard',
            listed: true,
            creditsPer1m: null,
          },
        ],
        mixedClasses: ['standard', 'heavy'],
        exposure: { plans: ['start', 'free'], move: true, confirmationNeeded: true },
      }),
    )
    expect(lines).toEqual([
      'Начало действия: 11.10.2026 12:00:00 МСК (2026-10-11T09:00:00.000Z).',
      'Действующий курс — 6.000000 ₽ за кредит, с 01.07.2026 00:00:00 МСК (2026-06-30T21:00:00.000Z). Новый курс — 9.000000 ₽, изменение +50.00 %.',
      'Учётная стоимость тарифов и пакетов, выбранных целиком (кредиты × курс), и её доля в цене:',
      '  start (тариф): 300 кредитов — 2700.00 ₽, 55.1 % цены 4900.00 ₽',
      '  free (тариф): 10 кредитов — 90.00 ₽, цена нулевая',
      'Не потраченные кредиты всех рабочих пространств: из пакетов — 1240 (7440.00 ₽ учётной стоимости), подарочные — 385 (2310.00 ₽).',
      'Шаги попытки при этом курсе (предел одного ключа хода — 750 ₽): light — 20 кредитов, 180.00 ₽; standard — 45 кредитов, 405.00 ₽; heavy — 120 кредитов, 1080.00 ₽.',
      '  Шаг выше предела ключа: heavy. Такая попытка получит несколько ключей хода подряд.',
      'Кредитов за 1 млн токенов по включённым моделям (вход / кэш / запись в кэш / выход):',
      '  openai-chatgpt/gpt-6-sol-standard (standard): 25.83 / 2.58 / 25.83 / 129.17 — прежние ставки',
      '  kimi-code/k3-256k-standard (standard): ставки нет — модель не сможет работать',
      'Разные ставки у включённых моделей одного класса: standard, heavy. Одна и та же задача будет стоить разное число кредитов в зависимости от аккаунта пула.',
      'Учётная стоимость выше половины цены у тарифов: start, free.',
      'Курс отличается от действующего больше чем на 10 %.',
    ])
  })

  it('says so when nothing is on sale and no model is switched on', () => {
    const lines = ratesReport(preview({ plans: [], models: [] }))
    expect(lines).toContain('Тарифов и пакетов в продаже нет.')
    expect(lines).toContain('Включённых моделей нет.')
  })

  it('lets no slug of the catalogue write to the terminal', () => {
    const lines = ratesReport(
      preview({
        plans: [
          {
            slug: 'start\u001b[2J',
            kind: 'quota',
            price: '1.00',
            credits: 1,
            costRub: '6.00',
            sharePercent: '600.0',
          },
        ],
        models: [
          {
            provider: 'p\n',
            model: 'm\u009b',
            modelClass: 'standard',
            listed: true,
            creditsPer1m: null,
          },
        ],
        exposure: { plans: ['start\u001b[2J'], move: false, confirmationNeeded: true },
      }),
    ).join('\n')
    // eslint-disable-next-line no-control-regex -- the test is about control characters
    expect(lines.replaceAll('\n', '')).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/)
    expect(lines).toContain('start??2J (тариф)')
    expect(lines).toContain('p?/m? (standard)')
  })

  const refusals: CreditRateRefusal[] = [
    { reason: 'unknown_model', provider: 'openai-chatgpt', model: 'gpt-7' },
    { reason: 'instant_past', now: new Date('2026-10-11T09:00:00.123Z') },
    {
      reason: 'instant_not_newest',
      newest: new Date('2026-10-31T21:00:00.000Z'),
      table: 'credit_rates',
    },
    {
      reason: 'instant_not_newest',
      newest: new Date('2026-10-31T21:00:00.000Z'),
      table: 'llm_model_prices',
    },
    {
      reason: 'enabled_model_price_newer',
      provider: 'kimi-code',
      model: 'k3-256k-standard',
      priceFrom: new Date('2026-10-31T21:00:00.000Z'),
    },
    { reason: 'exposure_unconfirmed' },
    { reason: 'mixed_models_unconfirmed', classes: ['standard'] },
  ]

  it('says why the rate was not written, each reason in its own words', () => {
    expect(refusals.map(ratesRefusalText)).toEqual([
      'В каталоге нет модели openai-chatgpt/gpt-7: проверьте slug провайдера и модели в файле.',
      'Момент начала раньше текущего времени базы данных — 11.10.2026 12:00:00 МСК (2026-10-11T09:00:00.123Z). Задним числом курс и ставки не записываются.',
      'Момент начала не позже самой новой строки курса: она начинается 01.11.2026 00:00:00 МСК (2026-10-31T21:00:00.000Z). Новая строка должна начинаться позже всех существующих: задайте --effective-from позже этого момента.',
      'Момент начала не позже самой новой строки ставок моделей: она начинается 01.11.2026 00:00:00 МСК (2026-10-31T21:00:00.000Z). Новая строка должна начинаться позже всех существующих: задайте --effective-from позже этого момента.',
      'У включённой модели kimi-code/k3-256k-standard есть ставка, которая начинается позже — 01.11.2026 00:00:00 МСК (2026-10-31T21:00:00.000Z). Курс оказался бы старше этой ставки, и резервировать кредиты стало бы нельзя.',
      'Нужно подтверждение --confirm-exposure: учётная стоимость тарифа выше половины его цены либо курс отличается от действующего больше чем на 10 % (строки выше).',
      'Нужно подтверждение --confirm-mixed-models: у включённых моделей одного класса разные ставки (standard).',
    ])
  })

  it('sends the operator only to options the command reads', () => {
    const texts = [
      ...refusals.map(ratesRefusalText),
      ratesFileProblemText({ problem: 'prices_without_rate' }),
      ratesFileProblemText({ problem: 'invalid', fields: ['prices.0.inputPer1m'] }),
    ]
    for (const option of optionsNamed(texts.join(' '))) {
      // --help is read by every command before its own options.
      expect([...READ, '--help']).toContain(option)
    }
  })

  it('says what is wrong with a file of rates', () => {
    expect(ratesFileProblemText({ problem: 'prices_without_rate' })).toBe(
      'В файле есть ставки моделей, но нет курса кредита (rubPerCredit). Ставки без курса не записываются: добавьте курс и основание (basis).',
    )
    expect(
      ratesFileProblemText({
        problem: 'invalid',
        fields: ['rubPerCredit', 'prices.0.inputPer1m', '(файл)'],
      }),
    ).toBe(
      'Файл ставок не прошёл проверку. Поля: rubPerCredit, prices.0.inputPer1m, (файл). Формат — в --help.',
    )
    // A path is made of the names of the schema; anything else would not reach the terminal.
    expect(ratesFileProblemText({ problem: 'invalid', fields: ['a\u001b[2Jb'] })).toBe(
      'Файл ставок не прошёл проверку. Поля: a??2Jb. Формат — в --help.',
    )
  })
})

describe('billing:rates before the database', () => {
  let directory: string
  const env = {
    APP_ENV: 'test',
    // Nothing listens there: a command that got as far as the database fails on it.
    DATABASE_URL: 'postgresql://raditi:private-password@127.0.0.1:1/raditi',
  }
  const run = (file: string, write = vi.fn<(text: string) => void>()) =>
    runBillingCommand(
      'rates',
      ['--file', file, '--reason', 'r', '--operator', 'operator-test'],
      env,
      write,
    )
  const stored = (name: string, content: string) => {
    const path = join(directory, name)
    writeFileSync(path, content)
    return path
  }

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'raditi-billing-rates-test-'))
  })
  afterAll(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('refuses a file it cannot read, without saying why', async () => {
    await expect(run(join(directory, 'missing.json'))).rejects.toThrow(
      /^Файл ставок не прочитан: проверьте путь и права доступа\.$/,
    )
    await expect(run(directory)).rejects.toThrow(/^Файл ставок не прочитан/)
  })

  it('refuses a file that is not JSON and one that is too large to be rates', async () => {
    await expect(run(stored('text.json', 'rubPerCredit: 6'))).rejects.toThrow(
      /^Файл ставок не разобран: это не JSON\.$/,
    )
    await expect(run(stored('large.json', ' '.repeat(1_048_577)))).rejects.toThrow(
      /^Файл ставок слишком большой/,
    )
  })

  it('refuses prices without a rate before it prints or reads anything', async () => {
    const write = vi.fn<(text: string) => void>()
    const file = stored(
      'prices-only.json',
      JSON.stringify({
        basis: 'Ставки без курса',
        prices: [
          {
            provider: 'openai-chatgpt',
            model: 'gpt-6-sol-standard',
            inputPer1m: '232.5',
            cacheReadPer1m: '23.25',
            cacheWritePer1m: null,
            outputPer1m: '1162.5',
            vatRate: '0.22',
            sourceUrl: 'https://rates.example/q4',
          },
        ],
      }),
    )
    await expect(run(file, write)).rejects.toThrow(
      /^В файле есть ставки моделей, но нет курса кредита \(rubPerCredit\)\. Ставки без курса не записываются/,
    )
    expect(write).not.toHaveBeenCalled()
  })

  it('names the fields of a file that does not pass', async () => {
    const file = stored(
      'broken.json',
      JSON.stringify({ rubPerCredit: 6, basis: '', prices: [{ provider: 'p' }] }),
    )
    const failure = run(file)
    await expect(failure).rejects.toThrow(/^Файл ставок не прошёл проверку\. Поля: /)
    await expect(failure).rejects.toThrow(/rubPerCredit/)
    await expect(failure).rejects.toThrow(/prices\.0\.inputPer1m/)
  })

  it('prints what it is about to do, then hides why the database could not be reached', async () => {
    const write = vi.fn<(text: string) => void>()
    const file = stored(
      'rate.json',
      JSON.stringify({ rubPerCredit: '6.000000', basis: 'Первый курс', prices: [] }),
    )
    await expect(run(file, write)).rejects.toThrow(
      /^Команда биллинга не завершена\. Проверьте окружение и доступность базы данных и ЮKassa\.$/,
    )
    expect(write.mock.calls.map(([text]) => text)).toEqual([
      'Действие: утвердить курс кредита 6.000000 ₽ учётной стоимости за кредит; ставки моделей не меняются.\n',
      'Оператор: operator-test. Причина: r\n',
      'Основание: Первый курс\n',
    ])
  })
})
