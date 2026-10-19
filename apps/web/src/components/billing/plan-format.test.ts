import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  averageTaskCredits,
  minStartCredits,
  minTaskChargeCredits,
  signupGiftCredits,
  tasksPerDayWithoutTariff,
  typicalTaskCredits,
} from '@repo/domain/billing/credit-numbers'
import { describe, expect, it } from 'vitest'

import {
  cancelRenewalWarning,
  changeCancelledText,
  changeScheduledText,
  chargeUnderWayValue,
  checkoutWithoutRenewal,
  consentRenewalNotice,
  consentRenewalOff,
  creditsLeft,
  creditsOf,
  creditsWhileOverdue,
  creditsWord,
  currentPlanNote,
  endedText,
  endsUnlessCharged,
  endsWithPeriod,
  giftIsEnoughFor,
  giftTakesTasks,
  nextCharge,
  packAdded,
  packOffer,
  packPromise,
  pastDuePaymentTerms,
  pastDueText,
  planAverageTasks,
  planChangeCharge,
  planChangeTerms,
  planDailyLimit,
  planLimits,
  planSites,
  planTooSmall,
  renewalOffWhileOverdue,
  renewalUnavailable,
  renewalWhileOverdue,
  renewsWithChargeUnderWay,
  renewsWithPeriod,
  resumedText,
  resumeTerms,
  scheduledChange,
  scheduledPlanNote,
  taskCostRule,
  noGiftToSpeakOf,
} from './plan-format'
import { plansWithoutTariff } from './task-notice'
import { taskCreditsFor } from './testing'

/** The text as it reads: amounts and dates come with non-breaking spaces. */
const plain = (text: string) => text.replaceAll(String.fromCharCode(0xa0), ' ')

const periodEnd = new Date('2026-10-18T09:00:00Z')

describe('the limits of a tariff', () => {
  it('puts a tariff into one line', () => {
    expect(planLimits({ creditsPerMonth: 800, tasksPerDay: 10, maxSites: 3 })).toBe(
      '800 кредитов в месяц, до 10 задач в день · до 3 сайтов на WordPress',
    )
    expect(planLimits({ creditsPerMonth: 300, tasksPerDay: 5, maxSites: 1 })).toBe(
      '300 кредитов в месяц, до 5 задач в день · один сайт на WordPress',
    )
    expect(planLimits({ creditsPerMonth: 21, tasksPerDay: 1, maxSites: 2 })).toBe(
      '21 кредит в месяц, до 1 задачи в день · до 2 сайтов на WordPress',
    )
  })

  // A count of four digits is grouped as an amount of money is, with a plain space: the
  // component binds it where it is shown.
  it('groups the digits of a count of four digits', () => {
    expect(planLimits({ creditsPerMonth: 2500, tasksPerDay: 30, maxSites: 15 })).toBe(
      '2 500 кредитов в месяц, до 30 задач в день · до 15 сайтов на WordPress',
    )
  })

  it('leaves the day out for a tariff without a daily limit', () => {
    expect(planLimits({ creditsPerMonth: 21, tasksPerDay: null, maxSites: 2 })).toBe(
      '21 кредит в месяц · до 2 сайтов на WordPress',
    )
    expect(planDailyLimit(null)).toBeNull()
  })

  it.each([
    [1, 'До 1 задачи в день'],
    [2, 'До 2 задач в день'],
    [5, 'До 5 задач в день'],
    [10, 'До 10 задач в день'],
    [11, 'До 11 задач в день'],
    [21, 'До 21 задачи в день'],
    [22, 'До 22 задач в день'],
    [25, 'До 25 задач в день'],
    [30, 'До 30 задач в день'],
    [101, 'До 101 задачи в день'],
  ])('counts the daily limit of %i in tasks', (count, text) => {
    expect(planDailyLimit(count)).toBe(text)
  })

  // A tariff is sold in credits, and a customer thinks in requests: the card says how many
  // average tasks the credits hold. The divisor is the constant of the credits model.
  it.each([
    [300, 'В среднем около 27 задач'],
    [800, 'В среднем около 73 задач'],
    [2500, 'В среднем около 230 задач'],
    [11, 'В среднем около 1 задачи'],
    [22, 'В среднем около 2 задач'],
    [231, 'В среднем около 21 задачи'],
    [22000, 'В среднем около 2 000 задач'],
  ])('says how many average tasks %i credits a month hold', (credits, text) => {
    expect(planAverageTasks(credits)).toBe(text)
  })

  it('divides by the average charge of a task, and promises nothing where no task fits', () => {
    expect(averageTaskCredits).toBe(11)
    expect(planAverageTasks(averageTaskCredits * 40)).toBe('В среднем около 40 задач')
    expect(planAverageTasks(5)).toBeNull()
    expect(planAverageTasks(0)).toBeNull()
  })

  it.each([
    [1, 'Один сайт на WordPress'],
    [3, 'До 3 сайтов на WordPress'],
    [15, 'До 15 сайтов на WordPress'],
    [21, 'До 21 сайта на WordPress'],
  ])('names the sites of a tariff for %i', (count, text) => {
    expect(planSites(count)).toBe(text)
  })

  // The noun is masculine: what there is and what is added or charged take the same form.
  it.each([
    [1, 'кредит'],
    [2, 'кредита'],
    [3, 'кредита'],
    [5, 'кредитов'],
    [11, 'кредитов'],
    [12, 'кредитов'],
    [21, 'кредит'],
    [22, 'кредита'],
    [25, 'кредитов'],
    [80, 'кредитов'],
    [101, 'кредит'],
    [112, 'кредитов'],
  ])('picks the word for %i credits', (count, word) => {
    expect(creditsWord(count)).toBe(word)
  })

  it.each([
    [1, 'кредита'],
    [2, 'кредитов'],
    [5, 'кредитов'],
    [11, 'кредитов'],
    [21, 'кредита'],
    [22, 'кредитов'],
    [25, 'кредитов'],
    [101, 'кредита'],
    [111, 'кредитов'],
  ])('picks the word after «из» and «до» for %i credits', (count, word) => {
    expect(creditsOf(count)).toBe(word)
  })
})

describe('what a task costs', () => {
  it('says the rule in the numbers of the credits model', () => {
    expect(taskCostRule()).toBe(
      'Задача стоит столько кредитов, сколько работы она потребовала, но не меньше 5: небольшая правка текста, цены или фото — обычно 5 кредитов, добавить блок или страницу — 15–25. Кредиты списываются только за выполненную задачу. Уточнения и «Изменить» — часть той же задачи: работа над ними добавляется к её стоимости. «Отменить» — бесплатно.',
    )
  })

  // The sentence prints the constants and holds no number of its own.
  it('takes every number from the constants of the domain', () => {
    const { small, block } = typicalTaskCredits
    expect([minTaskChargeCredits, small, block]).toEqual([
      5,
      { from: 5, to: 5 },
      { from: 15, to: 25 },
    ])
    const numbers = taskCostRule().match(/\d+/g)
    expect(numbers?.map(Number)).toEqual([minTaskChargeCredits, small.to, block.from, block.to])
  })

  it('no longer says that a task is one credit', () => {
    expect(taskCostRule()).not.toMatch(/один кредит|тот же кредит/)
  })
})

describe('a tariff that does not fit the sites', () => {
  it('says how many sites the customer has and how many the tariff holds', () => {
    expect(planTooSmall(2, 1)).toBe('Не подойдёт: у вас два сайта, а тариф рассчитан на один.')
    expect(planTooSmall(4, 3)).toBe('Не подойдёт: у вас четыре сайта, а тариф рассчитан на три.')
  })

  it('writes larger numbers in digits', () => {
    expect(planTooSmall(5, 3)).toBe('Не подойдёт: у вас 5 сайтов, а тариф рассчитан на три.')
    expect(planTooSmall(21, 15)).toBe('Не подойдёт: у вас 21 сайт, а тариф рассчитан на 15.')
  })
})

describe('the credits left', () => {
  it('names both accounts when both have credits', () => {
    expect(creditsLeft({ tariff: 45, gift: 0, pack: 10 })).toBe(
      'Осталось 55: 45 по тарифу и 10 из пакета',
    )
    expect(creditsLeft({ tariff: 300, gift: 0, pack: 100 })).toBe(
      'Осталось 400: 300 по тарифу и 100 из пакета',
    )
  })

  it('names the one account that has credits', () => {
    expect(creditsLeft({ tariff: 45, gift: 0, pack: 0 })).toBe('Осталось 45 по тарифу')
    expect(creditsLeft({ tariff: 0, gift: 0, pack: 10 })).toBe('Осталось 10 из пакета')
  })

  it('groups the digits of a count of four digits', () => {
    expect(creditsLeft({ tariff: 2500, gift: 0, pack: 1100 })).toBe(
      'Осталось 3 600: 2 500 по тарифу и 1 100 из пакета',
    )
    expect(creditsLeft({ tariff: 2500, gift: 0, pack: 0 })).toBe('Осталось 2 500 по тарифу')
    expect(creditsLeft({ tariff: 0, gift: 0, pack: 1200 })).toBe('Осталось 1 200 из пакета')
  })

  it('says that nothing is left', () => {
    expect(creditsLeft({ tariff: 0, gift: 0, pack: 0 })).toBe('Закончились')
  })

  it('names the gift credits between those of the tariff and those of the pack', () => {
    expect(creditsLeft({ tariff: 45, gift: 4, pack: 10 })).toBe(
      'Осталось 59: 45 по тарифу, 4 подарочных и 10 из пакета',
    )
    expect(creditsLeft({ tariff: 300, gift: 35, pack: 100 })).toBe(
      'Осталось 435: 300 по тарифу, 35 подарочных и 100 из пакета',
    )
    expect(creditsLeft({ tariff: 2500, gift: 1, pack: 1100 })).toBe(
      'Осталось 3 601: 2 500 по тарифу, 1 подарочный и 1 100 из пакета',
    )
  })

  it('names two accounts of the three, in the order the credits are spent in', () => {
    expect(creditsLeft({ tariff: 300, gift: 35, pack: 0 })).toBe(
      'Осталось 335: 300 по тарифу и 35 подарочных',
    )
    expect(creditsLeft({ tariff: 0, gift: 35, pack: 100 })).toBe(
      'Осталось 135: 35 подарочных и 100 из пакета',
    )
    expect(creditsLeft({ tariff: 800, gift: 21, pack: 0 })).toBe(
      'Осталось 821: 800 по тарифу и 21 подарочный',
    )
  })

  it.each([
    [35, 'Осталось 35 подарочных'],
    [5, 'Осталось 5 подарочных'],
    [3, 'Осталось 3 подарочных'],
    [1, 'Остался 1 подарочный'],
    [21, 'Остался 21 подарочный'],
    [1200, 'Осталось 1 200 подарочных'],
  ])('names the gift alone when only it has credits: %i', (gift, text) => {
    expect(creditsLeft({ tariff: 0, gift, pack: 0 })).toBe(text)
  })

  it('never names an account with nothing left as a part', () => {
    for (const tariff of [0, 45]) {
      for (const gift of [0, 4]) {
        for (const pack of [0, 10]) {
          const text = creditsLeft({ tariff, gift, pack })
          expect(text.includes('по тарифу')).toBe(tariff > 0)
          expect(text.includes('подарочн')).toBe(gift > 0)
          expect(text.includes('из пакета')).toBe(pack > 0)
          expect(text).not.toMatch(/(?:^|\D)0 (?:по тарифу|подарочн|из пакета)/)
        }
      }
    }
  })
})

describe('the gift of the registration', () => {
  const gift = (available: number, patch: { held?: number; granted?: boolean } = {}) => ({
    available,
    held: 0,
    granted: true,
    ...patch,
  })

  it('takes tasks from the number of credits a new task needs', () => {
    expect(minStartCredits).toBe(5)
    expect(giftTakesTasks(35)).toBe(true)
    expect(giftTakesTasks(minStartCredits)).toBe(true)
    expect(giftTakesTasks(minStartCredits - 1)).toBe(false)
    expect(giftTakesTasks(0)).toBe(false)
  })

  /** What the server answers about a new task of a customer who has this gift and no tariff. */
  const taskOn = ({ available, held }: ReturnType<typeof gift>) =>
    taskCreditsFor(
      {
        tariff: { balance: 0, held: 0 },
        gift: { balance: available + held, held },
        pack: { balance: 0, held: 0 },
      },
      null,
    )

  it.each([
    // Granted and on the account, or promised to a user who has no workspace yet.
    [null, gift(35)],
    [null, gift(35, { granted: false })],
    [null, gift(5)],
    [null, gift(30, { held: 5 })],
    ['gift_below_start', gift(4)],
    ['gift_below_start', gift(1)],
    ['gift_spent', gift(0)],
    // Never granted to this workspace, and none is promised: the same answer of the server.
    ['gift_spent', gift(0, { granted: false })],
    // Set aside for a task in work: neither spent nor to be spent now.
    ['held', gift(2, { held: 33 })],
    ['held', gift(0, { held: 35 })],
  ] as const)('is answered «%s» by the server for %o', (reason, credits) => {
    expect(taskOn(credits).newTask).toEqual({ allowed: reason === null, reason })
  })

  it('tells a gift that was never granted from one that is used up, by the account', () => {
    const never = gift(0, { granted: false })
    expect(noGiftToSpeakOf(never, taskOn(never))).toBe(true)
    expect(noGiftToSpeakOf(gift(0), taskOn(gift(0)))).toBe(false)
    // A promise is no «nothing to speak of», and neither is a gift that can start a task.
    for (const credits of [gift(35, { granted: false }), gift(35), gift(3)]) {
      expect(noGiftToSpeakOf(credits, taskOn(credits))).toBe(false)
    }
  })

  it('says what the gift is enough for, as the welcome letter does', () => {
    expect(giftIsEnoughFor(signupGiftCredits)).toBe(
      'на семь небольших правок или на две-три задачи побольше',
    )
  })

  // The same table as `packages/mail/src/templates/billing-format.test.ts`: the page and the
  // letter build the phrase with a copy each, and promise the same.
  it.each([
    [0, null],
    [4, null],
    [5, 'на одну небольшую правку'],
    [10, 'на две небольшие правки'],
    [14, 'на две небольшие правки'],
    [15, 'на три небольшие правки или на одну задачу побольше'],
    [20, 'на четыре небольшие правки или на одну-две задачи побольше'],
    [25, 'на пять небольших правок или на одну-две задачи побольше'],
    [30, 'на шесть небольших правок или на две-три задачи побольше'],
    [50, 'на десять небольших правок или на три-пять задач побольше'],
    [55, 'на 11 небольших правок или на три-пять задач побольше'],
    [105, 'на 21 небольшую правку или на семь-десять задач побольше'],
    [300, 'на 60 небольших правок или на 20-27 задач побольше'],
  ])('says for %i credits: %s', (credits, text) => {
    expect(giftIsEnoughFor(credits)).toBe(text)
  })

  const lead = (
    credits: ReturnType<typeof gift>,
    patch: { hadTariff?: boolean; canChoose?: boolean } = {},
  ) =>
    plansWithoutTariff({
      gift: credits,
      task: taskOn(credits),
      packLeft: 0,
      hadTariff: false,
      canChoose: true,
      ...patch,
    })

  it('tells a customer without a tariff what the gift is enough for, and that a tariff comes after it', () => {
    const text =
      'У вас 35 подарочных кредитов — их хватит на семь небольших правок или на две-три задачи побольше. Без тарифа можно поставить до 3 задач в день. Когда кредиты закончатся, понадобится тариф.'
    expect(tasksPerDayWithoutTariff).toBe(3)
    expect(lead(gift(35))).toBe(text)
    // The same to a user who has no workspace yet: the gift is granted with it.
    expect(lead(gift(35, { granted: false }))).toBe(text)
    // And after a tariff has ended: gift credits are spent without one.
    expect(lead(gift(35), { hadTariff: true })).toBe(text)
  })

  it.each([
    [
      20,
      'У вас 20 подарочных кредитов — их хватит на четыре небольшие правки или на одну-две задачи побольше. Без тарифа можно поставить до 3 задач в день. Когда кредиты закончатся, понадобится тариф.',
    ],
    [
      21,
      'У вас 21 подарочный кредит — его хватит на четыре небольшие правки или на одну-две задачи побольше. Без тарифа можно поставить до 3 задач в день. Когда кредиты закончатся, понадобится тариф.',
    ],
    [
      22,
      'У вас 22 подарочных кредита — их хватит на четыре небольшие правки или на одну-две задачи побольше. Без тарифа можно поставить до 3 задач в день. Когда кредиты закончатся, понадобится тариф.',
    ],
    [
      5,
      'У вас 5 подарочных кредитов — их хватит на одну небольшую правку. Без тарифа можно поставить до 3 задач в день. Когда кредиты закончатся, понадобится тариф.',
    ],
  ])('counts what is left of a gift that was partly spent: %i', (available, text) => {
    expect(lead(gift(available))).toBe(text)
  })

  it.each([
    [
      4,
      'Осталось 4 подарочных кредита, а на новую задачу нужно не меньше 5. Выберите тариф — подарочные кредиты сохранятся и прибавятся к кредитам тарифа.',
    ],
    [
      3,
      'Осталось 3 подарочных кредита, а на новую задачу нужно не меньше 5. Выберите тариф — подарочные кредиты сохранятся и прибавятся к кредитам тарифа.',
    ],
    [
      1,
      'Остался 1 подарочный кредит, а на новую задачу нужно не меньше 5. Выберите тариф — подарочные кредиты сохранятся и прибавятся к кредитам тарифа.',
    ],
  ])('says that %i gift credits start no task, and that a tariff keeps them', (available, text) => {
    expect(lead(gift(available))).toBe(text)
    expect(lead(gift(available), { hadTariff: true })).toBe(text)
  })

  it('says that the gift is used up and sends the customer to a tariff', () => {
    const text = 'Подарочные кредиты закончились. Чтобы ставить новые задачи, выберите тариф.'
    expect(lead(gift(0))).toBe(text)
    expect(lead(gift(0), { hadTariff: true })).toBe(text)
  })

  it('speaks of no gift where there is none to speak of', () => {
    const none = gift(0, { granted: false })
    expect(lead(none)).toBe('Выберите тариф, чтобы начать ставить задачи.')
    expect(lead(none, { hadTariff: true })).toBe('Выберите тариф, чтобы снова ставить задачи.')
    expect(lead(none, { canChoose: false })).toBe('Оплата пока недоступна.')
  })

  it('says that the gift is set aside for the task in work, and how much of it', () => {
    const text =
      'Подарочные кредиты заняты задачей в работе: под неё отложено 35. Когда она закончится, спишем только то, что ушло на работу, остальное вернётся — и можно будет поставить следующую.'
    expect(lead(gift(0, { held: 35 }))).toBe(text)
    expect(lead(gift(2, { held: 33 }))).toBe(text.replace('отложено 35', 'отложено 33'))
    // The way on is a tariff, and none can be chosen.
    expect(lead(gift(0, { held: 35 }), { canChoose: false })).toBe(
      `${text} Оплата пока недоступна.`,
    )
  })

  it('does not send the customer to choose a tariff while nothing can be paid for', () => {
    const off = { canChoose: false }
    expect(lead(gift(35), off)).toBe(
      'У вас 35 подарочных кредитов — их хватит на семь небольших правок или на две-три задачи побольше. Без тарифа можно поставить до 3 задач в день. Когда кредиты закончатся, понадобится тариф. Оплата пока недоступна.',
    )
    expect(lead(gift(3), off)).toBe(
      'Осталось 3 подарочных кредита, а на новую задачу нужно не меньше 5. Оплата пока недоступна.',
    )
    expect(lead(gift(0), off)).toBe('Подарочные кредиты закончились. Оплата пока недоступна.')
    for (const credits of [gift(35), gift(3), gift(0), gift(0, { granted: false })]) {
      expect(lead(credits, off)).not.toMatch(/[Вв]ыберите/)
    }
  })

  it('says that tasks are taken after the tariff only while gift credits can start one', () => {
    const after = 'После этого новые задачи принимаются, только пока есть подарочные кредиты.'
    const without = 'После этого новые задачи не принимаются, пока вы снова не выберете тариф.'
    expect(plain(endsWithPeriod(periodEnd, { tariff: 45, gift: 35, pack: 10 }))).toBe(
      `Автопродление отключено. Тариф и 45 кредитов по тарифу доступны до 18 октября 2026. ${after} 10 кредитов из пакета, сайты и история правок сохранятся.`,
    )
    expect(plain(endsWithPeriod(periodEnd, { tariff: 0, gift: 5, pack: 0 }))).toBe(
      `Автопродление отключено. Тариф действует до 18 октября 2026. ${after} Сайты и история правок сохранятся.`,
    )
    // Fewer than a task needs: as without a gift.
    expect(plain(endsWithPeriod(periodEnd, { tariff: 45, gift: 4, pack: 10 }))).toBe(
      `Автопродление отключено. Тариф и 45 кредитов по тарифу доступны до 18 октября 2026. ${without} 10 кредитов из пакета, сайты и история правок сохранятся.`,
    )
  })

  it('says the same before auto-renewal is switched off', () => {
    const cancel = (
      left: { tariff: number; gift: number; pack: number },
      charge: 'none' | 'at_bank',
    ) =>
      cancelRenewalWarning({
        planName: 'Старт',
        periodEnd,
        left,
        pastDue: false,
        nextPlanName: null,
        charge,
        oneTimeOnly: false,
      }).map(plain)

    expect(cancel({ tariff: 300, gift: 35, pack: 0 }, 'none')).toEqual([
      'Тариф «Старт» будет действовать до 18 октября 2026. 300 кредитов по тарифу можно использовать до этого дня.',
      'С 18 октября новые задачи будут приниматься, только пока есть подарочные кредиты. Сайты и история правок сохранятся.',
    ])
    expect(cancel({ tariff: 300, gift: 4, pack: 100 }, 'none').at(-1)).toBe(
      'С 18 октября новые задачи не будут приниматься, пока вы снова не выберете тариф. 100 кредитов из пакета, сайты и история правок сохранятся.',
    )
    // While a charge is under way no day is named, and the gift changes the same clause.
    expect(cancel({ tariff: 300, gift: 35, pack: 100 }, 'at_bank').at(-1)).toBe(
      'Когда тариф закончится, новые задачи будут приниматься, только пока есть подарочные кредиты. 100 кредитов из пакета, сайты и история правок сохранятся.',
    )
    expect(cancel({ tariff: 300, gift: 0, pack: 0 }, 'at_bank').at(-1)).toBe(
      'Когда тариф закончится, новые задачи не будут приниматься, пока вы снова не выберете тариф. Сайты и история правок сохранятся.',
    )
  })

  it('says of an overdue tariff that tasks are taken on gift credits meanwhile', () => {
    const overdue = (taken: boolean) =>
      pastDueText({
        canPay: true,
        autoRenewal: false,
        endsAt: null,
        canReplaceCard: true,
        tasksTaken: taken,
      })
    expect(overdue(true)).toBe(
      'Оплатите тариф: пока оплата не пройдёт, новые задачи принимаются, только пока есть подарочные кредиты.',
    )
    expect(overdue(false)).toBe(
      'Оплатите тариф: пока оплата не пройдёт, новые задачи не принимаются.',
    )
    expect(
      pastDueText({
        canPay: false,
        autoRenewal: true,
        endsAt: null,
        canReplaceCard: true,
        tasksTaken: true,
      }),
    ).toBe(
      'Оплата сейчас недоступна: пока оплата не пройдёт, новые задачи принимаются, только пока есть подарочные кредиты.',
    )
  })

  it('names the gift credits of an overdue tariff as left, and the rest as coming with the payment', () => {
    expect(creditsWhileOverdue({ gift: 35, pack: 0 }, 0)).toBe(
      'Осталось 35 подарочных. Кредиты по тарифу начислим после оплаты',
    )
    expect(creditsWhileOverdue({ gift: 35, pack: 100 }, 0)).toBe(
      'Осталось 35 подарочных. После оплаты — новые кредиты по тарифу и 100 из пакета',
    )
    expect(creditsWhileOverdue({ gift: 1, pack: 0 }, 0)).toBe(
      'Остался 1 подарочный. Кредиты по тарифу начислим после оплаты',
    )
    expect(creditsWhileOverdue({ gift: 1200, pack: 1100 }, 0)).toBe(
      'Осталось 1 200 подарочных. После оплаты — новые кредиты по тарифу и 1 100 из пакета',
    )
    // What is free is named, whatever the task in work has set aside beside it.
    expect(creditsWhileOverdue({ gift: 2, pack: 0 }, 33)).toBe(
      'Осталось 2 подарочных. Кредиты по тарифу начислим после оплаты',
    )
  })

  it('names the gift credits of an overdue tariff that the task in work has set aside', () => {
    // None is free, and they are not gone: the notice beside the row says the rest comes back.
    expect(creditsWhileOverdue({ gift: 0, pack: 0 }, 35)).toBe(
      'Отложено под задачу в работе: 35 подарочных. Кредиты по тарифу начислим после оплаты',
    )
    expect(creditsWhileOverdue({ gift: 0, pack: 100 }, 35)).toBe(
      'Отложено под задачу в работе: 35 подарочных. После оплаты — новые кредиты по тарифу и 100 из пакета',
    )
    expect(creditsWhileOverdue({ gift: 0, pack: 0 }, 1)).toBe(
      'Отложено под задачу в работе: 1 подарочный. Кредиты по тарифу начислим после оплаты',
    )
    expect(creditsWhileOverdue({ gift: 0, pack: 1100 }, 1200)).toBe(
      'Отложено под задачу в работе: 1 200 подарочных. После оплаты — новые кредиты по тарифу и 1 100 из пакета',
    )
    // Nothing free and nothing set aside: only then are the credits out of reach.
    expect(creditsWhileOverdue({ gift: 0, pack: 0 }, 0)).toBe('Недоступны, пока тариф не оплачен')
    expect(creditsWhileOverdue({ gift: 0, pack: 100 }, 0)).toBe(
      'Недоступны, пока тариф не оплачен. После оплаты — новые кредиты по тарифу и 100 из пакета',
    )
  })

  it('says of an ended tariff that tasks are taken while gift credits can start one', () => {
    expect(endedText({ reason: 'not_renewed', packCredits: 0, tasksTaken: true })).toBe(
      'Новые задачи принимаются, только пока есть подарочные кредиты. Сайты и история правок на месте.',
    )
    expect(endedText({ reason: 'not_paid', packCredits: 100, tasksTaken: true })).toBe(
      'Оплата за следующий период не прошла, и тариф закончился. Новые задачи принимаются, только пока есть подарочные кредиты. 100 кредитов из пакета, сайты и история правок на месте.',
    )
    expect(endedText({ reason: 'refunded', packCredits: 0, tasksTaken: false })).toBe(
      'Мы вернули оплату за этот тариф, и он закончился. Новые задачи сейчас не принимаются. Сайты и история правок на месте.',
    )
  })

  it('never speaks of receipts, VAT, a price or the customer on «ты», and ends every sentence', () => {
    const texts = [
      ...[35, 21, 5, 4, 1, 0].flatMap((available) => [
        lead(gift(available)),
        lead(gift(available), { canChoose: false }),
        lead(gift(available), { hadTariff: true }),
      ]),
      lead(gift(0, { granted: false })),
      endsWithPeriod(periodEnd, { tariff: 45, gift: 35, pack: 10 }),
      endedText({ reason: 'refunded', packCredits: 5, tasksTaken: true }),
      pastDueText({
        canPay: true,
        autoRenewal: true,
        endsAt: periodEnd,
        canReplaceCard: true,
        tasksTaken: true,
      }),
    ]
    for (const text of texts) {
      expect(text).not.toMatch(/[A-Za-z]|НДС|чек|₽|руб|бесплатн/i)
      expect(text).not.toMatch(/(?:^|[^а-яё])(?:ты|тебя|тебе|твой|твоя|твоё|твои)(?:[^а-яё]|$)/i)
      expect(text).toMatch(/[.!?]$/)
      // «Оплата за действие» is not sold and not named.
      expect(text).not.toMatch(/за действие|кошел/i)
    }
  })
})

describe('the end of the period', () => {
  it('names the day and the amount of the next charge', () => {
    expect(plain(nextCharge(periodEnd, '12900.00'))).toBe('18 октября 2026 — 12 900 ₽')
  })

  it('tells what stays when auto-renewal is off', () => {
    expect(plain(endsWithPeriod(periodEnd, { tariff: 45, gift: 0, pack: 10 }))).toBe(
      'Автопродление отключено. Тариф и 45 кредитов по тарифу доступны до 18 октября 2026. После этого новые задачи не принимаются, пока вы снова не выберете тариф. 10 кредитов из пакета, сайты и история правок сохранятся.',
    )
  })

  it('does not count credits that are not there', () => {
    expect(plain(endsWithPeriod(periodEnd, { tariff: 0, gift: 0, pack: 0 }))).toBe(
      'Автопродление отключено. Тариф действует до 18 октября 2026. После этого новые задачи не принимаются, пока вы снова не выберете тариф. Сайты и история правок сохранятся.',
    )
    expect(plain(endsWithPeriod(periodEnd, { tariff: 1, gift: 0, pack: 2 }))).toContain(
      'Тариф и 1 кредит по тарифу доступны до 18 октября 2026.',
    )
    expect(plain(endsWithPeriod(periodEnd, { tariff: 1, gift: 0, pack: 2 }))).toContain(
      '2 кредита из пакета, сайты и история правок сохранятся.',
    )
  })

  it('tells what the renewal charges and grants, and where the letter goes', () => {
    expect(
      plain(
        renewsWithPeriod({
          periodEnd,
          plan: { name: 'Бизнес', price: '12900.00', creditsPerMonth: 800 },
          changes: false,
          email: 'anna@example.ru',
        }),
      ),
    ).toBe(
      'Включено. 18 октября спишем 12 900 ₽ сохранённым способом оплаты и начислим 800 кредитов на новый период. Перед списанием пришлём письмо на anna@example.ru.',
    )
  })

  it('names the tariff of the next period when a change is scheduled', () => {
    expect(
      plain(
        renewsWithPeriod({
          periodEnd,
          plan: { name: 'Агентство', price: '39900.00', creditsPerMonth: 2500 },
          changes: true,
          email: 'anna@example.ru',
        }),
      ),
    ).toBe(
      'Включено. С 18 октября — тариф «Агентство»: спишем 39 900 ₽ сохранённым способом оплаты и начислим 2 500 кредитов на новый период. Перед списанием пришлём письмо на anna@example.ru.',
    )
  })

  it('writes the note of the customer`s own tariff', () => {
    expect(plain(currentPlanNote(periodEnd, true))).toBe('Продлится 18 октября.')
    expect(plain(currentPlanNote(periodEnd, false))).toBe('Действует до 18 октября.')
  })
})

describe('a pack of credits', () => {
  it.each([
    [1, 'Добавим 1 кредит сразу после оплаты.'],
    [2, 'Добавим 2 кредита сразу после оплаты.'],
    [5, 'Добавим 5 кредитов сразу после оплаты.'],
    [10, 'Добавим 10 кредитов сразу после оплаты.'],
    [11, 'Добавим 11 кредитов сразу после оплаты.'],
    [21, 'Добавим 21 кредит сразу после оплаты.'],
    [22, 'Добавим 22 кредита сразу после оплаты.'],
    [25, 'Добавим 25 кредитов сразу после оплаты.'],
    [100, 'Добавим 100 кредитов сразу после оплаты.'],
    [101, 'Добавим 101 кредит сразу после оплаты.'],
    [1000, 'Добавим 1 000 кредитов сразу после оплаты.'],
  ])('promises its %i credits right after the payment, and that they stay', (credits, promise) => {
    expect(packPromise(credits)).toBe(`${promise} Кредиты из пакета не сгорают в конце периода.`)
  })

  it.each([
    [1, 'Добавили 1 кредит.'],
    [2, 'Добавили 2 кредита.'],
    [3, 'Добавили 3 кредита.'],
    [5, 'Добавили 5 кредитов.'],
    [10, 'Добавили 10 кредитов.'],
    [11, 'Добавили 11 кредитов.'],
    [21, 'Добавили 21 кредит.'],
    [22, 'Добавили 22 кредита.'],
    [25, 'Добавили 25 кредитов.'],
    [100, 'Добавили 100 кредитов.'],
    [101, 'Добавили 101 кредит.'],
    [1000, 'Добавили 1 000 кредитов.'],
  ])('says that the %i credits of a paid pack are added', (credits, added) => {
    expect(packAdded(credits)).toBe(`${added} Кредиты из пакета не сгорают в конце периода.`)
  })

  it('says the same of a paid pack whose size is not known', () => {
    expect(packAdded(null)).toBe('Кредиты из пакета уже добавлены и не сгорают в конце периода.')
  })

  // The row of the pack on «Тарифы»: when it is of use, how many average tasks it holds, and
  // the promise of its dialog.
  it('offers the pack with the average tasks its credits hold', () => {
    expect(packOffer(100)).toBe(
      'Пригодится, если кредиты по тарифу закончатся до конца периода: это в среднем около 9 задач. Добавим 100 кредитов сразу после оплаты. Кредиты из пакета не сгорают в конце периода.',
    )
    expect(packOffer(11)).toBe(
      `Пригодится, если кредиты по тарифу закончатся до конца периода: это в среднем около 1 задачи. ${packPromise(11)}`,
    )
    // A pack that holds no average task makes no promise of tasks.
    expect(packOffer(5)).toBe(
      `Пригодится, если кредиты по тарифу закончатся до конца периода. ${packPromise(5)}`,
    )
  })

  it('never speaks of receipts, VAT or the customer on «ты»', () => {
    for (const text of [packPromise(100), packOffer(100), packAdded(100), packAdded(null)]) {
      expect(text).not.toMatch(/[A-Za-z]|НДС|чек/i)
    }
  })
})

describe('managing the tariff', () => {
  const agency = {
    name: 'Агентство',
    price: '39900.00',
    creditsPerMonth: 2500,
    tasksPerDay: 30,
    maxSites: 15,
  }
  const MIR = `Карта «Мир» ••${String.fromCharCode(0xa0)}4444`

  it('says what was switched on, and of a charge that has already left', () => {
    expect(resumedText('none')).toBe('Автопродление включено. Перед списанием пришлём письмо.')
    expect(resumedText('at_bank')).toBe(
      'Автопродление включено. Списание за следующий период уже отправлено в банк; перед каждым следующим пришлём письмо.',
    )
    expect(resumedText('unanswered')).toBe(
      'Автопродление включено. Списание за следующий период уже отправлялось в банк, ответа пока нет; перед каждым следующим пришлём письмо.',
    )
  })

  it('names what a customer without a card agrees to when a change is scheduled', () => {
    expect(
      plain(
        resumeTerms({
          periodEnd,
          plan: agency,
          changes: true,
          methodLabel: null,
          charge: 'none',
        }),
      ),
    ).toBe(
      'Сначала привяжем карту на странице ЮKassa: деньги при этом не спишутся. Когда карта сохранится, автопродление включится: 18 октября тариф сменится на «Агентство»: в этот день и дальше каждый месяц будем списывать 39 900 ₽ с этой карты. Перед списанием пришлём письмо.',
    )
  })

  it('warns a customer without credits left that only the tariff ends', () => {
    expect(
      cancelRenewalWarning({
        planName: 'Старт',
        periodEnd,
        left: { tariff: 0, gift: 0, pack: 0 },
        pastDue: false,
        nextPlanName: null,
        charge: 'none',
        oneTimeOnly: false,
      }).map(plain),
    ).toEqual([
      'Тариф «Старт» будет действовать до 18 октября 2026.',
      'С 18 октября новые задачи не будут приниматься, пока вы снова не выберете тариф. Сайты и история правок сохранятся.',
    ])
  })

  it('warns of a charge without an answer, and of what stays after the tariff', () => {
    expect(
      cancelRenewalWarning({
        planName: 'Бизнес',
        periodEnd,
        left: { tariff: 45, gift: 0, pack: 1 },
        pastDue: false,
        nextPlanName: null,
        charge: 'unanswered',
        oneTimeOnly: false,
      }),
    ).toEqual([
      'Автопродление отключится. Списание за следующий период уже отправлялось в банк, ответа пока нет. Мы проверим его: если деньги списаны, тариф продлится ещё на месяц или мы вернём их. Отключение это списание не отменит; других списаний не будет.',
      'Когда тариф закончится, новые задачи не будут приниматься, пока вы снова не выберете тариф. 1 кредит из пакета, сайты и история правок сохранятся.',
    ])
  })

  it('says before the step that auto-renewal cannot be switched back on at a shop that takes one-time payments only', () => {
    const noWayBack = 'Включить автопродление снова пока будет нельзя.'
    const tariff = {
      planName: 'Бизнес',
      periodEnd,
      left: { tariff: 45, gift: 0, pack: 10 },
      nextPlanName: 'Агентство',
    }
    // In every state of the tariff: the page offers no «Включить автопродление» after any.
    for (const state of [
      { pastDue: false, charge: 'none' },
      { pastDue: false, charge: 'at_bank' },
      { pastDue: false, charge: 'unanswered' },
      { pastDue: true, charge: 'none' },
    ] as const) {
      const anywhere = cancelRenewalWarning({ ...tariff, ...state, oneTimeOnly: false })
      // The last word of the dialog, in a paragraph of its own.
      expect(cancelRenewalWarning({ ...tariff, ...state, oneTimeOnly: true })).toEqual([
        ...anywhere,
        noWayBack,
      ])
      // Where it can be switched back on, nothing is said of it.
      expect(anywhere.join(' ')).not.toContain('Включить автопродление')
    }
  })

  it('says the same on the page of the consents, where one press switches auto-renewal off', () => {
    const noWayBack = 'Включить автопродление снова пока будет нельзя.'
    const coming = {
      planName: 'Бизнес',
      nextPlanName: null,
      amount: '12900.00',
      chargeAt: periodEnd,
    }
    // No dialog asks first there: the last sentence above the button says it.
    expect(
      plain(consentRenewalNotice({ ...coming, renewalCharge: 'none', oneTimeOnly: true })),
    ).toBe(
      `У вас включено автопродление тарифа «Бизнес»: 18 октября спишем 12 900 ₽. Отключить его можно, не принимая документы. ${noWayBack}`,
    )
    expect(consentRenewalNotice({ ...coming, renewalCharge: 'at_bank', oneTimeOnly: true })).toBe(
      `У вас включено автопродление тарифа «Бизнес». Списание за следующий период уже отправлено в банк. Отключить автопродление можно, не принимая документы: это списание не отменится, других не будет. ${noWayBack}`,
    )
    // Whatever is charged and whenever: a scheduled change, a charge without an answer.
    for (const state of [
      { nextPlanName: null, renewalCharge: 'none' },
      { nextPlanName: 'Агентство', renewalCharge: 'none' },
      { nextPlanName: null, renewalCharge: 'at_bank' },
      { nextPlanName: 'Агентство', renewalCharge: 'unanswered' },
    ] as const) {
      const anywhere = consentRenewalNotice({ ...coming, ...state, oneTimeOnly: false })
      expect(consentRenewalNotice({ ...coming, ...state, oneTimeOnly: true })).toBe(
        `${anywhere} ${noWayBack}`,
      )
      // Where it can be switched back on, nothing is said of it.
      expect(anywhere).not.toContain('Включить автопродление')
    }
  })

  it('tells how a change of tariff is paid for, with the card when it is known', () => {
    expect(
      planChangeCharge({
        periodEnd,
        price: '39900.00',
        autoRenewal: true,
        methodLabel: null,
      }),
    ).toMatchObject({ value: `39${String.fromCharCode(0xa0)}900 ₽ сохранённым способом оплаты` })
    expect(
      plain(
        planChangeCharge({ periodEnd, price: '4900.00', autoRenewal: true, methodLabel: MIR })
          .value,
      ),
    ).toBe('4 900 ₽ сохранённым способом оплаты — Карта «Мир» •• 4444')
    expect(plain(planChangeTerms({ currentName: 'Старт', periodEnd, replacedName: null }))).toBe(
      'Тариф изменится 18 октября 2026 — с началом нового периода. До этого дня действует «Старт». Кредиты по тарифу можно использовать до 18 октября, на новый период они не переносятся. Кредиты из пакета остаются.',
    )
  })

  it('names the scheduled tariff for every state of the one that gives way', () => {
    const coming = (patch: object) =>
      scheduledChange({
        next: agency,
        periodEnd,
        autoRenewal: true,
        pastDue: false,
        charge: 'none',
        canResume: true,
        ...patch,
      })
    expect(plain(coming({}).title)).toBe('С 18 октября — тариф «Агентство»')
    expect(plain(coming({ charge: 'unanswered' }).text)).toBe(
      '2 500 кредитов в месяц, до 30 задач в день · до 15 сайтов на WordPress. Списание за следующий период уже отправлялось в банк, ответа пока нет. Отменить переход можно будет после него.',
    )
    expect(coming({ autoRenewal: false }).title).toBe('Выбран тариф «Агентство»')
    const limits = '2 500 кредитов в месяц, до 30 задач в день · до 15 сайтов на WordPress.'
    const ends = `${limits} Автопродление отключено, поэтому 18 октября тариф закончится и переход не состоится.`
    expect(plain(coming({ autoRenewal: false }).text)).toBe(
      `${ends} Чтобы перейти, включите автопродление: 18 октября спишем 39 900 ₽.`,
    )
    // Where auto-renewal cannot be switched on, nobody is told to switch it on.
    expect(plain(coming({ autoRenewal: false, canResume: false }).text)).toBe(ends)
    expect(coming({ canResume: false })).toEqual(coming({}))
    // An overdue tariff is paid by hand: nothing is said of auto-renewal or of a day.
    expect(plain(coming({ pastDue: true, autoRenewal: false }).text)).toBe(
      '2 500 кредитов в месяц, до 30 задач в день · до 15 сайтов на WordPress. К оплате — 39 900 ₽: тариф сменится, как только оплата пройдёт.',
    )
    expect(plain(scheduledPlanNote(periodEnd, true))).toBe('Начнёт действовать 18 октября.')
    expect(scheduledPlanNote(periodEnd, false)).toBe('Выбран на следующий период.')
    expect(plain(changeScheduledText('Старт', periodEnd, true))).toBe(
      'Готово: с 18 октября — тариф «Старт».',
    )
    expect(changeCancelledText('Старт')).toBe('Переход отменён: остаётся тариф «Старт».')
  })

  it('says what an overdue customer can do, with the last day only when there is one', () => {
    expect(
      pastDueText({
        canPay: true,
        autoRenewal: false,
        endsAt: null,
        canReplaceCard: true,
        tasksTaken: false,
      }),
    ).toBe('Оплатите тариф: пока оплата не пройдёт, новые задачи не принимаются.')
    expect(
      plain(
        pastDueText({
          canPay: true,
          autoRenewal: true,
          endsAt: new Date('2026-10-25T09:00:05Z'),
          canReplaceCard: true,
          tasksTaken: false,
        }),
      ),
    ).toBe(
      'Оплатите тариф: пока оплата не пройдёт, новые задачи не принимаются. 25 октября 2026 тариф закончится, если оплата не пройдёт раньше. Карту для следующих списаний можно заменить.',
    )
    // The Moscow day of the moment, not the UTC one.
    expect(
      plain(
        pastDueText({
          canPay: true,
          autoRenewal: true,
          endsAt: new Date('2026-10-25T21:30:00Z'),
          canReplaceCard: true,
          tasksTaken: false,
        }),
      ),
    ).toContain('26 октября 2026 тариф закончится')
    expect(creditsWhileOverdue({ gift: 0, pack: 0 }, 0)).toBe('Недоступны, пока тариф не оплачен')
    expect(creditsWhileOverdue({ gift: 0, pack: 3 }, 0)).toBe(
      'Недоступны, пока тариф не оплачен. После оплаты — новые кредиты по тарифу и 3 из пакета',
    )
    expect(creditsWhileOverdue({ gift: 0, pack: 1200 }, 0)).toBe(
      'Недоступны, пока тариф не оплачен. После оплаты — новые кредиты по тарифу и 1 200 из пакета',
    )
    expect(plain(pastDuePaymentTerms(true, '4900.00', true))).toContain(
      'каждый месяц будем списывать 4 900 ₽ тем же способом',
    )
    expect(pastDuePaymentTerms(false, '4900.00', true)).not.toMatch(/\d/)
    expect(renewalWhileOverdue(true, true)).toMatch(/^Включено\./)
    expect(renewalWhileOverdue(false, true)).toMatch(/^Отключено\./)
    expect(renewalOffWhileOverdue()).toMatch(/^Автопродление отключено:/)
  })

  it('promises nothing a shop that takes one-time payments only cannot do', () => {
    // In place of the consent at checkout, and of «Включить автопродление» on the page.
    expect(checkoutWithoutRenewal()).toBe(
      'Автопродление пока недоступно: тариф будет действовать месяц, потом его можно оформить снова.',
    )
    expect(renewalUnavailable()).toBe(
      'Автопродление пока недоступно: когда тариф закончится, его можно оформить снова.',
    )
    // A payment by hand saves no method. With auto-renewal on, the method saved before is the
    // one that goes on being charged; with it off the words are the same as at any shop.
    expect(plain(pastDuePaymentTerms(true, '4900.00', false))).toBe(
      'Способ оплаты, которым вы заплатите сейчас, мы не сохраним. Автопродление включено: каждый месяц будем списывать 4 900 ₽ способом оплаты, сохранённым раньше. Перед списанием пришлём письмо. Отключить можно в настройках в любой день.',
    )
    expect(pastDuePaymentTerms(false, '4900.00', false)).toBe(
      pastDuePaymentTerms(false, '4900.00', true),
    )
    expect(renewalWhileOverdue(true, false)).toBe(
      'Включено. Способ оплаты, которым вы оплатите тариф, не сохранится: дальше тариф будет продлеваться со способа оплаты, сохранённого раньше. Перед каждым списанием пришлём письмо.',
    )
    expect(renewalWhileOverdue(false, false)).toBe(renewalWhileOverdue(false, true))
    for (const text of [
      pastDuePaymentTerms(true, '4900.00', false),
      renewalWhileOverdue(true, false),
    ]) {
      expect(text).not.toMatch(/сохраним способ оплаты, которым|сохранится, и дальше/i)
    }
    // «Оплата» offers no replacement of the card there, so the alert does not name one.
    expect(
      pastDueText({
        canPay: true,
        autoRenewal: true,
        endsAt: null,
        canReplaceCard: false,
        tasksTaken: false,
      }),
    ).toBe('Оплатите тариф: пока оплата не пройдёт, новые задачи не принимаются.')
  })

  it('says why the last tariff is over and what is kept', () => {
    expect(endedText({ reason: 'not_renewed', packCredits: 0, tasksTaken: false })).toBe(
      'Новые задачи сейчас не принимаются. Сайты и история правок на месте.',
    )
    expect(endedText({ reason: 'not_paid', packCredits: 2, tasksTaken: false })).toBe(
      'Оплата за следующий период не прошла, и тариф закончился. Новые задачи сейчас не принимаются. 2 кредита из пакета, сайты и история правок на месте.',
    )
    expect(endedText({ reason: 'refunded', packCredits: 0, tasksTaken: false })).toBe(
      'Мы вернули оплату за этот тариф, и он закончился. Новые задачи сейчас не принимаются. Сайты и история правок на месте.',
    )
    // What to do next is said by the page around the block, once: not by this sentence too.
    for (const reason of ['not_renewed', 'not_paid', 'refunded'] as const) {
      expect(endedText({ reason, packCredits: 3, tasksTaken: false })).not.toMatch(/Выберите/)
    }
  })

  it('never offers replacing the card as a way to settle a charge that failed', () => {
    // Nothing is charged again after a card is replaced: only the payment by hand counts.
    for (const autoRenewal of [true, false]) {
      for (const canPay of [true, false]) {
        const text = pastDueText({
          canPay,
          autoRenewal,
          endsAt: periodEnd,
          canReplaceCard: true,
          tasksTaken: false,
        })
        expect(text).not.toMatch(/или замените|замените карту/)
        expect(text).toMatch(/^(Оплатите тариф|Оплата сейчас недоступна): /)
      }
    }
    // The card is named only as what it is — the one the coming periods are charged to —, so
    // not while auto-renewal is off or nothing can be paid for.
    const card = 'Карту для следующих списаний можно заменить.'
    expect(
      pastDueText({
        canPay: true,
        autoRenewal: true,
        endsAt: null,
        canReplaceCard: true,
        tasksTaken: false,
      }),
    ).toBe(`Оплатите тариф: пока оплата не пройдёт, новые задачи не принимаются. ${card}`)
    expect(
      pastDueText({
        canPay: true,
        autoRenewal: false,
        endsAt: periodEnd,
        canReplaceCard: true,
        tasksTaken: false,
      }),
    ).not.toContain(card)
    expect(
      pastDueText({
        canPay: false,
        autoRenewal: true,
        endsAt: periodEnd,
        canReplaceCard: true,
        tasksTaken: false,
      }),
    ).not.toContain(card)
  })

  it('never names a day of a charge while one is under way', () => {
    const day = /18.октября/
    for (const charge of ['at_bank', 'unanswered'] as const) {
      for (const text of [
        chargeUnderWayValue(charge),
        renewsWithChargeUnderWay(charge, 'anna@example.ru'),
        endsUnlessCharged(charge),
        resumedText(charge),
        consentRenewalNotice({
          planName: 'Бизнес',
          nextPlanName: 'Агентство',
          amount: '39900.00',
          chargeAt: periodEnd,
          renewalCharge: charge,
          oneTimeOnly: true,
        }),
        consentRenewalOff('Бизнес', periodEnd, charge),
      ]) {
        expect(text).not.toMatch(day)
        expect(text).toMatch(/в банк/)
      }
      // What is switched on is every charge after the one the paragraph above tells of.
      expect(
        resumeTerms({ periodEnd, plan: agency, changes: true, methodLabel: MIR, charge }),
      ).not.toMatch(day)
    }
  })

  it('never speaks of receipts, VAT or the customer on «ты», and names no English word but the shop', () => {
    const texts = [
      resumedText('none'),
      resumedText('at_bank'),
      resumeTerms({ periodEnd, plan: agency, changes: false, methodLabel: null, charge: 'none' }),
      ...cancelRenewalWarning({
        planName: 'Бизнес',
        periodEnd,
        left: { tariff: 45, gift: 0, pack: 10 },
        pastDue: true,
        nextPlanName: 'Агентство',
        charge: 'none',
        oneTimeOnly: true,
      }),
      planChangeTerms({ currentName: 'Бизнес', periodEnd, replacedName: 'Старт' }),
      planChangeCharge({ periodEnd, price: '1.00', autoRenewal: false, methodLabel: null }).value,
      pastDueText({
        canPay: false,
        autoRenewal: false,
        endsAt: periodEnd,
        canReplaceCard: true,
        tasksTaken: false,
      }),
      pastDueText({
        canPay: true,
        autoRenewal: true,
        endsAt: periodEnd,
        canReplaceCard: true,
        tasksTaken: false,
      }),
      pastDuePaymentTerms(true, '4900.00', true),
      pastDuePaymentTerms(true, '4900.00', false),
      pastDuePaymentTerms(false, '4900.00', true),
      renewalWhileOverdue(true, true),
      renewalWhileOverdue(true, false),
      renewalWhileOverdue(false, true),
      renewalOffWhileOverdue(),
      renewalUnavailable(),
      checkoutWithoutRenewal(),
      endedText({ reason: 'refunded', packCredits: 5, tasksTaken: false }),
      consentRenewalNotice({
        planName: 'Бизнес',
        nextPlanName: null,
        amount: '12900.00',
        chargeAt: periodEnd,
        renewalCharge: 'none',
        oneTimeOnly: true,
      }),
      consentRenewalOff('Бизнес', periodEnd, 'none'),
    ]
    for (const text of texts) {
      expect(text.replaceAll('ЮKassa', '')).not.toMatch(/[A-Za-z]|НДС|чек/i)
      expect(text).not.toMatch(/(?:^|[^а-яё])(?:ты|тебя|тебе|твой|твоя|твоё|твои)(?:[^а-яё]|$)/i)
      expect(text).toMatch(/[.!?]$/)
    }
  })
})

describe('billing sources', () => {
  it('write a non-breaking space as an entity or through nbsp(), never as the invisible character', () => {
    const here = fileURLToPath(new URL('.', import.meta.url))
    const invisible = String.fromCharCode(0xa0)
    const files = readdirSync(here).filter((name) => /\.tsx?$/.test(name))

    expect(files.length).toBeGreaterThan(8)
    expect(
      files.filter((name) => readFileSync(`${here}${name}`, 'utf8').includes(invisible)),
    ).toEqual([])
  })

  // The unit is the credit. «Правка» is the change on the site itself, and these pages name it
  // in three places only: the history of the changes, the undo of one in «Использование», and
  // the small change — the example of the rule of the tariffs, and what the gift credits are
  // said to be enough for («на семь небольших правок»).
  it('count credits, and say «правка» only of the change on the site', () => {
    const here = fileURLToPath(new URL('.', import.meta.url))
    const sources = readdirSync(here).filter(
      (name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name),
    )
    const theChange =
      /история правок|Отмена правки|небольш(?:ая правка|ую правку|ие правки|их правок)/g
    const counted = sources.flatMap((name) =>
      readFileSync(`${here}${name}`, 'utf8')
        .split('\n')
        .filter((line) => /правк|правок/i.test(line.replace(theChange, '')))
        .map((line) => `${name}: ${line.trim()}`),
    )

    expect(sources.length).toBeGreaterThan(8)
    expect(counted).toEqual([])
    // And the three phrases are still there: the check above reads the files it means to.
    const all = sources.map((name) => readFileSync(`${here}${name}`, 'utf8')).join('\n')
    expect(all).toContain('история правок')
    expect(all).toContain('Отмена правки')
    expect(all).toContain('небольшая правка текста')
    expect(all).toContain('небольших правок')
  })
})

describe('the documents of the web app', () => {
  // DESIGN.md and PRODUCT.md describe the landing's demo at length, and there «правка» is the
  // change on the site. A count of it — «число правок», «счётчик правок», «5 правок» — is the
  // old name of the unit: what a tariff grants and a counter shows is credits.
  it('count credits, and say «правка» only of the change on the site', () => {
    const app = fileURLToPath(new URL('../../../', import.meta.url))
    const design = readFileSync(`${app}DESIGN.md`, 'utf8')
    const product = readFileSync(`${app}PRODUCT.md`, 'utf8')
    // The history of the changes keeps its name wherever a document comes to describe it.
    const theChange = /истори[а-яё]+ правок/gi
    const counted = Object.entries({ 'DESIGN.md': design, 'PRODUCT.md': product }).flatMap(
      ([name, text]) =>
        (text.replace(theChange, '').match(/[^.;\n]*(?:правок|\d\s*правк)[^.;\n]*/gi) ?? []).map(
          (sentence) => `${name}: ${sentence.trim()}`,
        ),
    )

    expect(counted).toEqual([])
    // And the check reads the files it means to: both name the unit, and the change is still
    // «правка» where the demo is described.
    expect(design).toMatch(/остаток кредитов/)
    expect(product).toMatch(/остат[а-яё]* кредитов/)
    expect(design).toContain('Отменить правку')
  })

  // The slider of the landing counts tasks, and the calculator turns them into credits itself:
  // the figure above the slider is a count of tasks, the small line under the sum a price of
  // one task. «Число кредитов» and «цена одного кредита» are that figure and that line as they
  // were while the slider counted the unit; a count of credits the pages do show is named for
  // what it is — «остаток кредитов», the limits of a tariff.
  it('call the figure of the landing`s slider a count of tasks, in every place that names it', () => {
    const app = fileURLToPath(new URL('../../../', import.meta.url))
    const design = readFileSync(`${app}DESIGN.md`, 'utf8')
    const product = readFileSync(`${app}PRODUCT.md`, 'utf8')
    const ofCredits = Object.entries({ 'DESIGN.md': design, 'PRODUCT.md': product }).flatMap(
      ([name, text]) =>
        (text.match(/[^.;|\n]*(?:число кредитов|цен[аыу] одного кредита)[^.;|\n]*/gi) ?? []).map(
          (sentence) => `${name}: ${sentence.trim()}`,
        ),
    )

    expect(ofCredits).toEqual([])
    // And the check reads the file it means to: the figure and the line are still described.
    expect(design).toMatch(/число задач над ползунком/)
    expect(design).toMatch(/цена одной задачи/)
  })
})
