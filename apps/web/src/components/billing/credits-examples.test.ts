import { Money, taskCharge, toCredits } from '@repo/domain'
import { describe, expect, it } from 'vitest'

import type { CreditConversion } from './billing-types'
import {
  creditDefinition,
  creditPromises,
  DAY_RULE,
  exactCalculation,
  ORIENTATION_HEADINGS,
  orientationList,
  REVISION_RULE,
  roundingRule,
  WORK_UNIT,
} from './credits-examples'

// The block «Как считаются кредиты», sentence by sentence, and that the table it prints gives
// the charges of the worked examples.

/** GPT-6 Sol at 4.65 RUB a Codex credit and 6.00 RUB in a credit, as the server prints it. */
const SOL = {
  model: null,
  input: '38.75',
  cacheRead: '3.88',
  cacheWrite: '38.75',
  output: '193.75',
}
const one = (row: CreditConversion['rows'][number] = SOL): CreditConversion => ({ rows: [row] })

describe('what a credit is', () => {
  it('defines the credit in one sentence, with the usual and the average cost of a task', () => {
    expect(creditDefinition()).toBe(
      'Кредит — это единица, в которой мы считаем работу Радити над вашей задачей: чем больше нужно прочитать и изменить на сайте, тем больше кредитов; небольшая правка обычно стоит 5 кредитов, а в среднем задача — около 11.',
    )
  })

  it('lists what a request usually costs, in the words of the customer', () => {
    expect(ORIENTATION_HEADINGS).toEqual({
      request: 'Что вы просите',
      cost: 'Сколько это стоит',
    })
    expect(orientationList()).toEqual([
      { request: 'Поменять текст, цену, телефон или фото', cost: 'обычно 5 кредитов' },
      {
        request: 'Добавить блок, баннер или страницу, поправить оформление',
        cost: 'обычно 15–25 кредитов',
      },
      {
        request: 'Большая задача: несколько страниц, новая форма, сложная логика',
        cost: 'обычно 25–40 кредитов',
      },
    ])
  })

  it('makes the three promises of the charge', () => {
    expect(creditPromises()).toEqual([
      'Кредиты списываются только за выполненную задачу — не меньше 5 за задачу.',
      'Больше 45 кредитов без вашего согласия задача не потратит: если она окажется больше, мы спросим, продолжать ли.',
      'Каждое списание видно в «Использовании»: задача, сайт, дата и сколько кредитов.',
    ])
  })

  it('says what the daily limit counts and how often the calculation may change', () => {
    expect(DAY_RULE).toBe(
      'В дневной лимит входят кредиты по тарифу, отложенные под задачи за день, — в том числе на продолжение задачи и повторную попытку. Когда задача закончится, в лимите дня останется только то, что за неё списано, а остальное вернётся. Если при списании задачу оплатят кредиты по тарифу вместо отложенных под неё подарочных кредитов или кредитов из пакета, эти кредиты по тарифу войдут в лимит дня списания. Подарочные кредиты и кредиты из пакета дневным лимитом не ограничены. День считается по московскому времени.',
    )
    expect(REVISION_RULE).toBe(
      'Расчёт кредитов и примеры мы можем уточнять не чаще раза в квартал и предупредим об этом за 10 дней. Число кредитов в тарифе и на вашем счёте при этом не меняется — меняется то, сколько кредитов стоит задача.',
    )
  })

  it('names the unit of the work of a model nowhere but in «Точный расчёт»', () => {
    const outside = [
      creditDefinition(),
      ...orientationList().flatMap(({ request, cost }) => [request, cost]),
      ...creditPromises(),
      DAY_RULE,
      REVISION_RULE,
      roundingRule(),
    ]
    for (const text of outside) expect(text).not.toMatch(/токен/i)
    // The word and its explanation stand in one constant: another word costs one edit.
    expect(WORK_UNIT).toEqual({
      definition:
        'Объём работы считается в токенах — так называют единицы текста, которыми оперирует модель: один токен — примерно слог или короткое слово.',
      perMillion: 'За 1 млн токенов',
    })
  })

  it('speaks to the customer on «вы», without English, receipts or VAT', () => {
    const texts = [
      creditDefinition(),
      ...orientationList().flatMap(({ request, cost }) => [request, cost]),
      ...creditPromises(),
      DAY_RULE,
      REVISION_RULE,
      exactCalculation(one())?.text ?? '',
      roundingRule(),
    ]
    for (const text of texts) {
      expect(text).not.toMatch(/[A-Za-z]|НДС|чек|₽|руб/i)
      expect(text).not.toMatch(/(?:^|[^а-яё])(?:ты|тебя|тебе|твой|твоя|твоё|твои)(?:[^а-яё]|$)/i)
    }
  })
})

describe('«Точный расчёт»', () => {
  it('is not shown without a table: no credit rate is usable', () => {
    expect(exactCalculation(null)).toBeNull()
    expect(exactCalculation({ rows: [] })).toBeNull()
  })

  it('prints one table in a sentence when one set of prices is in force', () => {
    expect(exactCalculation(one())).toEqual({
      text: 'Объём работы считается в токенах — так называют единицы текста, которыми оперирует модель: один токен — примерно слог или короткое слово. За 1 млн токенов нового текста — 38,75 кредита, повторно прочитанного — 3,88, написанного — 193,75.',
      table: null,
      rounding:
        'Итог по задаче округляется до целого кредита; за выполненную задачу списывается не меньше 5. Таблица округлена до сотых, поэтому при пересчёте вручную итог может отличаться на один кредит; точный расчёт — в «Использовании».',
    })
  })

  it('groups the digits of a count of four digits and keeps the two decimals', () => {
    expect(
      exactCalculation(one({ ...SOL, input: '1162.50', cacheWrite: '1162.50', output: '12000.00' }))
        ?.text,
    ).toContain(
      'нового текста — 1 162,50 кредита, повторно прочитанного — 3,88, написанного — 12 000,00.',
    )
  })

  it('names the price of text kept for reading again only when a model has one of its own', () => {
    expect(exactCalculation(one({ ...SOL, cacheWrite: '48.44' }))?.text).toContain(
      'За 1 млн токенов нового текста — 38,75 кредита, сохранённого для повторного чтения — 48,44, повторно прочитанного — 3,88, написанного — 193,75.',
    )
    expect(exactCalculation(one())?.text).not.toContain('сохранённого')
  })

  it('prints a row per model, by its name, when the models are costed by different prices', () => {
    const exact = exactCalculation({
      rows: [
        { ...SOL, model: 'Модель А' },
        { ...SOL, model: 'Модель Б', output: '200.00' },
      ],
    })
    expect(exact).toEqual({
      text: 'Объём работы считается в токенах — так называют единицы текста, которыми оперирует модель: один токен — примерно слог или короткое слово. За 1 млн токенов, в кредитах:',
      table: {
        label: 'За 1 млн токенов, по моделям',
        columns: ['Новый текст', 'Повторно прочитанный', 'Написанный'],
        rows: [
          { model: 'Модель А', cells: ['38,75', '3,88', '193,75'] },
          { model: 'Модель Б', cells: ['38,75', '3,88', '200,00'] },
        ],
      },
      rounding: roundingRule(),
    })
  })

  it('adds the column of text kept for reading again when one of the models has its price', () => {
    const exact = exactCalculation({
      rows: [
        { ...SOL, model: 'Модель А' },
        { ...SOL, model: 'Модель Б', cacheWrite: '48.44' },
      ],
    })
    expect(exact?.table).toMatchObject({
      columns: [
        'Новый текст',
        'Сохранённый для повторного чтения',
        'Повторно прочитанный',
        'Написанный',
      ],
      rows: [
        { model: 'Модель А', cells: ['38,75', '38,75', '3,88', '193,75'] },
        { model: 'Модель Б', cells: ['38,75', '48,44', '3,88', '193,75'] },
      ],
    })
  })

  describe('the printed table and the charges of the worked examples', () => {
    /** The three numbers the customer reads in the sentence, as they would count with them. */
    function printedTable() {
      const text = exactCalculation(one())?.text ?? ''
      const numbers = [...text.matchAll(/— (\d[\d ]*,\d{2})/g)].map(([, value = '']) =>
        value.replaceAll(' ', '').replace(',', '.'),
      )
      const [input = '', cacheRead = '', output = ''] = numbers
      expect(numbers).toHaveLength(3)
      return { input, cacheRead, output }
    }
    /** A task by hand: four fifths of what the model read came from its cache. */
    function byHand(inputTokens: number, outputTokens: number) {
      const table = printedTable()
      const millions = (tokens: number) => new Money(tokens).div(1_000_000)
      return millions(inputTokens)
        .mul('0.2')
        .mul(table.input)
        .plus(millions(inputTokens).mul('0.8').mul(table.cacheRead))
        .plus(millions(outputTokens).mul(table.output))
    }
    const charged = (inputTokens: number, outputTokens: number, reserved = 45) =>
      taskCharge({ used: byHand(inputTokens, outputTokens), reserved: toCredits(reserved) }).credits

    it.each([
      ['a small edit: 250 thousand tokens in, 5 thousand out', 250_000, 5_000, '3.68', 5],
      ['a new block: 1.2 million in, 20 thousand out', 1_200_000, 20_000, '16.90', 17],
      ['a big task: 2 million in, 40 thousand out', 2_000_000, 40_000, '29.46', 29],
      ['the same block after one clarification', 1_500_000, 25_000, '21.12', 21],
      ['three small edits in one message', 750_000, 15_000, '11.05', 11],
    ])('gives the charge of %s', (_case, input, output, credits, charge) => {
      expect(byHand(input, output).toFixed(2)).toBe(credits)
      expect(charged(input, output)).toBe(charge)
    })

    it('gives the minimum for no billable work, and never more than was set aside', () => {
      expect(charged(0, 0)).toBe(5)
      // About 49.7 credits of work against a reserve of 45, and of 12.
      expect(byHand(3_400_000, 66_000).toNumber()).toBeGreaterThan(45)
      expect(charged(3_400_000, 66_000)).toBe(45)
      expect(charged(3_400_000, 66_000, 12)).toBe(12)
    })
  })
})
