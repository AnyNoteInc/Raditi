import { paymentMethodLabel } from '@repo/domain'
import { describe, expect, it, vi } from 'vitest'

import { renderTemplate } from './index.ts'
import { mailDataSchemas, type MailData, type RenderedEmail } from './schemas.ts'

const APP_URL = 'https://raditi.ru'
const PLANS_URL = 'https://raditi.ru/settings/plans'
const CARD = 'Карта «Мир» ••\u00a04444'
const PERIOD_END = '2026-10-18T09:30:00.000Z' // 12:30 on 18 October in Moscow
/** Three days before PERIOD_END, 10:00 in Moscow. */
const NOW = new Date('2026-10-15T07:00:00.000Z')

const paidPlan = {
  item: 'plan',
  planName: 'Бизнес',
  amount: '12900.00',
  periodEnd: PERIOD_END,
  credits: 800,
  appUrl: APP_URL,
} as const satisfies MailData['payment-succeeded']

const paidPack = {
  item: 'pack',
  packCredits: 100,
  amount: '1990.00',
  appUrl: APP_URL,
} as const satisfies MailData['payment-succeeded']

const renewalNotice: MailData['renewal-notice'] = {
  planName: 'Бизнес',
  amount: '12900.00',
  chargeAt: PERIOD_END,
  paymentMethod: CARD,
  appUrl: APP_URL,
}

const paymentFailed: MailData['payment-failed'] = {
  planName: 'Бизнес',
  amount: '12900.00',
  paymentMethod: CARD,
  giftCreditsLeft: 0,
  appUrl: APP_URL,
}

const subscriptionEnded: MailData['subscription-ended'] = {
  planName: 'Бизнес',
  endedAt: PERIOD_END,
  packCreditsLeft: 7,
  giftCreditsLeft: 0,
  appUrl: APP_URL,
}

/** The gift of the registration, untouched: enough to start a task without a paid tariff. */
const GIFT = 35
const ON_GIFT = 'принимаются, только пока есть подарочные кредиты'

const letters: [name: string, render: () => RenderedEmail, button: string][] = [
  ['a paid tariff', () => renderTemplate('payment-succeeded', paidPlan), 'Открыть «Тарифы»'],
  ['a paid pack', () => renderTemplate('payment-succeeded', paidPack), 'Открыть «Тарифы»'],
  [
    'the renewal notice',
    () => renderTemplate('renewal-notice', renewalNotice, NOW),
    'Открыть «Тарифы»',
  ],
  [
    'the renewal notice sent after the charge',
    () => renderTemplate('renewal-notice', renewalNotice, new Date(PERIOD_END)),
    'Открыть «Тарифы»',
  ],
  ['a failed charge', () => renderTemplate('payment-failed', paymentFailed), 'Открыть «Тарифы»'],
  [
    'a failed charge while the gift takes tasks',
    () => renderTemplate('payment-failed', { ...paymentFailed, giftCreditsLeft: GIFT }),
    'Открыть «Тарифы»',
  ],
  [
    'the end of a tariff',
    () => renderTemplate('subscription-ended', subscriptionEnded),
    'Выбрать тариф',
  ],
  [
    'the end of a tariff while the gift takes tasks',
    () => renderTemplate('subscription-ended', { ...subscriptionEnded, giftCreditsLeft: GIFT }),
    'Выбрать тариф',
  ],
]

const HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
}

/** What a reader of the HTML version sees: the text of every paragraph, a <br> as a line break. */
function htmlParagraphs(html: string): string[] {
  return [...html.matchAll(/<p[^>]*>(.*?)<\/p>/gs)].map(([, inner = '']) =>
    inner
      .replaceAll('<br>', '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => HTML_ENTITIES[entity] ?? entity),
  )
}

describe.each(letters)('the letter about %s', (_name, render, buttonLabel) => {
  const out = render()

  it('says the same in the HTML and the text version', () => {
    const blocks = out.text.split('\n\n')
    const footer = blocks.pop()
    // The last sentence names the «Тарифы» page; the text version puts the link under it.
    const [action, link] = (blocks.pop() ?? '').split('\n')

    expect(link).toBe(PLANS_URL)
    expect(htmlParagraphs(out.html)).toEqual([
      ...blocks,
      action,
      buttonLabel,
      `Если кнопка не открывается, скопируйте ссылку в браузер:\n${PLANS_URL}`,
      footer,
    ])
  })

  it('links only to the «Тарифы» page', () => {
    const hrefs = [...out.html.matchAll(/href="([^"]*)"/g)].map(([, href]) => href)
    expect(hrefs).toEqual([PLANS_URL, PLANS_URL])
  })

  it('greets without a name', () => {
    expect(out.text.startsWith('Здравствуйте!\n\n')).toBe(true)
  })

  it('promises no receipt and names no tax', () => {
    for (const version of [out.subject, out.text, out.html]) {
      expect(version).not.toMatch(/чек|ндс|налог|квитанц/i)
    }
  })
})

describe('payment-succeeded', () => {
  it('names the tariff, the amount, the day the tariff lasts to and the credits it gave', () => {
    const out = renderTemplate('payment-succeeded', paidPlan)

    expect(out.subject).toBe('Оплата прошла')
    expect(out.text).toContain('Оплата прошла: тариф «Бизнес» — 12\u00a0900\u00a0₽.')
    expect(out.text).toContain(
      '\n\nТариф действует до 18\u00a0октября 2026. Начислили 800 кредитов на этот период.\n\n',
    )
    expect(out.html).toContain('Начислили 800 кредитов на этот период.')
  })

  it.each([
    [1, 'Начислили 1 кредит на этот период.'],
    [2, 'Начислили 2 кредита на этот период.'],
    [5, 'Начислили 5 кредитов на этот период.'],
    [11, 'Начислили 11 кредитов на этот период.'],
    [21, 'Начислили 21 кредит на этот период.'],
    [22, 'Начислили 22 кредита на этот период.'],
    [300, 'Начислили 300 кредитов на этот период.'],
    [301, 'Начислили 301 кредит на этот период.'],
    // A count of four digits is grouped as the amount is, and its groups do not break.
    [2500, 'Начислили 2\u00a0500 кредитов на этот период.'],
  ])('writes the %i credits of a paid tariff as «%s»', (credits, shown) => {
    const out = renderTemplate('payment-succeeded', { ...paidPlan, credits })
    expect(out.text).toContain(shown)
    expect(out.html).toContain(shown)
  })

  it('names the pack and its amount, and no period', () => {
    const out = renderTemplate('payment-succeeded', paidPack)

    expect(out.subject).toBe('Оплата прошла')
    expect(out.text).toContain('Оплата прошла: пакет из 100 кредитов — 1\u00a0990\u00a0₽.')
    expect(out.text).toContain('Кредиты из пакета уже добавлены и не сгорают в конце периода.')
    expect(out.text).not.toContain('действует до')
    // The sentence about the credits of a period belongs to a tariff.
    expect(out.text).not.toContain('Начислили')
  })

  it.each([
    [1, 'пакет из 1 кредита'],
    [2, 'пакет из 2 кредитов'],
    [5, 'пакет из 5 кредитов'],
    [11, 'пакет из 11 кредитов'],
    [21, 'пакет из 21 кредита'],
    [22, 'пакет из 22 кредитов'],
    [25, 'пакет из 25 кредитов'],
    [100, 'пакет из 100 кредитов'],
    [101, 'пакет из 101 кредита'],
    [1000, 'пакет из 1\u00a0000 кредитов'],
  ])('writes a pack of %i credits as «%s»', (packCredits, shown) => {
    const out = renderTemplate('payment-succeeded', { ...paidPack, packCredits })
    expect(out.text).toContain(`${shown} —`)
  })

  it('shows kopecks only when the amount has them', () => {
    const out = renderTemplate('payment-succeeded', { ...paidPack, amount: '1990.50' })
    expect(out.text).toContain('1\u00a0990,50\u00a0₽')
  })
})

describe('renewal-notice', () => {
  const render = (now: string | Date, data = renewalNotice) =>
    renderTemplate('renewal-notice', data, new Date(now))

  it('names the amount, the day, the payment method and how to switch auto-renewal off', () => {
    const out = render(NOW)

    expect(out.subject).toBe('Скоро спишем 12\u00a0900\u00a0₽ за тариф «Бизнес»')
    expect(out.text).toContain(
      'Через 3 дня, 18\u00a0октября 2026, спишем 12\u00a0900\u00a0₽ за тариф «Бизнес»: у вас включено автопродление.',
    )
    expect(out.text).toContain(`Способ оплаты: ${CARD}.`)
    expect(out.text).toContain(
      `отключите автопродление на странице «Тарифы» до списания.\n${PLANS_URL}`,
    )
  })

  it.each([
    ['five days before', '2026-10-13T07:00:00.000Z', 'Через 5 дней, 18\u00a0октября 2026, спишем'],
    ['two days before', '2026-10-16T20:59:00.000Z', 'Через 2 дня, 18\u00a0октября 2026, спишем'],
    // 00:10 on 17 October in Moscow: a letter that waited past midnight counts the new day.
    ['the day before', '2026-10-16T21:10:00.000Z', 'Завтра, 18\u00a0октября 2026, спишем'],
    ['the same day', '2026-10-18T05:00:00.000Z', 'Сегодня, 18\u00a0октября 2026, спишем'],
  ])('counts the days from the moment of sending: %s', (_case, now, start) => {
    expect(render(now).text).toContain(`\n\n${start} 12\u00a0900\u00a0₽`)
  })

  // The charge waits for the notice to be queued, not delivered: a letter may be sent after it.
  it.each([
    ['at the moment of the charge', PERIOD_END],
    ['a minute after the charge, the same day in Moscow', '2026-10-18T09:31:00.000Z'],
    ['on a later day', '2026-10-19T05:00:00.000Z'],
  ])('promises no future charge when it is sent %s', (_case, now) => {
    const out = render(now)

    expect(out.subject).toBe('Списание 12\u00a0900\u00a0₽ за тариф «Бизнес»')
    expect(out.text).toContain(
      '\n\nСписание 12\u00a0900\u00a0₽ за тариф «Бизнес» назначено на 18\u00a0октября 2026: у вас включено автопродление.\n\n',
    )
    expect(out.text).toContain(`Способ оплаты: ${CARD}.`)
    expect(out.text).toContain(
      `Чтобы тариф больше не продлевался, отключите автопродление на странице «Тарифы».\n${PLANS_URL}`,
    )
    for (const part of [out.subject, out.text, out.html]) {
      expect(part).not.toMatch(/спишем|до списания|Скоро|Через|Завтра|Сегодня/)
    }
    // The HTML says the same as the text, in the new wording too.
    expect(out.html).toContain('назначено на 18\u00a0октября 2026: у вас включено автопродление.')
    expect(out.html).toContain('Чтобы тариф больше не продлевался')
  })

  it('still announces a charge that is a second ahead', () => {
    const out = render('2026-10-18T09:29:59.000Z')

    expect(out.subject).toBe('Скоро спишем 12\u00a0900\u00a0₽ за тариф «Бизнес»')
    expect(out.text).toContain('\n\nСегодня, 18\u00a0октября 2026, спишем 12\u00a0900\u00a0₽')
    expect(out.text).toContain('до списания.')
  })

  it('counts from the present moment when none is given', () => {
    vi.useFakeTimers({ now: new Date('2026-10-17T07:00:00.000Z') })
    try {
      expect(renderTemplate('renewal-notice', renewalNotice).text).toContain('\n\nЗавтра, 18')
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    paymentMethodLabel({ type: 'bank_card', cardType: 'Visa', last4: '1234' }),
    paymentMethodLabel({ type: 'bank_card', cardType: null, last4: null }),
    paymentMethodLabel({ type: 'sbp', cardType: null, last4: null }),
    paymentMethodLabel({ type: 'yoo_money', cardType: null, last4: null }),
    paymentMethodLabel({ type: null, cardType: null, last4: null }),
  ])('shows the payment method as the app names it: %s', (paymentMethod) => {
    const out = render(NOW, { ...renewalNotice, paymentMethod })
    expect(out.text).toContain(`Способ оплаты: ${paymentMethod}.`)
  })
})

describe('payment-failed', () => {
  it('names the amount, the tariff and the payment method, and says what to do', () => {
    const out = renderTemplate('payment-failed', paymentFailed)

    expect(out.subject).toBe('Оплата не прошла')
    expect(out.text).toContain('Не получилось списать 12\u00a0900\u00a0₽ за тариф «Бизнес».')
    expect(out.text).toContain(`Способ оплаты: ${CARD}.`)
    expect(out.text).toContain('Пока оплата не пройдёт, новые задачи не принимаются.')
    expect(out.text).toContain(`\n\nОплатить тариф можно на странице «Тарифы».\n${PLANS_URL}`)
  })

  it('offers no replacement of the payment method: only the payment by hand settles the charge', () => {
    // The letter is sent whatever the shop does: where it takes one-time payments only, the
    // pages replace no card, and replacing one never pays for the charge that failed.
    const out = renderTemplate('payment-failed', paymentFailed)

    for (const version of [out.text, out.html]) {
      expect(version).not.toMatch(/замен|привяз|друг(ой|им|ую) (способ|карт)/i)
    }
    // The method is named as the one the charge was tried with, and nothing more is said of it.
    expect(out.text.match(/способ/gi)).toEqual(['Способ'])
  })

  // Gift credits are spent without a paid tariff: the alert of «Тарифы» the letter leads to
  // says «принимаются, только пока есть подарочные кредиты», and the letter must not say the
  // opposite.
  it.each([
    ['the whole gift', GIFT],
    ['exactly what a task needs to start', 5],
  ])('says that tasks are taken on gift credits while %s is left', (_case, giftCreditsLeft) => {
    const out = renderTemplate('payment-failed', { ...paymentFailed, giftCreditsLeft })
    const sentence = `Пока оплата не пройдёт, новые задачи ${ON_GIFT}.`

    expect(out.text).toContain(`\n\n${sentence}\n\n`)
    expect(out.html).toContain(sentence)
    for (const version of [out.text, out.html]) expect(version).not.toContain('не принимаются')
    // What to do is the same: the tariff is still to be paid for.
    expect(out.text).toContain(`\n\nОплатить тариф можно на странице «Тарифы».\n${PLANS_URL}`)
  })

  it.each([
    ['no gift credits are', 0],
    ['fewer gift credits than a task needs to start are', 4],
  ])('says that tasks are not taken while %s left', (_case, giftCreditsLeft) => {
    const out = renderTemplate('payment-failed', { ...paymentFailed, giftCreditsLeft })

    expect(out.text).toContain('\n\nПока оплата не пройдёт, новые задачи не принимаются.\n\n')
    for (const version of [out.text, out.html]) expect(version).not.toMatch(/подарочн/i)
  })
})

describe('subscription-ended', () => {
  it('names the tariff, the day it ended and the pack credits that stay', () => {
    const out = renderTemplate('subscription-ended', subscriptionEnded)

    expect(out.subject).toBe('Тариф закончился')
    expect(out.text).toContain('Тариф «Бизнес» закончился 18\u00a0октября 2026.')
    expect(out.text).toContain('Новые задачи сейчас не принимаются.')
    expect(out.text).toContain(
      'Кредиты из пакета, сайты и история правок сохраняются. Кредитов из пакета осталось: 7.',
    )
    expect(out.text).toContain(`выберите тариф на странице «Тарифы».\n${PLANS_URL}`)
  })

  it('groups the digits of a count of four digits', () => {
    const out = renderTemplate('subscription-ended', {
      ...subscriptionEnded,
      packCreditsLeft: 1200,
    })
    expect(out.text).toContain('Кредитов из пакета осталось: 1\u00a0200.')
  })

  it('does not mention pack credits when none remain, nor a gift that is not there', () => {
    const out = renderTemplate('subscription-ended', { ...subscriptionEnded, packCreditsLeft: 0 })

    expect(out.text).toContain('\n\nСайты и история правок сохраняются.\n\n')
    expect(out.text).not.toMatch(/кредит|пакет|подарочн/i)
    expect(out.html).not.toMatch(/кредит|пакет|подарочн/i)
  })

  // Gift credits are spent without a tariff: the «Тарифы» page the letter leads to says
  // «Новые задачи принимаются, только пока есть подарочные кредиты», and the letter must not
  // say the opposite, nor send the reader for a tariff «to set tasks again».
  it.each([
    ['the whole gift', GIFT],
    ['exactly what a task needs to start', 5],
  ])('says that tasks are taken on gift credits while %s is left', (_case, giftCreditsLeft) => {
    const out = renderTemplate('subscription-ended', { ...subscriptionEnded, giftCreditsLeft })
    const ended = `Тариф «Бизнес» закончился 18\u00a0октября 2026. Новые задачи ${ON_GIFT}.`
    const action =
      'Когда подарочные кредиты закончатся, понадобится тариф: выбрать его можно на странице «Тарифы».'

    expect(out.subject).toBe('Тариф закончился')
    expect(out.text).toContain(`\n\n${ended}\n\n`)
    expect(out.text).toContain(`\n\n${action}\n${PLANS_URL}`)
    for (const version of [out.text, out.html]) {
      expect(version).toContain(ended)
      expect(version).toContain(action)
      expect(version).not.toMatch(/не принимаются|снова/)
    }
  })

  it.each([
    ['no gift credits are', 0],
    ['fewer gift credits than a task needs to start are', 4],
  ])('says that tasks are not taken while %s left', (_case, giftCreditsLeft) => {
    const out = renderTemplate('subscription-ended', { ...subscriptionEnded, giftCreditsLeft })

    expect(out.text).toContain(
      '\n\nТариф «Бизнес» закончился 18\u00a0октября 2026. Новые задачи сейчас не принимаются.\n\n',
    )
    expect(out.text).toContain(
      `\n\nЧтобы снова ставить задачи, выберите тариф на странице «Тарифы».\n${PLANS_URL}`,
    )
    for (const version of [out.text, out.html]) expect(version).not.toContain(ON_GIFT)
  })

  it.each([
    [
      'pack and gift credits',
      { packCreditsLeft: 40, giftCreditsLeft: GIFT },
      'Кредиты из пакета и подарочные, сайты и история правок сохраняются. Кредитов из пакета осталось: 40.',
    ],
    [
      'pack credits and a gift too small to start a task',
      { packCreditsLeft: 40, giftCreditsLeft: 3 },
      'Кредиты из пакета и подарочные, сайты и история правок сохраняются. Кредитов из пакета осталось: 40.',
    ],
    [
      'gift credits alone',
      { packCreditsLeft: 0, giftCreditsLeft: GIFT },
      'Подарочные кредиты, сайты и история правок сохраняются.',
    ],
    [
      'one gift credit alone',
      { packCreditsLeft: 0, giftCreditsLeft: 1 },
      'Подарочные кредиты, сайты и история правок сохраняются.',
    ],
    [
      'pack credits alone',
      { packCreditsLeft: 40, giftCreditsLeft: 0 },
      'Кредиты из пакета, сайты и история правок сохраняются. Кредитов из пакета осталось: 40.',
    ],
    [
      'no credits',
      { packCreditsLeft: 0, giftCreditsLeft: 0 },
      'Сайты и история правок сохраняются.',
    ],
  ])('names what is kept after the tariff: %s', (_case, left, kept) => {
    const out = renderTemplate('subscription-ended', { ...subscriptionEnded, ...left })

    expect(out.text).toContain(`\n\n${kept}\n\n`)
    expect(out.html).toContain(kept)
  })

  it('takes the day in Moscow', () => {
    // 00:30 on 1 November in Moscow.
    const out = renderTemplate('subscription-ended', {
      ...subscriptionEnded,
      endedAt: '2026-10-31T21:30:00.000Z',
    })
    expect(out.text).toContain('закончился 1\u00a0ноября 2026.')
  })
})

describe('escaping in billing letters', () => {
  const planName = '<b>"Бизнес" & Ко</b>'

  it('escapes the tariff name in the HTML and its title, and keeps the text as is', () => {
    const out = renderTemplate('renewal-notice', { ...renewalNotice, planName }, NOW)
    const escaped = '&lt;b&gt;&quot;Бизнес&quot; &amp; Ко&lt;/b&gt;'

    expect(out.html).not.toContain('<b>')
    expect(out.html).toContain(
      `<title>Скоро спишем 12\u00a0900\u00a0₽ за тариф «${escaped}»</title>`,
    )
    expect(out.html).toContain(`за тариф «${escaped}»: у вас включено автопродление.`)
    expect(out.text).toContain(`за тариф «${planName}»: у вас включено автопродление.`)
  })

  it('escapes the payment method', () => {
    const out = renderTemplate('payment-failed', { ...paymentFailed, paymentMethod: '<i>СБП</i>' })

    expect(out.html).toContain('Способ оплаты: &lt;i&gt;СБП&lt;/i&gt;.')
  })
})

describe('billing letter data', () => {
  const valid = {
    'payment-succeeded': paidPlan,
    'renewal-notice': renewalNotice,
    'payment-failed': paymentFailed,
    'subscription-ended': subscriptionEnded,
  } satisfies Partial<MailData>
  type BillingKind = keyof typeof valid
  const kinds = Object.keys(valid) as BillingKind[]

  const accepts = (kind: BillingKind, data: unknown) =>
    mailDataSchemas[kind].safeParse(data).success
  const withField = (kind: BillingKind, field: string, value: unknown) => ({
    ...valid[kind],
    [field]: value,
  })

  it.each(kinds)('accepts the data of %s and drops fields the letter does not use', (kind) => {
    const parsed = mailDataSchemas[kind].parse({ ...valid[kind], name: 'Анна', userId: 'user-1' })
    expect(parsed).toEqual(valid[kind])
  })

  it('accepts a paid pack', () => {
    expect(mailDataSchemas['payment-succeeded'].parse(paidPack)).toEqual(paidPack)
  })

  it.each(kinds)('requires every field of %s', (kind) => {
    for (const field of Object.keys(valid[kind])) {
      expect(accepts(kind, withField(kind, field, undefined)), field).toBe(false)
    }
  })

  it.each([
    ['without decimals', '12900'],
    ['with one decimal', '12900.5'],
    ['with three decimals', '12900.000'],
    ['with a comma', '12900,00'],
    ['grouped for reading', '12 900.00'],
    ['with a currency sign', '12900.00 ₽'],
    ['negative', '-12900.00'],
    ['with a leading zero', '012900.00'],
    ['in exponent notation', '1.29e4'],
    ['wider than Decimal(12,2)', '12345678901.00'],
    ['empty', ''],
    ['a number', 12900],
  ])('refuses an amount %s', (_case, amount) => {
    for (const kind of ['payment-succeeded', 'renewal-notice', 'payment-failed'] as const) {
      expect(accepts(kind, withField(kind, 'amount', amount)), kind).toBe(false)
    }
    expect(accepts('payment-succeeded', { ...paidPack, amount })).toBe(false)
  })

  it.each(['0.00', '0.05', '990.00', '12900.00', '9999999999.99'])(
    'accepts the amount %s',
    (amount) => {
      expect(accepts('payment-failed', withField('payment-failed', 'amount', amount))).toBe(true)
    },
  )

  it.each([
    ['a date without a time', '2026-10-18'],
    ['a time without a zone', '2026-10-18T09:30:00'],
    ['a Russian date', '18.10.2026'],
    ['a day that does not exist', '2026-02-30T09:30:00.000Z'],
    ['a timestamp', 1792315800000],
    ['empty', ''],
  ])('refuses %s as a date', (_case, date) => {
    expect(accepts('payment-succeeded', withField('payment-succeeded', 'periodEnd', date))).toBe(
      false,
    )
    expect(accepts('renewal-notice', withField('renewal-notice', 'chargeAt', date))).toBe(false)
    expect(accepts('subscription-ended', withField('subscription-ended', 'endedAt', date))).toBe(
      false,
    )
  })

  it('accepts a date with an offset', () => {
    const data = withField('renewal-notice', 'chargeAt', '2026-10-18T12:30:00+03:00')
    expect(accepts('renewal-notice', data)).toBe(true)
  })

  it.each([
    ['empty', ''],
    ['only spaces', ' \u00a0 '],
    ['longer than plans.name', 'Я'.repeat(101)],
    ['two lines', 'Бизнес\nВаш аккаунт заблокирован'],
    ['a line separator', 'Бизнес\u2028Ваш аккаунт заблокирован'],
    ['a tab', 'Бизнес\tПлюс'],
    ['a bidi override', 'Бизнес\u202Eur.live'],
    ['a zero-width space', 'Биз\u200Bнес'],
    ['not a string', 42],
  ])('refuses a tariff name or a payment method that is %s', (_case, value) => {
    for (const kind of kinds) {
      expect(accepts(kind, withField(kind, 'planName', value)), kind).toBe(false)
    }
    for (const kind of ['renewal-notice', 'payment-failed'] as const) {
      expect(accepts(kind, withField(kind, 'paymentMethod', value)), kind).toBe(false)
    }
  })

  it.each(['Старт', 'Бизнес', 'Агентство', 'Я'.repeat(100)])(
    'accepts the tariff name %s',
    (name) => {
      for (const kind of kinds)
        expect(accepts(kind, withField(kind, 'planName', name)), kind).toBe(true)
    },
  )

  it.each([
    { type: 'bank_card', cardType: 'Mir', last4: '4444' },
    { type: 'bank_card', cardType: 'MasterCard', last4: '0001' },
    { type: 'bank_card', cardType: 'Maestro', last4: null },
    { type: 'sbp', cardType: null, last4: null },
    { type: 'sberbank', cardType: null, last4: null },
    { type: 'tinkoff_bank', cardType: null, last4: null },
    { type: 'yoo_money', cardType: null, last4: null },
    { type: 'something_new', cardType: null, last4: null },
    { type: null, cardType: null, last4: null },
  ])('accepts the label of the payment method $type $cardType', (method) => {
    const label = paymentMethodLabel(method)
    const parsed = mailDataSchemas['payment-failed'].parse(
      withField('payment-failed', 'paymentMethod', label),
    )
    expect(parsed.paymentMethod).toBe(label)
  })

  it.each([
    ['a script link', 'javascript:alert(1)'],
    ['a data link', 'data:text/html,hi'],
    ['a bare host', 'raditi.ru'],
    ['empty', ''],
  ])('refuses %s as the app address', (_case, appUrl) => {
    for (const kind of kinds)
      expect(accepts(kind, withField(kind, 'appUrl', appUrl)), kind).toBe(false)
    expect(accepts('payment-succeeded', { ...paidPack, appUrl })).toBe(false)
  })

  it.each([
    ['zero', 0],
    ['negative', -10],
    ['a fraction', 1.5],
    ['a string', '10'],
    ['not finite', Number.POSITIVE_INFINITY],
    ['missing', undefined],
  ])('refuses a pack size that is %s', (_case, packCredits) => {
    expect(accepts('payment-succeeded', { ...paidPack, packCredits })).toBe(false)
  })

  it.each([
    ['zero', 0],
    ['negative', -300],
    ['a fraction', 299.5],
    ['a string', '300'],
    ['not finite', Number.POSITIVE_INFINITY],
    ['missing', undefined],
  ])('refuses the credits of a paid tariff that are %s', (_case, credits) => {
    expect(accepts('payment-succeeded', { ...paidPlan, credits })).toBe(false)
  })

  it.each([
    ['negative', -1],
    ['a fraction', 0.5],
    ['a string', '7'],
    ['a decimal string', '7.00'],
    ['not a number', Number.NaN],
  ])('refuses a count of remaining pack credits that is %s', (_case, packCreditsLeft) => {
    const data = withField('subscription-ended', 'packCreditsLeft', packCreditsLeft)
    expect(accepts('subscription-ended', data)).toBe(false)
  })

  it('accepts zero remaining pack credits', () => {
    expect(
      accepts('subscription-ended', withField('subscription-ended', 'packCreditsLeft', 0)),
    ).toBe(true)
  })

  it.each([
    ['negative', -1],
    ['a fraction', 4.5],
    ['a string', '35'],
    ['a decimal string', '35.00'],
    ['not a number', Number.NaN],
    ['not finite', Number.POSITIVE_INFINITY],
    ['missing', undefined],
  ])('refuses a count of remaining gift credits that is %s', (_case, giftCreditsLeft) => {
    for (const kind of ['payment-failed', 'subscription-ended'] as const) {
      expect(accepts(kind, withField(kind, 'giftCreditsLeft', giftCreditsLeft)), kind).toBe(false)
    }
  })

  it.each([0, 4, 5, 35])('accepts %i remaining gift credits', (giftCreditsLeft) => {
    for (const kind of ['payment-failed', 'subscription-ended'] as const) {
      expect(accepts(kind, withField(kind, 'giftCreditsLeft', giftCreditsLeft)), kind).toBe(true)
    }
  })

  it.each([
    ['is missing', undefined],
    ['is unknown', 'topup'],
  ])('refuses a paid item that %s', (_case, item) => {
    expect(accepts('payment-succeeded', { ...paidPlan, item })).toBe(false)
  })

  it('refuses a tariff described as a pack and a pack described as a tariff', () => {
    expect(accepts('payment-succeeded', { ...paidPlan, item: 'pack' })).toBe(false)
    expect(accepts('payment-succeeded', { ...paidPack, item: 'plan' })).toBe(false)
  })

  it('refuses invalid data before rendering', () => {
    expect(() => renderTemplate('renewal-notice', { ...renewalNotice, amount: '12900' })).toThrow()
    expect(() => renderTemplate('payment-succeeded', { ...paidPack, packCredits: 0 })).toThrow()
  })
})
