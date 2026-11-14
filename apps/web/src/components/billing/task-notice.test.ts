import { describe, expect, it } from 'vitest'

import { creditsLeft } from './plan-format'
import {
  giftCarriesTasks,
  noticeText,
  PLAN_CHANGE_STARTS_LATER,
  plansWithoutTariff,
  RATE_PAUSE,
  dayLimitTomorrow,
  taskNotice,
  type NoticeTariff,
  type TaskNoticeInput,
} from './task-notice'
import { agency, subscriptionTo, start, taskCreditsFor, type TaskFacts } from './testing'

// What stands in the way of a new task, sentence by sentence. The answer about the task is the
// one the server gives for the accounts of each case (`taskCreditsFor`): a notice is never
// tested against an answer the queue could not give.

/** The text as it reads: amounts and dates come with non-breaking spaces. */
const plain = (text: string | null | undefined) =>
  (text ?? '').replaceAll(String.fromCharCode(0xa0), ' ')

const periodEnd = new Date('2026-10-18T09:00:00Z')
/** 15:00 in Moscow on 4 October: the next Moscow day starts at 21:00 UTC. */
const NOW = new Date('2026-10-04T12:00:00Z')
const PACK = { credits: 100, price: '1490.00', withoutTariff: false }

/** «Старт» as the seeds sell it: 200 credits a month and no daily limit, paid and renewing on 18 October. */
const startPlan = {
  id: start.id,
  slug: start.slug,
  name: start.name,
  price: start.price,
  creditsPerMonth: start.creditsPerMonth,
  creditsPerDay: start.creditsPerDay,
  creditsPer5h: null,
  creditsPerWeek: null,
  maxSites: start.maxSites,
}
type Terms = typeof startPlan
/**
 * A tariff with a daily limit: «Старт» of before, 300 credits a month and 50 a day. No tariff on
 * sale has a day since 06.11.2026 (Ц6); the code of the day stays for a plan that sets one.
 */
const dayPlan: Terms = { ...startPlan, creditsPerMonth: 300, creditsPerDay: 50 }
const tariffOf = (patch: Partial<NoticeTariff> = {}, terms: Terms = startPlan): NoticeTariff => ({
  status: 'active',
  name: terms.name,
  periodEnd,
  autoRenewal: true,
  nextPlan: {
    name: terms.name,
    creditsPerMonth: terms.creditsPerMonth,
    creditsPerDay: terms.creditsPerDay,
  },
  ...patch,
})

interface Case {
  tariff?: number
  tariffHeld?: number
  gift?: number
  giftHeld?: number
  pack?: number
  packHeld?: number
  /** The tariff of the customer; null — none. «Старт», paid, unless told. */
  plan?: Partial<NoticeTariff> | null
  /** The terms of that tariff: those of «Старт» on sale unless told. */
  terms?: Terms
  /** The pack on sale that the customer may buy; none unless told. */
  offer?: typeof PACK | null
  canResume?: boolean
  facts?: TaskFacts
}

function input(scenario: Case = {}): TaskNoticeInput {
  const { tariff = 0, tariffHeld = 0, gift = 0, giftHeld = 0, pack = 0, packHeld = 0 } = scenario
  const terms = scenario.terms ?? startPlan
  const plan = scenario.plan === null ? null : tariffOf(scenario.plan, terms)
  const subscription = plan === null ? null : subscriptionTo({ status: plan.status, plan: terms })
  return {
    task: taskCreditsFor(
      {
        tariff: { balance: tariff + tariffHeld, held: tariffHeld },
        gift: { balance: gift + giftHeld, held: giftHeld },
        pack: { balance: pack + packHeld, held: packHeld },
      },
      subscription,
      scenario.facts,
    ),
    giftLeft: gift,
    packLeft: pack,
    tariff: plan,
    pack: scenario.offer ?? null,
    canResume: scenario.canResume ?? true,
    now: NOW,
  }
}

/** The notice of a case: the reason of the server, the whole text and the ways out. */
function told(scenario: Case = {}, payable = true) {
  const given = input(scenario)
  const notice = taskNotice(given)
  return {
    reason: given.task.newTask.reason,
    text: notice === null ? null : plain(noticeText(notice, payable)),
    actions: notice?.actions ?? null,
  }
}

describe('a task that would be taken', () => {
  it.each([
    ['on a paid tariff', { tariff: 200 }],
    ['on the gift, without a tariff', { gift: 35, plan: null }],
    ['on the gift, while the tariff is overdue', { gift: 35, plan: { status: 'past_due' } }],
    ['on a pack, when the quota is used up', { pack: 100 }],
  ] as const)('has no notice: %s', (_case, scenario) => {
    expect(told(scenario)).toEqual({ reason: null, text: null, actions: null })
  })
})

describe('without a tariff', () => {
  const noTariff = (scenario: Case) => told({ plan: null, ...scenario })

  it('says that the gift is used up (A2)', () => {
    expect(noTariff({})).toEqual({
      reason: 'gift_spent',
      text: 'Подарочные кредиты закончились. Чтобы ставить новые задачи, выберите тариф.',
      actions: ['choose_plan'],
    })
  })

  // One credit starts a task since 10.11.2026 (КР5–КР8): a few gift credits are no refusal.
  it.each([1, 2, 4])('takes a task on %i gift credits', (gift) => {
    expect(noTariff({ gift })).toEqual({ reason: null, text: null, actions: null })
  })

  // Without a tariff there is no day: the gift is the bound (decision of 17.10.2026).
  it('never refuses by a day, however much the day took', () => {
    expect(noTariff({ gift: 20, facts: { today: { charged: 500, held: 500 } } })).toEqual({
      reason: null,
      text: null,
      actions: null,
    })
  })

  it('says that the gift is set aside for the task in work, and offers no pack (A10б)', () => {
    expect(noTariff({ giftHeld: 35, offer: PACK })).toEqual({
      reason: 'held',
      text: 'Подарочные кредиты заняты задачей в работе: под неё отложено 35. Когда она закончится, спишем только то, что ушло на работу, остальное вернётся — и можно будет поставить следующую.',
      actions: ['choose_plan'],
    })
  })

  // One credit is one credit (owner's decision of 10.11.2026): a pack carries tasks without a
  // tariff as the gift does.
  it.each([40, 5, 1200])('takes a task on %i credits of a pack', (pack) => {
    expect(noTariff({ pack })).toEqual({ reason: null, text: null, actions: null })
  })
})

describe('on a paid tariff that renews', () => {
  const grant = '18 октября начислим 200 кредитов по тарифу «Старт».'

  it('says that the limits ran out, when the next credits come and that a pack helps now (A7)', () => {
    expect(told({ offer: PACK })).toEqual({
      reason: 'empty',
      text: `Лимиты закончились: кредиты по тарифу и из пакета израсходованы. ${grant} Чтобы продолжить сейчас, купите пакет — 100 кредитов за 1 490 ₽. Кредиты из пакета не сгорают.`,
      actions: ['buy_pack', 'change_plan'],
    })
  })

  it('drops the sentences about the pack when none is on sale (A7)', () => {
    expect(told()).toEqual({
      reason: 'empty',
      text: `Лимиты закончились: кредиты по тарифу и из пакета израсходованы. ${grant}`,
      actions: ['change_plan'],
    })
  })

  // One credit starts a task since 10.11.2026 (КР5–КР8): a few credits are no refusal.
  it.each([1, 2, 4])('takes a task on %i credits of the tariff', (tariff) => {
    expect(told({ tariff, offer: PACK })).toEqual({ reason: null, text: null, actions: null })
  })

  it('counts every account in what can be spent: a gift credit is one of them', () => {
    expect(told({ gift: 1 }).reason).toBeNull()
    expect(told({ pack: 1 }).reason).toBeNull()
  })

  it('names the tariff of the next period when a change is scheduled', () => {
    const next = {
      nextPlan: { name: agency.name, creditsPerMonth: agency.creditsPerMonth, creditsPerDay: null },
    }
    expect(told({ plan: next }).text).toBe(
      'Лимиты закончились: кредиты по тарифу и из пакета израсходованы. 18 октября начислим 2 000 кредитов по тарифу «Агентство».',
    )
  })

  it('says that the credits are set aside for tasks in work, and how many (A10)', () => {
    const state =
      'Кредиты заняты задачами в работе: под них отложено 90. Когда задачи закончатся, спишем только то, что ушло на работу, остальное вернётся — и можно будет поставить новую.'
    expect(told({ tariffHeld: 45, packHeld: 45, offer: PACK })).toEqual({
      reason: 'held',
      text: `${state} Чтобы не ждать, купите пакет — 100 кредитов за 1 490 ₽.`,
      actions: ['buy_pack'],
    })
    expect(told({ tariffHeld: 45, packHeld: 45 })).toEqual({
      reason: 'held',
      text: state,
      actions: [],
    })
    expect(told({ tariffHeld: 1200 }).text).toContain('под них отложено 1 200.')
  })

  // The tariff credits of the day (§6.2 of the design of 17.10.2026): a pack lifts it today. No
  // tariff on sale has a day since 06.11.2026; these are the sentences of one that sets it.
  const onDay = (scenario: Case = {}, payable = true) =>
    told({ terms: dayPlan, ...scenario }, payable)
  const packToday =
    'Чтобы продолжить сегодня, купите пакет — 100 кредитов за 1 490 ₽. Кредиты из пакета не сгорают и дневным лимитом не ограничены.'
  const tomorrow = 'Завтра снова можно будет потратить до 50 кредитов.'

  it('says that the tariff credits of the day are spent, and that a pack lifts it (A11)', () => {
    expect(onDay({ tariff: 250, offer: PACK, facts: { today: { charged: 50 } } })).toEqual({
      reason: 'daily_limit',
      text: `Кредиты по тарифу на сегодня закончились: потрачено 50 из 50. ${tomorrow} ${packToday}`,
      actions: ['buy_pack'],
    })
    // Without a pack on sale the day is all there is to wait for.
    expect(onDay({ tariff: 250, facts: { today: { charged: 50 } } })).toEqual({
      reason: 'daily_limit',
      text: `Кредиты по тарифу на сегодня закончились: потрачено 50 из 50. ${tomorrow}`,
      actions: [],
    })
  })

  it('says that the day is set aside for tasks in work, and that what they do not use comes back', () => {
    expect(
      onDay({
        tariff: 255,
        tariffHeld: 45,
        offer: PACK,
        facts: { today: { charged: 5, held: 45 } },
      }),
    ).toEqual({
      reason: 'daily_limit',
      text: `Кредиты по тарифу на сегодня заняты: из 50 списано 5 и отложено под задачи в работе 45. Неиспользованные кредиты вернутся, когда задачи закончатся, а завтра снова можно будет потратить до 50 кредитов. ${packToday}`,
      actions: ['buy_pack'],
    })
    expect(onDay({ tariff: 250, tariffHeld: 50, facts: { today: { held: 50 } } }).text).toBe(
      'Кредиты по тарифу на сегодня заняты: из 50 отложено под задачи в работе 50. Неиспользованные кредиты вернутся, когда задачи закончатся, а завтра снова можно будет потратить до 50 кредитов.',
    )
  })

  // One credit of the day, or of a pack, starts a task since 10.11.2026 (КР5–КР8).
  it('takes a task while the day or a pack still gives a credit', () => {
    const left = { tariff: 255, tariffHeld: 45, facts: { today: { charged: 4, held: 45 } } }
    expect(onDay(left).reason).toBeNull()
    expect(
      onDay({ ...left, facts: { today: { charged: 5, held: 45 } }, pack: 1 }).reason,
    ).toBeNull()
  })

  it('names the limit of now when the day took more after a renewal onto a smaller plan', () => {
    expect(onDay({ tariff: 700, facts: { today: { charged: 120 } } }).text).toBe(
      `Кредиты по тарифу на сегодня закончились: дневной лимит — 50. ${tomorrow}`,
    )
    // What is set aside cannot give the day back once the charges took all of it.
    expect(
      onDay({ tariff: 700, tariffHeld: 10, facts: { today: { charged: 60, held: 10 } } }).text,
    ).toBe(`Кредиты по тарифу на сегодня закончились: дневной лимит — 50. ${tomorrow}`)
  })

  // The owner, 19.10.2026: the day does not bound «Попробовать ещё», so its reserve can hold more
  // than the limit; what it does not use still comes back to the day.
  it('says that the day is set aside when a retry holds more than the limit', () => {
    expect(
      onDay({ tariff: 180, tariffHeld: 120, offer: PACK, facts: { today: { held: 120 } } }),
    ).toEqual({
      reason: 'daily_limit',
      text: `Кредиты по тарифу на сегодня заняты: при дневном лимите 50 отложено под задачи в работе 120. Неиспользованные кредиты вернутся, когда задачи закончатся, а завтра снова можно будет потратить до 50 кредитов. ${packToday}`,
      actions: ['buy_pack'],
    })
    expect(
      onDay({ tariff: 170, tariffHeld: 120, facts: { today: { charged: 10, held: 120 } } }).text,
    ).toBe(
      'Кредиты по тарифу на сегодня заняты: при дневном лимите 50 списано 10 и отложено под задачи в работе 120. Неиспользованные кредиты вернутся, когда задачи закончатся, а завтра снова можно будет потратить до 50 кредитов.',
    )
  })

  // C7: «завтра» only while the tariff still takes tasks when the next Moscow day starts.
  it('promises no tomorrow to a tariff that ends tonight', () => {
    const tonight = { autoRenewal: false, periodEnd: new Date('2026-10-04T21:00:00Z') }
    expect(
      onDay({ tariff: 250, offer: PACK, plan: tonight, facts: { today: { charged: 50 } } }),
    ).toEqual({
      reason: 'daily_limit',
      text: `Кредиты по тарифу на сегодня закончились: потрачено 50 из 50. ${packToday}`,
      actions: ['buy_pack'],
    })
    expect(
      onDay({
        tariff: 255,
        tariffHeld: 45,
        plan: tonight,
        facts: { today: { charged: 5, held: 45 } },
      }).text,
    ).toBe(
      'Кредиты по тарифу на сегодня заняты: из 50 списано 5 и отложено под задачи в работе 45. Неиспользованные кредиты вернутся, когда задачи закончатся.',
    )
    // Ending tomorrow morning, it still takes tasks when the day starts.
    const tomorrowMorning = { autoRenewal: false, periodEnd: new Date('2026-10-05T09:00:00Z') }
    expect(
      onDay({ tariff: 250, plan: tomorrowMorning, facts: { today: { charged: 50 } } }).text,
    ).toContain(tomorrow)
  })

  // Review of M5.33d: a tariff that renews before the next Moscow day starts gives the day of
  // the plan of the next period.
  it('promises the day of the scheduled plan when the period renews tonight', () => {
    const tonight = new Date('2026-10-04T19:00:00Z')
    // A scheduled tariff with a day of its own, of 300 credits.
    const toAgency = {
      nextPlan: { name: agency.name, creditsPerMonth: agency.creditsPerMonth, creditsPerDay: 300 },
    }
    expect(
      onDay({
        tariff: 250,
        plan: { ...toAgency, periodEnd: tonight },
        facts: { today: { charged: 50 } },
      }).text,
    ).toBe(
      'Кредиты по тарифу на сегодня закончились: потрачено 50 из 50. Завтра снова можно будет потратить до 300 кредитов.',
    )
    // While the period runs past midnight, tomorrow is the day of the plan of now.
    expect(
      onDay({ tariff: 250, plan: toAgency, facts: { today: { charged: 50 } } }).text,
    ).toContain(tomorrow)
  })

  it('tells the daily limit the tariff gives when the next Moscow day starts', () => {
    const midnight = new Date('2026-10-04T21:00:00Z')
    const tariff = tariffOf({ periodEnd: midnight, autoRenewal: false }, dayPlan)
    const later = { ...tariff, periodEnd: new Date(midnight.getTime() + 1) }
    const toAgency = {
      name: agency.name,
      creditsPerMonth: agency.creditsPerMonth,
      creditsPerDay: 300,
      creditsPer5h: null,
      creditsPerWeek: null,
    }
    // Ending at that midnight without a renewal: nothing.
    expect(dayLimitTomorrow(tariff, 50, false, NOW)).toBeNull()
    // Renewing by then: the day of the plan of the next period, the current or the scheduled.
    expect(dayLimitTomorrow({ ...tariff, autoRenewal: true }, 50, false, NOW)).toBe(50)
    expect(
      dayLimitTomorrow({ ...tariff, autoRenewal: true, nextPlan: toAgency }, 50, true, NOW),
    ).toBe(300)
    expect(
      dayLimitTomorrow(
        { ...tariff, autoRenewal: true, nextPlan: { ...toAgency, creditsPerDay: null } },
        50,
        false,
        NOW,
      ),
    ).toBeNull()
    // Running past it: the day of now — while the month still has a free tariff credit.
    expect(dayLimitTomorrow({ ...later, nextPlan: toAgency }, 50, false, NOW)).toBe(50)
    expect(dayLimitTomorrow({ ...later, autoRenewal: true }, 50, true, NOW)).toBeNull()
    expect(
      dayLimitTomorrow({ ...later, status: 'past_due', autoRenewal: true }, 50, false, NOW),
    ).toBeNull()
  })
})

describe('on a paid tariff that does not renew (A9)', () => {
  const ending = { plan: { autoRenewal: false } }
  const state = 'Лимиты закончились, а тариф «Старт» действует до 18 октября и не продлится.'

  it('offers the pack and auto-renewal', () => {
    expect(told({ ...ending, offer: PACK })).toEqual({
      reason: 'empty',
      text: `${state} Купите пакет — 100 кредитов за 1 490 ₽, они не сгорают, — или включите автопродление: тогда 18 октября начислим 200 кредитов.`,
      actions: ['buy_pack', 'resume_renewal'],
    })
    // A few credits left start a task: no notice then.
    expect(told({ ...ending, tariff: 3, offer: PACK }).reason).toBeNull()
  })

  it('offers only what there is: the pack, auto-renewal, or neither', () => {
    expect(told({ ...ending, offer: PACK, canResume: false })).toEqual({
      reason: 'empty',
      text: `${state} Купите пакет — 100 кредитов за 1 490 ₽, они не сгорают.`,
      actions: ['buy_pack'],
    })
    expect(told(ending)).toEqual({
      reason: 'empty',
      text: `${state} Включите автопродление: тогда 18 октября начислим 200 кредитов.`,
      actions: ['resume_renewal'],
    })
    expect(told({ ...ending, canResume: false })).toEqual({
      reason: 'empty',
      text: state,
      actions: [],
    })
  })
})

describe('on a tariff that is not paid', () => {
  const overdue = (scenario: Case = {}) =>
    told({ ...scenario, plan: { status: 'past_due', ...scenario.plan } })

  it('says that the tariff is not paid and that the payment brings the credits (A12)', () => {
    expect(overdue({ tariff: 120 })).toEqual({
      reason: 'past_due',
      text: 'Тариф «Старт» не оплачен, поэтому новые задачи не принимаются. Оплатите тариф — кредиты нового периода начислим сразу.',
      actions: ['pay'],
    })
  })

  it('sends the customer to pay, not to choose a tariff, when the gift stands in the way', () => {
    expect(overdue({})).toMatchObject({ reason: 'past_due', actions: ['pay'] })
    expect(overdue({ gift: 4 }).reason).toBeNull()
    expect(overdue({ giftHeld: 35 })).toMatchObject({
      reason: 'held',
      text: expect.stringMatching(
        /^Подарочные кредиты заняты задачей в работе: под неё отложено 35\./,
      ),
      actions: ['pay'],
    })
  })
})

describe('whether the gift still carries the tasks of a tariff that is not paid', () => {
  const carries = (scenario: Case = {}) => {
    const { task } = input({ ...scenario, plan: { status: 'past_due', ...scenario.plan } })
    return [task.newTask.reason, giftCarriesTasks(task)]
  }

  it('does while a task would be taken, and while what refuses one is of the moment', () => {
    expect(carries({ gift: 35 })).toEqual([null, true])
    // No day is counted while the tariff is not paid: the gift carries the tasks.
    expect(carries({ gift: 20, facts: { today: { charged: 500 } } })).toEqual([null, true])
    // The gift waits for the task in work: what it does not use comes back.
    expect(carries({ giftHeld: 35 })).toEqual(['held', true])
    expect(carries({ giftHeld: 33 })).toEqual(['held', true])
    // A few gift or pack credits carry a task: one credit starts it.
    expect(carries({ gift: 2, giftHeld: 33 })).toEqual([null, true])
    expect(carries({ pack: 4 })).toEqual([null, true])
  })

  it('does not once only the payment brings tasks back', () => {
    expect(carries({ tariff: 120 })).toEqual(['past_due', false])
    expect(carries({})).toEqual(['past_due', false])
    // The pause is the platform's: no task is taken, with the payment or without it.
    expect(carries({ gift: 35, facts: { rateUsable: false } })).toEqual(['rate_missing', false])
  })
})

describe('the pause of the platform', () => {
  it('says that no task is taken while the calculation is being updated, whatever the credits are', () => {
    for (const scenario of [
      { tariff: 200 },
      { plan: null, gift: 50 },
      { plan: null },
      { plan: { status: 'past_due' } },
    ] as const) {
      expect(told({ ...scenario, offer: PACK, facts: { rateUsable: false } })).toEqual({
        reason: 'rate_missing',
        text: 'Задачи сейчас не принимаются: мы обновляем расчёт кредитов. Попробуйте ещё раз немного позже.',
        actions: [],
      })
    }
    expect(RATE_PAUSE).toBe(
      'Задачи сейчас не принимаются: мы обновляем расчёт кредитов. Попробуйте ещё раз немного позже.',
    )
  })
})

describe('where nothing can be paid for', () => {
  it('leaves out the sentence that takes a payment, and keeps what ran out and when credits come', () => {
    expect(told({ offer: PACK }, false).text).toBe(
      'Лимиты закончились: кредиты по тарифу и из пакета израсходованы. 18 октября начислим 200 кредитов по тарифу «Старт».',
    )
    expect(told({ plan: { status: 'past_due' } }, false).text).toBe(
      'Тариф «Старт» не оплачен, поэтому новые задачи не принимаются.',
    )
    expect(told({ plan: null }, false).text).toBe('Подарочные кредиты закончились.')
    // A notice that names no payment reads the same.
    const day = { terms: dayPlan, tariff: 250, facts: { today: { charged: 50 } } }
    expect(told(day, false).text).toBe(told(day).text)
    // A pack lifts the day: where it cannot be bought, only the day is told.
    expect(told({ ...day, offer: PACK }, false).text).toBe(
      `Кредиты по тарифу на сегодня закончились: потрачено 50 из 50. Завтра снова можно будет потратить до 50 кредитов.`,
    )
  })
})

describe('every notice', () => {
  const cases: Case[] = [
    { plan: null },
    { plan: null, giftHeld: 35 },
    { offer: PACK },
    { plan: { autoRenewal: false }, offer: PACK },
    { tariffHeld: 90, offer: PACK },
    { terms: dayPlan, tariff: 250, offer: PACK, facts: { today: { charged: 50 } } },
    { terms: dayPlan, tariff: 255, tariffHeld: 45, facts: { today: { charged: 5, held: 45 } } },
    { plan: { status: 'past_due' } },
    { tariff: 200, facts: { rateUsable: false } },
  ]

  it('says «вы», names no receipt and no VAT, and ends every sentence', () => {
    const reasons = new Set<string | null>()
    for (const scenario of cases) {
      const { reason, text } = told(scenario)
      reasons.add(reason)
      expect(text).not.toBeNull()
      expect(text).not.toMatch(/[A-Za-z]|НДС|чек|зарезервирован/i)
      expect(text).not.toMatch(/(?:^|[^а-яё])(?:ты|тебя|тебе|твой|твоя|твоё|твои)(?:[^а-яё]|$)/i)
      expect(text).toMatch(/[.!?]$/)
      // «Оплата за действие» is not sold and not named; the unit of the model's work is named
      // in one block only.
      expect(text).not.toMatch(/оплат[аы] за действие|токен/i)
    }
    // Every reason a page of the account can be given has its case here: with one credit to
    // start a task, «below_start» and «gift_below_start» are not given any more (КР5–КР8).
    expect([...reasons].sort()).toEqual(
      ['daily_limit', 'empty', 'gift_spent', 'held', 'past_due', 'rate_missing'].sort(),
    )
  })

  it('says «лимиты закончились» wherever the credits of a paid tariff ran out', () => {
    for (const scenario of [{}, { plan: { autoRenewal: false } }] as Case[]) {
      expect(told(scenario).text).toMatch(/^Лимиты закончились/)
    }
  })

  it('says beside «Сменить тариф» that only a pack helps today', () => {
    expect(PLAN_CHANGE_STARTS_LATER).toBe('Новый тариф начнёт действовать со следующего периода.')
  })
})

describe('the row of the credits', () => {
  const task = (scenario: Case) => input(scenario).task

  it('says «Закончились» when no credit can be spent and none is set aside', () => {
    expect(creditsLeft({ tariff: 0, gift: 0, pack: 0 }, task({}))).toBe('Закончились')
    // One credit starts a task since 10.11.2026: three are left, not gone.
    expect(creditsLeft({ tariff: 3, gift: 0, pack: 0 }, task({ tariff: 3 }))).toBe(
      'Осталось 3 по тарифу',
    )
  })

  it('names what is left while a task can start on it, or while credits are set aside', () => {
    expect(creditsLeft({ tariff: 5, gift: 0, pack: 0 }, task({ tariff: 5 }))).toBe(
      'Осталось 5 по тарифу',
    )
    // Two are free and 45 wait for a task in work: they are not gone.
    expect(creditsLeft({ tariff: 2, gift: 0, pack: 0 }, task({ tariff: 2, tariffHeld: 45 }))).toBe(
      'Осталось 2 по тарифу',
    )
    expect(
      creditsLeft({ tariff: 45, gift: 4, pack: 10 }, task({ tariff: 45, gift: 4, pack: 10 })),
    ).toBe('Осталось 59: 45 по тарифу, 4 подарочных и 10 из пакета')
  })

  it('says that the credits are set aside, not gone, when none is free and tasks in work hold some', () => {
    // The state behind «Кредиты заняты задачами в работе…»: nothing free, 45 wait for a task.
    const allHeld = task({ tariffHeld: 45 })
    expect(allHeld).toMatchObject({ spendable: 0, setAside: 45, newTask: { reason: 'held' } })
    expect(creditsLeft({ tariff: 0, gift: 0, pack: 0 }, allHeld)).toBe(
      'Отложено под задачи в работе: 45',
    )
    // Every account that tasks hold credits on is in the number, with its digits grouped.
    expect(
      creditsLeft(
        { tariff: 0, gift: 0, pack: 0 },
        task({ tariffHeld: 1100, giftHeld: 35, packHeld: 65 }),
      ),
    ).toBe('Отложено под задачи в работе: 1 200')
    // A few set aside are worth waiting for: one credit starts a task.
    const fewHeld = task({ tariffHeld: 3 })
    expect(fewHeld).toMatchObject({ spendable: 0, setAside: 3, newTask: { reason: 'held' } })
    expect(creditsLeft({ tariff: 0, gift: 0, pack: 0 }, fewHeld)).toBe(
      'Отложено под задачи в работе: 3',
    )
  })
})

describe('the line under «Тарифы» of a customer without a tariff', () => {
  const lead = (scenario: Case, patch: { hadTariff?: boolean; canChoose?: boolean } = {}) => {
    const given = input({ plan: null, ...scenario })
    const { gift = 0, giftHeld = 0 } = scenario
    return plain(
      plansWithoutTariff({
        gift: { available: gift, held: giftHeld, granted: true },
        task: given.task,
        packLeft: given.packLeft,
        hadTariff: false,
        canChoose: true,
        ...patch,
      }),
    )
  }

  it('never tells of a day, however much the day took', () => {
    expect(lead({ gift: 20, facts: { today: { charged: 500 } } })).not.toMatch(/в день|сегодня/i)
  })

  it('tells what a pack alone gives: tasks until the credits run out', () => {
    expect(lead({ pack: 40 })).toBe(
      'У вас 40 кредитов из пакета. Когда кредиты закончатся, понадобится тариф.',
    )
    expect(lead({ pack: 40 }, { canChoose: false })).toBe(
      'У вас 40 кредитов из пакета. Когда кредиты закончатся, понадобится тариф. Оплата пока недоступна.',
    )
  })

  it('says «payments are off» in place of the way to a tariff, where a tariff is the way', () => {
    const off = { canChoose: false }
    expect(lead({ gift: 3 }, off)).toMatch(/Оплата пока недоступна\.$/)
  })

  it('says what the customer has before the pause of the platform', () => {
    expect(lead({ gift: 35, facts: { rateUsable: false } })).toBe(
      `У вас 35 подарочных кредитов. ${RATE_PAUSE}`,
    )
    expect(lead({ facts: { rateUsable: false } })).toBe(RATE_PAUSE)
    // The pause is no matter of payments: nothing is added while they are off.
    expect(lead({ facts: { rateUsable: false } }, { canChoose: false })).toBe(RATE_PAUSE)
  })
})

// Plan 71: a spent window of 5 hours or of the week — credits do not lift it, the reset does.
describe('a spent window of the workspace', () => {
  const resetsAt = new Date('2026-11-16T15:40:00.000Z')

  it('names the window and its reset by the Moscow clock, and the bigger tariffs', () => {
    expect(
      told({
        tariff: 200,
        facts: {
          windows: [
            { kind: '5h', limit: 20, used: '20.3', resetsAt },
            { kind: 'week', limit: 55, used: '30', resetsAt: null },
          ],
        },
      }),
    ).toEqual({
      reason: 'window_limit',
      text: 'Лимит на 5 часов исчерпан: новые задачи — после 18:40. Кредиты от этого не сгорают. На старших тарифах лимиты больше — тариф можно сменить в разделе «Тарифы».',
      actions: ['change_plan'],
    })
  })

  it('names the week when it is the one spent', () => {
    expect(
      told({
        tariff: 200,
        facts: {
          windows: [
            { kind: '5h', limit: 20, used: '2', resetsAt },
            { kind: 'week', limit: 55, used: '55', resetsAt: new Date('2026-11-23T07:15:00.000Z') },
          ],
        },
      }).text,
    ).toMatch(/^Недельный лимит исчерпан: новые задачи — в пн после 10:15\./)
  })
})
