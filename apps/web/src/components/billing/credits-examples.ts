import {
  attemptStepCredits,
  averageTaskCredits,
  minTaskChargeCredits,
  typicalTaskCredits,
  type TypicalCredits,
} from '@repo/domain/billing/credit-numbers'

import { formatCount } from '@/lib/count'

import type { CreditConversion } from './billing-types'
import { creditsOf, creditsWord } from './plan-format'

// The block «Как считаются кредиты» in words: what a credit is, what a request usually costs,
// what the customer is promised, and — one level deeper — the exact conversion. Every number is
// a constant of the credits model or comes from the server: the examples are estimates until
// the reference basket is measured on the model that runs, and each is written once. The
// sentences come out with plain spaces: the component that prints one passes it through nbsp().

/** «5 кредитов», «15–25 кредитов»: what a kind of request costs. */
const range = ({ from, to }: TypicalCredits) =>
  `${from === to ? to : `${from}–${to}`} ${creditsWord(to)}`

/** What a credit is, in one sentence. */
export function creditDefinition(): string {
  return `Кредит — это единица, в которой мы считаем работу Радити над вашей задачей: чем больше нужно прочитать и изменить на сайте, тем больше кредитов; небольшая правка обычно стоит ${range(typicalTaskCredits.small)}, а в среднем задача — около ${averageTaskCredits}.`
}

/** The headings of the orientation list. */
export const ORIENTATION_HEADINGS = {
  request: 'Что вы просите',
  cost: 'Сколько это стоит',
} as const

/** The orientation list: the customer's way to tell what a request will cost, in their words. */
export function orientationList(): { request: string; cost: string }[] {
  const { small, block, large } = typicalTaskCredits
  return [
    { request: 'Поменять текст, цену, телефон или фото', cost: `обычно ${range(small)}` },
    {
      request: 'Добавить блок, баннер или страницу, поправить оформление',
      cost: `обычно ${range(block)}`,
    },
    {
      request: 'Большая задача: несколько страниц, новая форма, сложная логика',
      cost: `обычно ${range(large)}`,
    },
  ]
}

/** The three promises: each is a rule of the charge, not a slogan. */
export function creditPromises(): string[] {
  const step = attemptStepCredits.standard
  return [
    `Кредиты списываются только за выполненную задачу — не меньше ${minTaskChargeCredits} за задачу.`,
    `Больше ${step} ${creditsOf(step)} без вашего согласия задача не потратит: если она окажется больше, мы спросим, продолжать ли.`,
    'Каждое списание видно в «Использовании»: задача, сайт, дата и сколько кредитов.',
  ]
}

/**
 * What the daily limit counts: tariff credits only, by the day they were set aside on, and what
 * a charge took of them in place of gift or pack credits on the day of the charge.
 */
export const DAY_RULE =
  'В дневной лимит входят кредиты по тарифу, отложенные под задачи за день, — в том числе на продолжение задачи и повторную попытку. Когда задача закончится, в лимите дня останется только то, что за неё списано, а остальное вернётся. Если при списании задачу оплатят кредиты по тарифу вместо отложенных под неё подарочных кредитов или кредитов из пакета, эти кредиты по тарифу войдут в лимит дня списания. Подарочные кредиты и кредиты из пакета дневным лимитом не ограничены. День считается по московскому времени.'

/** How often the calculation may be revised, and what a revision does not touch. */
export const REVISION_RULE =
  'Расчёт кредитов и примеры мы можем уточнять не чаще раза в квартал и предупредим об этом за 10 дней. Число кредитов в тарифе и на вашем счёте при этом не меняется — меняется то, сколько кредитов стоит задача.'

/**
 * The unit of a model's work. The one place the customer is told the word «токен», with its
 * explanation — an exception to «no jargon» the owner has not confirmed yet (question 12 of the
 * credits design): if he does not, these two strings say «единиц текста» and nothing else
 * changes.
 */
export const WORK_UNIT = {
  definition:
    'Объём работы считается в токенах — так называют единицы текста, которыми оперирует модель: один токен — примерно слог или короткое слово.',
  perMillion: 'За 1 млн токенов',
} as const

/** «38,75», «1 162,50»: a count of the table as it is printed. */
function printed(value: string): string {
  const [whole = '0', fraction = '00'] = value.split('.')
  return `${formatCount(Number(whole))},${fraction}`
}

type ConversionRow = CreditConversion['rows'][number]

/** A model that keeps text for reading again at a price of its own: one more number. */
const hasOwnCacheWrite = (row: ConversionRow) => row.cacheWrite !== row.input

/** «…нового текста — 38,75 кредита, повторно прочитанного — 3,88, написанного — 193,75.» */
function perMillion(row: ConversionRow): string {
  const kept = hasOwnCacheWrite(row)
    ? `, сохранённого для повторного чтения — ${printed(row.cacheWrite)}`
    : ''
  return `${WORK_UNIT.perMillion} нового текста — ${printed(row.input)} кредита${kept}, повторно прочитанного — ${printed(row.cacheRead)}, написанного — ${printed(row.output)}.`
}

/** How a task is rounded, and why a count by hand may differ. */
export function roundingRule(): string {
  return `Итог по задаче округляется до целого кредита; за выполненную задачу списывается не меньше ${minTaskChargeCredits}. Таблица округлена до сотых, поэтому при пересчёте вручную итог может отличаться на один кредит; точный расчёт — в «Использовании».`
}

/** «Точный расчёт» as the block prints it. */
export interface ExactCalculation {
  /** What the unit is, and — when one table is in force for every model — its numbers. */
  text: string
  /**
   * One row per model, by its name, when the models are costed by different prices; null when
   * the sentence above carries the one table.
   */
  table: {
    /** The accessible name of the table. */
    label: string
    columns: string[]
    rows: { model: string; cells: string[] }[]
  } | null
  rounding: string
}

/**
 * «Точный расчёт» from the table the server sends; null when it sends none — no credit rate is
 * usable, or no model has a price in force — and the block is not shown.
 */
export function exactCalculation(conversion: CreditConversion | null): ExactCalculation | null {
  if (conversion === null) return null
  const [only, ...others] = conversion.rows
  if (only === undefined) return null
  if (others.length === 0 && only.model === null) {
    return {
      text: `${WORK_UNIT.definition} ${perMillion(only)}`,
      table: null,
      rounding: roundingRule(),
    }
  }
  const withCacheWrite = conversion.rows.some(hasOwnCacheWrite)
  return {
    text: `${WORK_UNIT.definition} ${WORK_UNIT.perMillion}, в кредитах:`,
    table: {
      label: `${WORK_UNIT.perMillion}, по моделям`,
      columns: [
        'Новый текст',
        ...(withCacheWrite ? ['Сохранённый для повторного чтения'] : []),
        'Повторно прочитанный',
        'Написанный',
      ],
      rows: conversion.rows.map((row) => ({
        model: row.model ?? 'Все модели',
        cells: [
          printed(row.input),
          ...(withCacheWrite ? [printed(row.cacheWrite)] : []),
          printed(row.cacheRead),
          printed(row.output),
        ],
      })),
    },
    rounding: roundingRule(),
  }
}
