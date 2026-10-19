import { describe, expect, it } from 'vitest'

import type { TaskRefusalReason } from './billing-types'
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
import { subscriptionTo, start, taskCreditsFor, type TaskFacts } from './testing'

// What stands in the way of a new task, sentence by sentence. The answer about the task is the
// one the server gives for the accounts of each case (`taskCreditsFor`): a notice is never
// tested against an answer the queue could not give.

/** The text as it reads: amounts and dates come with non-breaking spaces. */
const plain = (text: string | null | undefined) =>
  (text ?? '').replaceAll(String.fromCharCode(0xa0), ' ')

const periodEnd = new Date('2026-10-18T09:00:00Z')
/** 15:00 in Moscow on 4 October: the next Moscow day starts at 21:00 UTC. */
const NOW = new Date('2026-10-04T12:00:00Z')
const PACK = { credits: 100, price: '1990.00' }

/** «Старт», 300 credits a month and 50 a day, paid and renewing on 18 October. */
const startPlan = {
  id: start.id,
  slug: start.slug,
  name: start.name,
  price: start.price,
  creditsPerMonth: start.creditsPerMonth,
  creditsPerDay: start.creditsPerDay,
  maxSites: start.maxSites,
}
const tariffOf = (patch: Partial<NoticeTariff> = {}): NoticeTariff => ({
  status: 'active',
  name: 'Старт',
  periodEnd,
  autoRenewal: true,
  nextPlan: { name: 'Старт', creditsPerMonth: 300, creditsPerDay: 50 },
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
  /** The pack on sale that the customer may buy; none unless told. */
  offer?: typeof PACK | null
  canResume?: boolean
  facts?: TaskFacts
}

function input(scenario: Case = {}): TaskNoticeInput {
  const { tariff = 0, tariffHeld = 0, gift = 0, giftHeld = 0, pack = 0, packHeld = 0 } = scenario
  const plan = scenario.plan === null ? null : tariffOf(scenario.plan)
  const subscription =
    plan === null ? null : subscriptionTo({ status: plan.status, plan: startPlan })
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
    ['on a paid tariff', { tariff: 300 }],
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

  it.each([
    [1, 'Остался 1 подарочный кредит'],
    [2, 'Осталось 2 подарочных кредита'],
    [3, 'Осталось 3 подарочных кредита'],
    [4, 'Осталось 4 подарочных кредита'],
  ])('says that %i gift credits start no task, and that a tariff keeps them (A3)', (gift, left) => {
    expect(noTariff({ gift })).toEqual({
      reason: 'gift_below_start',
      text: `${left}, а на новую задачу нужно не меньше 5. Выберите тариф — подарочные кредиты сохранятся и прибавятся к кредитам тарифа.`,
      actions: ['choose_plan'],
    })
  })

  it.each([
    [15, 'оставшиеся 15 подарочных кредитов сохранятся'],
    [35, 'оставшиеся 35 подарочных кредитов сохранятся'],
    [21, 'оставшийся 21 подарочный кредит сохранится'],
    [22, 'оставшиеся 22 подарочных кредита сохранятся'],
  ])(
    'says that the trial is over, and what a tariff keeps of %i gift credits (A4)',
    (gift, kept) => {
      expect(noTariff({ gift, facts: { unpaidWork: 70 } })).toEqual({
        reason: 'trial_unpaid_limit',
        text: `Пробные задачи закончились: несколько задач остановились без результата, и без тарифа мы больше не можем их принимать. Выберите тариф, чтобы продолжить; ${kept}.`,
        actions: ['choose_plan'],
      })
    },
  )

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

  it.each([
    [40, 'У вас 40 кредитов из пакета: они не сгорают и снова будут доступны'],
    [1, 'У вас 1 кредит из пакета: он не сгорает и снова будет доступен'],
    [22, 'У вас 22 кредита из пакета: они не сгорают и снова будут доступны'],
    [1200, 'У вас 1 200 кредитов из пакета: они не сгорают и снова будут доступны'],
  ])('says that %i credits of a pack wait for a tariff (A13)', (pack, kept) => {
    expect(noTariff({ pack })).toEqual({
      reason: 'ended',
      text: `Тариф закончился. ${kept}, когда вы выберете тариф.`,
      actions: ['choose_plan'],
    })
  })
})

describe('on a paid tariff that renews', () => {
  const grant = '18 октября начислим 300 кредитов по тарифу «Старт».'

  it('says that the limits ran out, when the next credits come and that a pack helps now (A7)', () => {
    expect(told({ offer: PACK })).toEqual({
      reason: 'empty',
      text: `Лимиты закончились: кредиты по тарифу и из пакета израсходованы. ${grant} Чтобы продолжить сейчас, купите пакет — 100 кредитов за 1 990 ₽. Кредиты из пакета не сгорают.`,
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

  it.each([
    [1, 'остался 1 кредит'],
    [2, 'осталось 2 кредита'],
    [3, 'осталось 3 кредита'],
    [4, 'осталось 4 кредита'],
  ])('says that %i credits start no task (A8)', (tariff, left) => {
    expect(told({ tariff, offer: PACK })).toEqual({
      reason: 'below_start',
      text: `Лимиты закончились: ${left}, а на новую задачу нужно не меньше 5. ${grant} Чтобы продолжить сейчас, купите пакет — 100 кредитов за 1 990 ₽.`,
      actions: ['buy_pack', 'change_plan'],
    })
    expect(told({ tariff }).text).toBe(
      `Лимиты закончились: ${left}, а на новую задачу нужно не меньше 5. ${grant}`,
    )
  })

  it('counts every account in what is left: a gift credit is one of them', () => {
    expect(told({ tariff: 1, gift: 2 }).text).toMatch(/^Лимиты закончились: осталось 3 кредита, /)
  })

  it('names the tariff of the next period when a change is scheduled', () => {
    const next = { nextPlan: { name: 'Агентство', creditsPerMonth: 2500, creditsPerDay: 300 } }
    expect(told({ plan: next }).text).toBe(
      'Лимиты закончились: кредиты по тарифу и из пакета израсходованы. 18 октября начислим 2 500 кредитов по тарифу «Агентство».',
    )
  })

  it('says that the credits are set aside for tasks in work, and how many (A10)', () => {
    const state =
      'Кредиты заняты задачами в работе: под них отложено 90. Когда задачи закончатся, спишем только то, что ушло на работу, остальное вернётся — и можно будет поставить новую.'
    expect(told({ tariffHeld: 45, packHeld: 45, offer: PACK })).toEqual({
      reason: 'held',
      text: `${state} Чтобы не ждать, купите пакет — 100 кредитов за 1 990 ₽.`,
      actions: ['buy_pack'],
    })
    expect(told({ tariffHeld: 45, packHeld: 45 })).toEqual({
      reason: 'held',
      text: state,
      actions: [],
    })
    expect(told({ tariff: 2, tariffHeld: 1200 }).text).toContain('под них отложено 1 200.')
  })

  // The tariff credits of the day (§6.2 of the design of 17.10.2026): a pack lifts it today.
  const packToday =
    'Чтобы продолжить сегодня, купите пакет — 100 кредитов за 1 990 ₽. Кредиты из пакета не сгорают и дневным лимитом не ограничены.'
  const tomorrow = 'Завтра снова можно будет потратить до 50 кредитов.'

  it('says that the tariff credits of the day are spent, and that a pack lifts it (A11)', () => {
    expect(told({ tariff: 250, offer: PACK, facts: { today: { charged: 50 } } })).toEqual({
      reason: 'daily_limit',
      text: `Кредиты по тарифу на сегодня закончились: потрачено 50 из 50. ${tomorrow} ${packToday}`,
      actions: ['buy_pack'],
    })
    // Without a pack on sale the day is all there is to wait for.
    expect(told({ tariff: 250, facts: { today: { charged: 50 } } })).toEqual({
      reason: 'daily_limit',
      text: `Кредиты по тарифу на сегодня закончились: потрачено 50 из 50. ${tomorrow}`,
      actions: [],
    })
  })

  it('says that the day is set aside for tasks in work, and that what they do not use comes back', () => {
    expect(
      told({
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
    expect(told({ tariff: 250, tariffHeld: 50, facts: { today: { held: 50 } } }).text).toBe(
      'Кредиты по тарифу на сегодня заняты: из 50 отложено под задачи в работе 50. Неиспользованные кредиты вернутся, когда задачи закончатся, а завтра снова можно будет потратить до 50 кредитов.',
    )
  })

  // Review of M5.33a: the day need not be spent — three of it and one of a pack are four.
  it('says how much the day still gives when it is too little to start a task', () => {
    expect(
      told({
        tariff: 255,
        tariffHeld: 45,
        pack: 1,
        offer: PACK,
        facts: { today: { charged: 2, held: 45 } },
      }),
    ).toEqual({
      reason: 'daily_limit',
      text: `Сегодня можно потратить ещё 4 кредита, а на новую задачу нужно не меньше 5. ${tomorrow} ${packToday}`,
      actions: ['buy_pack'],
    })
    expect(
      told({ tariff: 255, tariffHeld: 45, facts: { today: { charged: 4, held: 45 } } }).text,
    ).toBe(`Сегодня можно потратить ещё 1 кредит, а на новую задачу нужно не меньше 5. ${tomorrow}`)
  })

  it('names the limit of now when the day took more after a renewal onto a smaller plan', () => {
    expect(told({ tariff: 700, facts: { today: { charged: 120 } } }).text).toBe(
      `Кредиты по тарифу на сегодня закончились: дневной лимит — 50. ${tomorrow}`,
    )
    // What is set aside cannot give the day back once the charges took all of it.
    expect(
      told({ tariff: 700, tariffHeld: 10, facts: { today: { charged: 60, held: 10 } } }).text,
    ).toBe(`Кредиты по тарифу на сегодня закончились: дневной лимит — 50. ${tomorrow}`)
  })

  // The owner, 19.10.2026: the day does not bound «Попробовать ещё», so its reserve can hold more
  // than the limit; what it does not use still comes back to the day.
  it('says that the day is set aside when a retry holds more than the limit', () => {
    expect(
      told({ tariff: 180, tariffHeld: 120, offer: PACK, facts: { today: { held: 120 } } }),
    ).toEqual({
      reason: 'daily_limit',
      text: `Кредиты по тарифу на сегодня заняты: при дневном лимите 50 отложено под задачи в работе 120. Неиспользованные кредиты вернутся, когда задачи закончатся, а завтра снова можно будет потратить до 50 кредитов. ${packToday}`,
      actions: ['buy_pack'],
    })
    expect(
      told({ tariff: 170, tariffHeld: 120, facts: { today: { charged: 10, held: 120 } } }).text,
    ).toBe(
      'Кредиты по тарифу на сегодня заняты: при дневном лимите 50 списано 10 и отложено под задачи в работе 120. Неиспользованные кредиты вернутся, когда задачи закончатся, а завтра снова можно будет потратить до 50 кредитов.',
    )
  })

  // C7: «завтра» only while the tariff still takes tasks when the next Moscow day starts.
  it('promises no tomorrow to a tariff that ends tonight', () => {
    const tonight = { autoRenewal: false, periodEnd: new Date('2026-10-04T21:00:00Z') }
    expect(
      told({ tariff: 250, offer: PACK, plan: tonight, facts: { today: { charged: 50 } } }),
    ).toEqual({
      reason: 'daily_limit',
      text: `Кредиты по тарифу на сегодня закончились: потрачено 50 из 50. ${packToday}`,
      actions: ['buy_pack'],
    })
    expect(
      told({
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
      told({ tariff: 250, plan: tomorrowMorning, facts: { today: { charged: 50 } } }).text,
    ).toContain(tomorrow)
  })

  // Review of M5.33d: a tariff that renews before the next Moscow day starts gives the day of
  // the plan of the next period.
  it('promises the day of the scheduled plan when the period renews tonight', () => {
    const tonight = new Date('2026-10-04T19:00:00Z')
    const toAgency = { nextPlan: { name: 'Агентство', creditsPerMonth: 2500, creditsPerDay: 300 } }
    expect(
      told({
        tariff: 250,
        plan: { ...toAgency, periodEnd: tonight },
        facts: { today: { charged: 50 } },
      }).text,
    ).toBe(
      'Кредиты по тарифу на сегодня закончились: потрачено 50 из 50. Завтра снова можно будет потратить до 300 кредитов.',
    )
    // While the period runs past midnight, tomorrow is the day of the plan of now.
    expect(told({ tariff: 250, plan: toAgency, facts: { today: { charged: 50 } } }).text).toContain(
      tomorrow,
    )
  })

  it('tells the daily limit the tariff gives when the next Moscow day starts', () => {
    const midnight = new Date('2026-10-04T21:00:00Z')
    const tariff = tariffOf({ periodEnd: midnight, autoRenewal: false })
    const later = { ...tariff, periodEnd: new Date(midnight.getTime() + 1) }
    const toAgency = { name: 'Агентство', creditsPerMonth: 2500, creditsPerDay: 300 }
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

  it('says that too much work ended without a charge, and asks to write (A14)', () => {
    expect(told({ tariff: 300, offer: PACK, facts: { unpaidWork: 300 } })).toEqual({
      reason: 'unpaid_limit',
      text: 'В этом периоде слишком много задач остановилось без результата, поэтому новые задачи временно не принимаются. Кредиты за них не списаны. Напишите нам — разберёмся, в чём дело.',
      actions: [],
    })
  })
})

describe('on a paid tariff that does not renew (A9)', () => {
  const ending = { plan: { autoRenewal: false } }
  const state = 'Лимиты закончились, а тариф «Старт» действует до 18 октября и не продлится.'

  it('offers the pack and auto-renewal', () => {
    expect(told({ ...ending, offer: PACK })).toEqual({
      reason: 'empty',
      text: `${state} Купите пакет — 100 кредитов за 1 990 ₽, они не сгорают, — или включите автопродление: тогда 18 октября начислим 300 кредитов.`,
      actions: ['buy_pack', 'resume_renewal'],
    })
    // The same with a few credits left: fewer than a task needs.
    expect(told({ ...ending, tariff: 3, offer: PACK }).text).toBe(
      `${state} Купите пакет — 100 кредитов за 1 990 ₽, они не сгорают, — или включите автопродление: тогда 18 октября начислим 300 кредитов.`,
    )
  })

  it('offers only what there is: the pack, auto-renewal, or neither', () => {
    expect(told({ ...ending, offer: PACK, canResume: false })).toEqual({
      reason: 'empty',
      text: `${state} Купите пакет — 100 кредитов за 1 990 ₽, они не сгорают.`,
      actions: ['buy_pack'],
    })
    expect(told(ending)).toEqual({
      reason: 'empty',
      text: `${state} Включите автопродление: тогда 18 октября начислим 300 кредитов.`,
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
    expect(overdue({ tariff: 250, pack: 100 })).toEqual({
      reason: 'past_due',
      text: 'Тариф «Старт» не оплачен, поэтому новые задачи не принимаются. Оплатите тариф — кредиты нового периода начислим сразу.',
      actions: ['pay'],
    })
  })

  it('sends the customer to pay, not to choose a tariff, when the gift stands in the way', () => {
    expect(overdue({ gift: 15, facts: { unpaidWork: 70 } })).toEqual({
      reason: 'trial_unpaid_limit',
      text: 'Пробные задачи закончились: несколько задач остановились без результата, и без тарифа мы больше не можем их принимать. Оплатите тариф, чтобы продолжить; оставшиеся 15 подарочных кредитов сохранятся.',
      actions: ['pay'],
    })
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
    expect(carries({ gift: 2, giftHeld: 33 })).toEqual(['held', true])
  })

  it('does not once only the payment brings tasks back', () => {
    expect(carries({ tariff: 250, pack: 100 })).toEqual(['past_due', false])
    expect(carries({ gift: 4 })).toEqual(['past_due', false])
    expect(carries({ gift: 15, facts: { unpaidWork: 70 } })).toEqual(['trial_unpaid_limit', false])
    // The pause is the platform's: no task is taken, with the payment or without it.
    expect(carries({ gift: 35, facts: { rateUsable: false } })).toEqual(['rate_missing', false])
  })
})

describe('the pause of the platform', () => {
  it('says that no task is taken while the calculation is being updated, whatever the credits are', () => {
    for (const scenario of [
      { tariff: 300 },
      { plan: null, gift: 35 },
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
      'Лимиты закончились: кредиты по тарифу и из пакета израсходованы. 18 октября начислим 300 кредитов по тарифу «Старт».',
    )
    expect(told({ plan: { status: 'past_due' } }, false).text).toBe(
      'Тариф «Старт» не оплачен, поэтому новые задачи не принимаются.',
    )
    expect(told({ plan: null }, false).text).toBe('Подарочные кредиты закончились.')
    // A notice that names no payment reads the same.
    expect(told({ tariff: 250, facts: { today: { charged: 50 } } }, false).text).toBe(
      told({ tariff: 250, facts: { today: { charged: 50 } } }).text,
    )
    // A pack lifts the day: where it cannot be bought, only the day is told.
    expect(told({ tariff: 250, offer: PACK, facts: { today: { charged: 50 } } }, false).text).toBe(
      `Кредиты по тарифу на сегодня закончились: потрачено 50 из 50. Завтра снова можно будет потратить до 50 кредитов.`,
    )
  })
})

describe('a reason the pages of the account never show', () => {
  it('has no notice: the gift of a site is known only where the site is', () => {
    const given = input({ plan: null, gift: 35 })
    const siteUsed = { allowed: false, reason: 'gift_site_used' as TaskRefusalReason }
    expect(taskNotice({ ...given, task: { ...given.task, newTask: siteUsed } })).toBeNull()
  })
})

describe('every notice', () => {
  const cases: Case[] = [
    { plan: null },
    { plan: null, gift: 3 },
    { plan: null, gift: 15, facts: { unpaidWork: 70 } },
    { plan: null, giftHeld: 35 },
    { plan: null, pack: 40 },
    { offer: PACK },
    { tariff: 3, offer: PACK },
    { plan: { autoRenewal: false }, offer: PACK },
    { tariffHeld: 90, offer: PACK },
    { tariff: 250, offer: PACK, facts: { today: { charged: 50 } } },
    { tariff: 255, tariffHeld: 45, facts: { today: { charged: 5, held: 45 } } },
    { tariff: 255, tariffHeld: 45, pack: 1, facts: { today: { charged: 2, held: 45 } } },
    { tariff: 300, facts: { unpaidWork: 300 } },
    { plan: { status: 'past_due' } },
    { tariff: 300, facts: { rateUsable: false } },
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
    // Every reason a page of the account can be given has its case here.
    expect([...reasons].sort()).toEqual(
      [
        'below_start',
        'daily_limit',
        'empty',
        'ended',
        'gift_below_start',
        'gift_spent',
        'held',
        'past_due',
        'rate_missing',
        'trial_unpaid_limit',
        'unpaid_limit',
      ].sort(),
    )
  })

  it('says «лимиты закончились» wherever the credits of a paid tariff ran out', () => {
    for (const scenario of [{}, { tariff: 3 }, { plan: { autoRenewal: false } }] as Case[]) {
      expect(told(scenario).text).toMatch(/^Лимиты закончились/)
    }
  })

  it('says beside «Сменить тариф» that only a pack helps today', () => {
    expect(PLAN_CHANGE_STARTS_LATER).toBe('Новый тариф начнёт действовать со следующего периода.')
  })
})

describe('the row of the credits', () => {
  const task = (scenario: Case) => input(scenario).task

  it('says «Закончились» when fewer credits can be spent than a task needs and none is set aside', () => {
    expect(creditsLeft({ tariff: 0, gift: 0, pack: 0 }, task({}))).toBe('Закончились')
    expect(creditsLeft({ tariff: 3, gift: 0, pack: 0 }, task({ tariff: 3 }))).toBe('Закончились')
    expect(
      creditsLeft({ tariff: 1, gift: 2, pack: 1 }, task({ tariff: 1, gift: 2, pack: 1 })),
    ).toBe('Закончились')
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
    // Fewer are set aside than a task needs: the limits ran out, and the three are still not gone.
    const fewHeld = task({ tariffHeld: 3 })
    expect(fewHeld).toMatchObject({ spendable: 0, setAside: 3, newTask: { reason: 'empty' } })
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

  it('tells of the trial that is over, by the answer of the server — never of a day', () => {
    expect(lead({ gift: 20, facts: { today: { charged: 500 } } })).not.toMatch(/в день|сегодня/i)
    expect(lead({ gift: 15, facts: { unpaidWork: 70 } })).toBe(
      'Пробные задачи закончились: несколько задач остановились без результата, и без тарифа мы больше не можем их принимать. Выберите тариф, чтобы продолжить; оставшиеся 15 подарочных кредитов сохранятся.',
    )
  })

  it('tells that credits of a pack wait for a tariff, unless the block of the ended tariff says so', () => {
    expect(lead({ pack: 40 })).toBe(
      'Тариф закончился. У вас 40 кредитов из пакета: они не сгорают и снова будут доступны, когда вы выберете тариф.',
    )
    // The page shows the tariff that ended, with what it left: the line only leads on.
    expect(lead({ pack: 40 }, { hadTariff: true })).toBe(
      'Выберите тариф, чтобы снова ставить задачи.',
    )
    expect(lead({ pack: 40 }, { hadTariff: true, canChoose: false })).toBe(
      'Оплата пока недоступна.',
    )
  })

  it('says «payments are off» in place of the way to a tariff, where a tariff is the way', () => {
    const off = { canChoose: false }
    expect(lead({ gift: 15, facts: { unpaidWork: 70 } }, off)).toBe(
      'Пробные задачи закончились: несколько задач остановились без результата, и без тарифа мы больше не можем их принимать. Оплата пока недоступна.',
    )
    expect(lead({ pack: 40 }, off)).toMatch(/когда вы выберете тариф\. Оплата пока недоступна\.$/)
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
