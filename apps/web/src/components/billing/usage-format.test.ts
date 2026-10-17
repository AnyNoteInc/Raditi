import { describe, expect, it } from 'vitest'

import { taskCreditsFor, type TaskFacts } from './testing'
import {
  buyPackLabel,
  creditsLeftWords,
  giftNote,
  heldEarlierNote,
  heldNote,
  ofDailyLimit,
  ofSiteLimit,
  outcomeText,
  packCredits,
  packNote,
  sitesMeterLabel,
  sitesNote,
  tariffMeterLabel,
  tariffNote,
  tariffRestEntry,
  taskNote,
  OUTSIDE_THE_DAY,
  todayMeterLabel,
  todayNote,
  todaySpent,
  unpaidWhileTasksTaken,
  usagePeriod,
  usageWithoutTariff,
  type TariffCredits,
  type TariffState,
} from './usage-format'

/** The text as it reads: dates come with non-breaking spaces. */
const plain = (text: string) => text.replaceAll(String.fromCharCode(0xa0), ' ')

const periodEnd = new Date('2026-10-18T09:00:00Z')
const business = { name: 'Бизнес', creditsPerMonth: 800, creditsPerDay: 100 }

/** «Бизнес», active and renewing on 18 October, unless told otherwise. */
const tariff = (patch: Partial<TariffState> = {}): TariffState => ({
  status: 'active',
  periodEnd,
  autoRenewal: true,
  nextPlan: business,
  changes: false,
  ...patch,
})

describe('the period of a tariff', () => {
  it('names the tariff and its period, the year once', () => {
    expect(
      plain(usagePeriod('Бизнес', { start: new Date('2026-09-18T09:00:00Z'), end: periodEnd })),
    ).toBe('Тариф «Бизнес» · 18 сентября — 18 октября 2026')
  })

  it('says both years of a period that crosses the new year', () => {
    expect(
      plain(
        usagePeriod('Старт', {
          start: new Date('2026-12-18T09:00:00Z'),
          end: new Date('2027-01-18T09:00:00Z'),
        }),
      ),
    ).toBe('Тариф «Старт» · 18 декабря 2026 — 18 января 2027')
  })

  it('counts the days by Moscow time', () => {
    // 22:30 UTC on 17 September is 01:30 on the 18th in Moscow.
    expect(
      plain(
        usagePeriod('Бизнес', {
          start: new Date('2026-09-17T22:30:00Z'),
          end: new Date('2026-10-17T22:30:00Z'),
        }),
      ),
    ).toBe('Тариф «Бизнес» · 18 сентября — 18 октября 2026')
  })
})

describe('the credits of a tariff', () => {
  it.each([
    [0, 'кредитов осталось'],
    [1, 'кредит остался'],
    [2, 'кредита осталось'],
    [4, 'кредита осталось'],
    [5, 'кредитов осталось'],
    [11, 'кредитов осталось'],
    [14, 'кредитов осталось'],
    [21, 'кредит остался'],
    [22, 'кредита осталось'],
    [25, 'кредитов осталось'],
    [55, 'кредитов осталось'],
    [101, 'кредит остался'],
    [111, 'кредитов осталось'],
  ])('puts the words after the headline number %i', (count, words) => {
    expect(creditsLeftWords(count)).toBe(words)
  })

  /** A meter that adds up: what was granted is what was charged, set aside, expired and left. */
  const meter = (patch: Partial<TariffCredits>): TariffCredits => {
    const parts = { charged: 0, held: 0, expired: 0, left: 0, heldEarlier: 0, ...patch }
    return {
      ...parts,
      granted: patch.granted ?? parts.charged + parts.held + parts.expired + parts.left,
    }
  }

  it('names the meter by every number its legend shows', () => {
    // The example of the design.
    expect(tariffMeterLabel(meter({ charged: 89, held: 45, left: 166 }), false)).toBe(
      'Из 300 кредитов по тарифу: 89 списано, 45 отложено под задачи в работе, 166 осталось',
    )
    expect(tariffMeterLabel(meter({ charged: 800 }), false)).toBe(
      'Из 800 кредитов по тарифу: 800 списано, 0 отложено под задачи в работе, 0 осталось',
    )
    expect(tariffMeterLabel(meter({ left: 21 }), false)).toBe(
      'Из 21 кредита по тарифу: 0 списано, 0 отложено под задачи в работе, 21 осталось',
    )
    expect(tariffMeterLabel(meter({ left: 1 }), false)).toBe(
      'Из 1 кредита по тарифу: 0 списано, 0 отложено под задачи в работе, 1 осталось',
    )
    expect(tariffMeterLabel(meter({ left: 300 }), false)).toBe(
      'Из 300 кредитов по тарифу: 0 списано, 0 отложено под задачи в работе, 300 осталось',
    )
    expect(tariffRestEntry(45, false)).toBe('Осталось — 45')
  })

  it('says what expired only when something of the period did', () => {
    expect(tariffMeterLabel(meter({ charged: 65, held: 45, expired: 24, left: 166 }), false)).toBe(
      'Из 300 кредитов по тарифу: 65 списано, 45 отложено под задачи в работе, 166 осталось, 24 сгорело',
    )
    expect(tariffMeterLabel(meter({ charged: 65, left: 235 }), false)).not.toContain('сгорело')
    // Credits of the period before are beside the meter: its name does not count them.
    expect(tariffMeterLabel(meter({ left: 300, heldEarlier: 45 }), false)).toBe(
      'Из 300 кредитов по тарифу: 0 списано, 0 отложено под задачи в работе, 300 осталось',
    )
  })

  // The name of a meter is read by assistive technology as it is: plain spaces in the groups.
  it('groups the digits of a count of four digits', () => {
    expect(tariffMeterLabel(meter({ charged: 1200, held: 45, left: 1255 }), false)).toBe(
      'Из 2 500 кредитов по тарифу: 1 200 списано, 45 отложено под задачи в работе, 1 255 осталось',
    )
    expect(tariffMeterLabel(meter({ held: 1000, expired: 1100, left: 1500 }), true)).toBe(
      'Из 3 600 кредитов по тарифу: 0 списано, 1 000 отложено под задачи в работе, 1 500 не использовано, 1 100 сгорело',
    )
    expect(tariffRestEntry(2500, false)).toBe('Осталось — 2 500')
    expect(tariffRestEntry(1255, true)).toBe('Не использовано — 1 255')
  })

  it('does not call the rest of a period that is over «left»', () => {
    // The tariff is not paid for: what the period did not use is not carried over.
    expect(tariffMeterLabel(meter({ charged: 34, held: 1, left: 765 }), true)).toBe(
      'Из 800 кредитов по тарифу: 34 списано, 1 отложено под задачи в работе, 765 не использовано',
    )
    expect(tariffRestEntry(45, true)).toBe('Не использовано — 45')
  })

  it('says under the meter what becomes of the credits that are set aside', () => {
    expect(heldNote()).toBe(
      'Отложенное спишем по факту: сколько уйдёт на работу, но не меньше 5 кредитов за выполненную задачу. Остальное вернётся.',
    )
  })

  it.each([
    [1, 'Ещё 1 кредит прошлого периода отложен под задачу в работе.'],
    [2, 'Ещё 2 кредита прошлого периода отложено под задачу в работе.'],
    [45, 'Ещё 45 кредитов прошлого периода отложено под задачу в работе.'],
    [21, 'Ещё 21 кредит прошлого периода отложен под задачу в работе.'],
    [1200, 'Ещё 1 200 кредитов прошлого периода отложено под задачу в работе.'],
  ])('tells of %i credits of the period before that are still set aside', (held, first) => {
    expect(heldEarlierNote(held)).toBe(`${first} Что не уйдёт на неё, в новый период не перейдёт.`)
  })

  it('says when the next quota comes and that the rest is not carried over', () => {
    expect(plain(tariffNote(tariff()))).toBe(
      '18 октября начислим новые 800. Остаток по тарифу на новый период не переносится.',
    )
    expect(
      plain(
        tariffNote(
          tariff({ nextPlan: { name: 'Агентство', creditsPerMonth: 2500, creditsPerDay: 300 } }),
        ),
      ),
    ).toBe('18 октября начислим новые 2 500. Остаток по тарифу на новый период не переносится.')
  })

  it('names the tariff of the next period when a change is scheduled', () => {
    expect(
      plain(
        tariffNote(
          tariff({
            nextPlan: { name: 'Старт', creditsPerMonth: 300, creditsPerDay: 50 },
            changes: true,
          }),
        ),
      ),
    ).toBe(
      '18 октября начислим 300 кредитов по тарифу «Старт». Остаток по тарифу на новый период не переносится.',
    )
    expect(
      plain(
        tariffNote(
          tariff({
            nextPlan: { name: 'Агентство', creditsPerMonth: 2500, creditsPerDay: 300 },
            changes: true,
          }),
        ),
      ),
    ).toContain('начислим 2 500 кредитов по тарифу «Агентство».')
    expect(
      plain(
        tariffNote(
          tariff({
            nextPlan: { name: 'Проба', creditsPerMonth: 1, creditsPerDay: 1 },
            changes: true,
          }),
        ),
      ),
    ).toContain('начислим 1 кредит по тарифу «Проба».')
    expect(
      plain(
        tariffNote(
          tariff({
            nextPlan: { name: 'Проба', creditsPerMonth: 22, creditsPerDay: 2 },
            changes: true,
          }),
        ),
      ),
    ).toContain('начислим 22 кредита по тарифу «Проба».')
  })

  it('promises no new quota to a tariff that does not renew', () => {
    expect(plain(tariffNote(tariff({ autoRenewal: false })))).toBe(
      'Тариф действует до 18 октября и не продлится. Остаток по тарифу после этого сгорит.',
    )
  })

  it('ties the next quota of an overdue tariff to its payment', () => {
    for (const autoRenewal of [true, false]) {
      expect(plain(tariffNote(tariff({ status: 'past_due', autoRenewal })))).toBe(
        'Период тарифа закончился 18 октября. Новые кредиты начислим после оплаты, остаток прошлого периода не переносится.',
      )
    }
  })
})

describe('the credits of a pack', () => {
  it('says when they start to be spent', () => {
    expect(packNote({ left: 10, held: 0 }, { tariff: 45, gift: 0 }, true)).toBe(
      'Кредиты из пакета не сгорают. Начнут тратиться, когда закончатся кредиты по тарифу.',
    )
    expect(packNote({ left: 7, held: 0 }, { tariff: 0, gift: 0 }, true)).toBe(
      'Кредиты из пакета не сгорают. Сейчас задачи тратят их: кредиты по тарифу закончились.',
    )
  })

  it('explains them to a customer who has none', () => {
    expect(packNote({ left: 0, held: 0 }, { tariff: 45, gift: 0 }, true)).toBe(
      'Кредиты из пакета не сгорают и тратятся последними — после кредитов по тарифу и подарочных.',
    )
  })

  it('mentions the pack credits that are in work', () => {
    expect(packNote({ left: 7, held: 2 }, { tariff: 0, gift: 0 }, true)).toBe(
      'Кредиты из пакета не сгорают. Сейчас задачи тратят их: кредиты по тарифу закончились. Ещё 2 отложено под задачи в работе.',
    )
    expect(packNote({ left: 0, held: 1 }, { tariff: 0, gift: 0 }, true)).toBe(
      'Кредиты из пакета не сгорают и тратятся последними — после кредитов по тарифу и подарочных. Ещё 1 отложено под задачи в работе.',
    )
    expect(packNote({ left: 200, held: 1000 }, { tariff: 0, gift: 0 }, true)).toContain(
      'Ещё 1 000 отложено под задачи в работе.',
    )
  })

  it('ties them to the payment of a tariff that takes no tasks', () => {
    // Whatever the tariff account holds: nothing is spent until the tariff is paid for.
    for (const tariffLeft of [0, 45]) {
      expect(packNote({ left: 7, held: 0 }, { tariff: tariffLeft, gift: 0 }, false)).toBe(
        'Кредиты из пакета не сгорают. Станут доступны после оплаты тарифа.',
      )
    }
    expect(packNote({ left: 7, held: 1 }, { tariff: 0, gift: 0 }, false)).toBe(
      'Кредиты из пакета не сгорают. Станут доступны после оплаты тарифа. Ещё 1 отложено под задачи в работе.',
    )
    expect(packNote({ left: 0, held: 0 }, { tariff: 45, gift: 0 }, false)).toBe(
      'Кредиты из пакета не сгорают и тратятся последними — после кредитов по тарифу и подарочных.',
    )
  })

  it.each([
    [100, true, 'Купить ещё 100 кредитов — 1 990 ₽'],
    [100, false, 'Купить 100 кредитов — 1 990 ₽'],
    [10, true, 'Купить ещё 10 кредитов — 1 990 ₽'],
    [1000, false, 'Купить 1 000 кредитов — 1 990 ₽'],
    [1, true, 'Купить ещё 1 кредит — 1 990 ₽'],
    [2, true, 'Купить ещё 2 кредита — 1 990 ₽'],
    [3, false, 'Купить 3 кредита — 1 990 ₽'],
    [5, false, 'Купить 5 кредитов — 1 990 ₽'],
    [11, false, 'Купить 11 кредитов — 1 990 ₽'],
    [21, true, 'Купить ещё 21 кредит — 1 990 ₽'],
    [22, false, 'Купить 22 кредита — 1 990 ₽'],
    [25, true, 'Купить ещё 25 кредитов — 1 990 ₽'],
    [101, false, 'Купить 101 кредит — 1 990 ₽'],
  ])('labels the offer of a pack of %i credits', (credits, more, label) => {
    // Plain spaces all through: a button is looked up by its exact name.
    expect(buyPackLabel(credits, '1990.00', more)).toBe(label)
  })

  it('prints the kopecks of a price that has them', () => {
    expect(buyPackLabel(100, '12990.50', true)).toBe('Купить ещё 100 кредитов — 12 990,50 ₽')
  })

  // The sentence after the count speaks of the credits, so it agrees with their number too.
  const kept = 'Они не сгорают и снова будут доступны, когда вы выберете тариф.'
  const keptOne = 'Он не сгорает и снова будет доступен, когда вы выберете тариф.'

  it.each([
    [1, `У вас 1 кредит из пакета. ${keptOne}`],
    [2, `У вас 2 кредита из пакета. ${kept}`],
    [5, `У вас 5 кредитов из пакета. ${kept}`],
    [10, `У вас 10 кредитов из пакета. ${kept}`],
    [11, `У вас 11 кредитов из пакета. ${kept}`],
    [21, `У вас 21 кредит из пакета. ${keptOne}`],
    [22, `У вас 22 кредита из пакета. ${kept}`],
    [25, `У вас 25 кредитов из пакета. ${kept}`],
    [100, `У вас 100 кредитов из пакета. ${kept}`],
    [101, `У вас 101 кредит из пакета. ${keptOne}`],
    [1200, `У вас 1 200 кредитов из пакета. ${kept}`],
  ])('counts the pack credits of a customer without a tariff: %i', (count, text) => {
    expect(packCredits(count)).toBe(text)
  })
})

describe('the limit of the day', () => {
  // The day counts tariff credits (decision of 17.10.2026): «Старт» gives 50 of them a day.
  /** The tariff credits of the day as the server tells them. */
  const dayOf = (limit: number | null, charged: number, held: number, free = 1000) => {
    const used = charged + held
    const room = limit === null ? null : Math.max(0, limit - used)
    return { limit, charged, held, used, room, left: room === null ? free : Math.min(room, free) }
  }

  it.each([
    [1, 'из 1 кредита'],
    [2, 'из 2 кредитов'],
    [21, 'из 21 кредита'],
    [50, 'из 50 кредитов'],
    [100, 'из 100 кредитов'],
    [101, 'из 101 кредита'],
    [300, 'из 300 кредитов'],
    [2500, 'из 2 500 кредитов'],
  ])('puts the limit %i after the number of the day', (limit, text) => {
    expect(ofDailyLimit(limit)).toBe(text)
  })

  it.each([
    [
      dayOf(100, 5, 45),
      'Сегодня из 100 кредитов: 5 списано, 45 отложено под задачи в работе, 50 осталось',
    ],
    [
      dayOf(50, 0, 0),
      'Сегодня из 50 кредитов: 0 списано, 0 отложено под задачи в работе, 50 осталось',
    ],
    [
      dayOf(21, 21, 0),
      'Сегодня из 21 кредита: 21 списано, 0 отложено под задачи в работе, 0 осталось',
    ],
    // A renewal onto a smaller plan: the day took more than the limit of now.
    [
      dayOf(50, 120, 0),
      'Сегодня из 50 кредитов: 120 списано, 0 отложено под задачи в работе, 0 осталось',
    ],
    // Review of M5.33d: what is left is what the tariff can still give — the month may have less.
    [
      dayOf(50, 0, 0, 0),
      'Сегодня из 50 кредитов: 0 списано, 0 отложено под задачи в работе, 0 осталось',
    ],
    [
      dayOf(100, 5, 45, 15),
      'Сегодня из 100 кредитов: 5 списано, 45 отложено под задачи в работе, 15 осталось',
    ],
  ])('names the meter of the day: %o', (today, label) => {
    expect(todayMeterLabel({ ...today, limit: today.limit ?? 0 })).toBe(label)
  })

  it.each([
    [
      dayOf(100, 5, 45),
      'Сегодня потрачено 50 кредитов из 100: 5 списано и 45 отложено под задачи в работе.',
    ],
    [dayOf(100, 5, 0), 'Сегодня потрачено 5 кредитов из 100.'],
    [dayOf(100, 21, 0), 'Сегодня потрачен 21 кредит из 100.'],
    [dayOf(100, 2, 0), 'Сегодня потрачено 2 кредита из 100.'],
    [dayOf(50, 0, 45), 'Сегодня потрачено 45 кредитов из 50: 45 отложено под задачи в работе.'],
  ])('says what the day took: %o', (today, text) => {
    expect(todaySpent(today)).toBe(text)
  })

  it('says nothing of a day that took nothing, or of a tariff without a daily limit', () => {
    expect(todaySpent(dayOf(100, 0, 0))).toBeNull()
    expect(todaySpent(dayOf(null, 5, 45))).toBeNull()
  })

  const note = (patch: Partial<Parameters<typeof todayNote>[0]> = {}) =>
    todayNote({ today: dayOf(100, 5, 45), paid: true, tasksTaken: true, tomorrow: 100, ...patch })
  const outside = 'Подарочные кредиты и кредиты из пакета дневным лимитом не ограничены.'

  it('says how many tariff credits the day still gives, and that the gift and the pack are outside it', () => {
    expect(note()).toBe(`Сегодня можно потратить ещё 50 кредитов. ${outside}`)
    expect(note({ today: dayOf(100, 99, 0) })).toBe(
      `Сегодня можно потратить ещё 1 кредит. ${outside}`,
    )
    expect(note({ today: dayOf(50, 0, 48) })).toBe(
      `Сегодня можно потратить ещё 2 кредита. ${outside}`,
    )
    expect(OUTSIDE_THE_DAY).toBe(outside)
  })

  // C5: tasks in work hold tariff credits that come back — what is free is not «осталось».
  it('says «свободно» when the account has less free than the day leaves', () => {
    expect(note({ today: dayOf(50, 0, 0, 15) })).toBe(
      `Сегодня можно потратить ещё 15 кредитов по тарифу — столько их сейчас свободно. ${outside}`,
    )
  })

  it('says nothing of the day when the tariff has nothing free: the credits say so', () => {
    expect(note({ today: dayOf(50, 0, 0, 0) })).toBe(outside)
  })

  it('sends the customer to tomorrow once the day is spent, while the tariff takes tasks then', () => {
    for (const today of [dayOf(100, 100, 0), dayOf(100, 55, 45), dayOf(50, 120, 0)]) {
      expect(note({ today, tomorrow: today.limit })).toBe(
        `Кредиты по тарифу на сегодня закончились — завтра снова можно будет потратить до ${today.limit}. ${outside}`,
      )
    }
    // C7: a tariff that ends tonight promises no tomorrow.
    expect(note({ today: dayOf(100, 100, 0), tomorrow: null })).toBe(
      `Кредиты по тарифу на сегодня закончились. ${outside}`,
    )
    // Review of M5.33d: the limit of tomorrow is the one the page is told — after a renewal
    // tonight onto another plan, that plan's.
    expect(note({ today: dayOf(300, 300, 0), tomorrow: 50 })).toBe(
      `Кредиты по тарифу на сегодня закончились — завтра снова можно будет потратить до 50. ${outside}`,
    )
  })

  it('says that a tariff without a daily limit has none', () => {
    expect(note({ today: dayOf(null, 5, 45) })).toBe('Дневного лимита на вашем тарифе нет.')
    expect(note({ today: dayOf(null, 0, 0), tasksTaken: false })).toBe(
      'Дневного лимита на вашем тарифе нет.',
    )
  })

  it('puts the unpaid tariff before everything else', () => {
    expect(note({ paid: false, tasksTaken: false, today: null })).toBe(
      'Новые задачи не принимаются, пока не оплачен тариф.',
    )
  })

  it('says of an unpaid tariff that tasks are taken on gift credits while the server takes one', () => {
    const onGift =
      'Пока тариф не оплачен, новые задачи принимаются, только пока есть подарочные кредиты.'
    expect(note({ paid: false, today: null })).toBe(onGift)
    expect(note({ paid: false, tasksTaken: false, today: null })).toBe(
      'Новые задачи не принимаются, пока не оплачен тариф.',
    )
  })
})

describe('the gift credits', () => {
  it('says that they do not expire and where they stand in the order of spending', () => {
    expect(giftNote({ held: 0 })).toBe(
      'Не сгорают. Тратятся после кредитов по тарифу и раньше кредитов из пакета.',
    )
  })

  it('mentions the gift credits that are in work', () => {
    expect(giftNote({ held: 5 })).toBe(
      'Не сгорают. Тратятся после кредитов по тарифу и раньше кредитов из пакета. Ещё 5 отложено под задачи в работе.',
    )
    expect(giftNote({ held: 1200 })).toContain('Ещё 1 200 отложено под задачи в работе.')
  })

  it('puts the pack after the gift in every sentence about the order', () => {
    const kept = 'Кредиты из пакета не сгорают.'
    expect(packNote({ left: 100, held: 0 }, { tariff: 300, gift: 35 }, true)).toBe(
      `${kept} Начнут тратиться, когда закончатся кредиты по тарифу и подарочные.`,
    )
    expect(packNote({ left: 100, held: 0 }, { tariff: 0, gift: 35 }, true)).toBe(
      `${kept} Начнут тратиться, когда закончатся подарочные кредиты.`,
    )
    expect(packNote({ left: 100, held: 0 }, { tariff: 300, gift: 0 }, true)).toBe(
      `${kept} Начнут тратиться, когда закончатся кредиты по тарифу.`,
    )
    expect(packNote({ left: 100, held: 0 }, { tariff: 0, gift: 0 }, true)).toBe(
      `${kept} Сейчас задачи тратят их: кредиты по тарифу закончились.`,
    )
    // An unpaid tariff spends no pack credit, whatever the gift holds.
    expect(packNote({ left: 100, held: 0 }, { tariff: 0, gift: 35 }, false)).toBe(
      `${kept} Станут доступны после оплаты тарифа.`,
    )
    // A customer without pack credits is told the order itself, with the gift in it.
    for (const gift of [0, 35]) {
      expect(packNote({ left: 0, held: 0 }, { tariff: 300, gift }, true)).toBe(
        'Кредиты из пакета не сгорают и тратятся последними — после кредитов по тарифу и подарочных.',
      )
    }
  })

  it('tells of an unpaid tariff on which tasks are still taken, on gift credits', () => {
    expect(unpaidWhileTasksTaken()).toBe(
      'Оплата тарифа не прошла. Пока она не пройдёт, новые задачи принимаются, только пока есть подарочные кредиты.',
    )
  })

  const gift = (available: number, patch: { held?: number; granted?: boolean } = {}) => ({
    available,
    held: 0,
    granted: true,
    ...patch,
  })
  /** The block «Тариф не выбран» for this gift, as the server answers about a new task. */
  const block = (credits: ReturnType<typeof gift>, facts: TaskFacts = {}, packLeft = 0) =>
    usageWithoutTariff(
      credits,
      taskCreditsFor(
        {
          tariff: { balance: 0, held: 0 },
          gift: { balance: credits.available + credits.held, held: credits.held },
          pack: { balance: packLeft, held: 0 },
        },
        null,
        facts,
      ),
      packLeft,
    )

  it('tells a customer without a tariff of the gift credits: they are the bound, there is no day', () => {
    const text =
      'У вас 35 подарочных кредитов. Они не сгорают, а задачи принимаются, пока подарочные кредиты не закончатся. Здесь видно, сколько кредитов осталось и на что они ушли.'
    expect(block(gift(35))).toBe(text)
    // The same to a user who has no workspace yet: the gift is granted with it.
    expect(block(gift(35, { granted: false }))).toBe(text)
    expect(block(gift(21))).toBe(
      'У вас 21 подарочный кредит. Он не сгорает, а задачи принимаются, пока подарочные кредиты не закончатся. Здесь видно, сколько кредитов осталось и на что они ушли.',
    )
    expect(block(gift(5))).toMatch(/^У вас 5 подарочных кредитов\. /)
  })

  it('says that a few gift credits start no task, and that a tariff keeps them', () => {
    expect(block(gift(3))).toBe(
      'Осталось 3 подарочных кредита, а на новую задачу нужно не меньше 5. Выберите тариф — подарочные кредиты сохранятся и прибавятся к кредитам тарифа.',
    )
    expect(block(gift(1))).toMatch(/^Остался 1 подарочный кредит, а на новую задачу/)
  })

  it('says that the gift is used up, and speaks of none where there was none', () => {
    expect(block(gift(0))).toBe(
      'Подарочные кредиты закончились. Чтобы ставить новые задачи, выберите тариф.',
    )
    expect(block(gift(0, { granted: false }))).toBe(
      'Кредиты входят в тариф. Выберите тариф, чтобы ставить задачи: здесь появится, сколько кредитов осталось и на что они ушли.',
    )
  })

  it('says that the gift is set aside for the task in work: it is not «used up»', () => {
    expect(block(gift(0, { held: 35 }))).toBe(
      'Подарочные кредиты заняты задачей в работе: под неё отложено 35. Когда она закончится, спишем только то, что ушло на работу, остальное вернётся — и можно будет поставить следующую.',
    )
  })

  it('tells of the trial that is over, by the answer of the server — never of a day', () => {
    expect(block(gift(20), { today: { charged: 500 } })).toMatch(/^У вас 20 подарочных кредитов\. /)
    expect(block(gift(15), { unpaidWork: 70 })).toBe(
      'Пробные задачи закончились: несколько задач остановились без результата, и без тарифа мы больше не можем их принимать. Выберите тариф, чтобы продолжить; оставшиеся 15 подарочных кредитов сохранятся.',
    )
  })

  it('tells that credits of a pack wait for a tariff once the tariff has ended', () => {
    expect(block(gift(0, { granted: false }), {}, 40)).toBe(
      'Тариф закончился. У вас 40 кредитов из пакета: они не сгорают и снова будут доступны, когда вы выберете тариф.',
    )
  })

  it('says what the customer has before the pause of the platform', () => {
    const pause =
      'Задачи сейчас не принимаются: мы обновляем расчёт кредитов. Попробуйте ещё раз немного позже.'
    expect(block(gift(35), { rateUsable: false })).toBe(`У вас 35 подарочных кредитов. ${pause}`)
    expect(block(gift(0), { rateUsable: false })).toBe(pause)
  })
})

describe('the sites of a tariff', () => {
  it.each([
    [1, 'из 1 сайта'],
    [3, 'из 3 сайтов'],
    [15, 'из 15 сайтов'],
    [21, 'из 21 сайта'],
  ])('puts the limit %i after the number of sites', (max, text) => {
    expect(ofSiteLimit(max)).toBe(text)
  })

  it.each([
    [0, 'Добавлено 0 сайтов из 3'],
    [1, 'Добавлен 1 сайт из 3'],
    [2, 'Добавлено 2 сайта из 3'],
    [5, 'Добавлено 5 сайтов из 3'],
  ])('names the meter of %i sites', (count, label) => {
    expect(sitesMeterLabel(count, 3)).toBe(label)
  })

  it('says how many more sites the tariff takes', () => {
    expect(sitesNote(2, 3)).toBe('Можно добавить ещё один сайт.')
    expect(sitesNote(0, 3)).toBe('Можно добавить ещё 3 сайта.')
    expect(sitesNote(3, 15)).toBe('Можно добавить ещё 12 сайтов.')
  })

  it('says that a full tariff takes no more', () => {
    expect(sitesNote(3, 3)).toBe('Больше сайтов на этом тарифе добавить нельзя.')
    expect(sitesNote(5, 3)).toBe('Сайтов больше, чем входит в тариф: новый добавить нельзя.')
  })
})

describe('a line of the history', () => {
  const from = (tariff: number, gift = 0, pack = 0) => ({ tariff, gift, pack })
  const nothing = { credits: null, from: null }

  it.each([
    // Done.
    [{ outcome: 'charged', credits: 5, from: from(5) }, '5 кредитов', null],
    [{ outcome: 'charged', credits: 1, from: from(1) }, '1 кредит', null],
    [{ outcome: 'charged', credits: 22, from: from(0, 22) }, '22 кредита', null],
    [{ outcome: 'charged', credits: 1200, from: from(0, 0, 1200) }, '1 200 кредитов', null],
    // Done, from two accounts and from three.
    [
      { outcome: 'charged', credits: 17, from: from(5, 0, 12) },
      '17 кредитов',
      '5 по тарифу и 12 из пакета',
    ],
    [
      { outcome: 'charged', credits: 43, from: from(5, 35, 3) },
      '43 кредита',
      '5 по тарифу, 35 подарочных и 3 из пакета',
    ],
    [
      { outcome: 'charged', credits: 13, from: from(0, 1, 12) },
      '13 кредитов',
      '1 подарочный и 12 из пакета',
    ],
    // In work.
    [
      { outcome: 'held', credits: 45, from: from(45) },
      'В работе',
      'Отложено до 45 кредитов — спишем по факту',
    ],
    [
      { outcome: 'held', credits: 21, from: from(0, 21) },
      'В работе',
      'Отложено до 21 кредита — спишем по факту',
    ],
    [
      { outcome: 'held', credits: 1, from: from(0, 0, 1) },
      'В работе',
      'Отложено до 1 кредита — спишем по факту',
    ],
    // Failed, cancelled, rolled back: nothing was charged.
    [{ outcome: 'unpaid', ...nothing }, 'Не списано', null],
    // An undo.
    [{ outcome: 'free', ...nothing }, 'Бесплатно', null],
  ] as const)('says what the task cost: %o', (entry, text, note) => {
    expect(outcomeText(entry)).toEqual({ text, note })
  })

  it.each([
    ['free', 'done', 'Отмена правки'],
    ['free', 'running', 'Отмена правки'],
    ['unpaid', 'failed', 'Не получилось'],
    ['unpaid', 'cancelled', 'Задача отменена'],
    ['unpaid', 'rolled_back', 'Вернули сайт как было'],
    // A reserve that expired under a task that still waits: nothing more to say.
    ['unpaid', 'awaiting_user', null],
    ['charged', 'done', null],
    ['held', 'running', null],
    ['held', 'awaiting_user', null],
  ] as const)('adds a line under the task where it helps: %s, %s', (outcome, status, note) => {
    expect(taskNote(outcome, status)).toBe(note)
  })
})
