import { describe, expect, it } from 'vitest'
import { Money } from '../money.ts'
import {
  minContinueCredits,
  minStartCredits,
  newTaskVerdict,
  taskPlacements,
  trialUnpaidWorkCredits,
  unpaidWork,
  toCredits,
  type CreditAccountKind,
  type CreditAccounts,
  type CreditAccountSnapshot,
  type Credits,
  type NewTaskInput,
  type TariffCreditsToday,
  type TaskPlacement,
} from './credits.ts'
import { taskRefusal, taskRefusalCodes, taskRefusalReasons } from './errors.ts'
import { subscriptionStatuses, type SubscriptionStatus } from './subscription.ts'

// Whether a task is taken, and why not. The cases are those of the texts the customer reads
// before a task starts; the numbers are the defaults of the model — 5 credits to start, 1 to
// continue, 50 tariff credits a day on «Старт» and 70 credits of unpaid work without a tariff.

const badRequest = expect.objectContaining({ name: 'DomainError', code: 'BAD_REQUEST' })

// A snapshot as a test writes it, valid or not: the rules check it themselves.
const account = (balance: number, held = 0) => ({ balance, held }) as CreditAccountSnapshot
const three = (
  tariff: CreditAccountSnapshot,
  gift: CreditAccountSnapshot,
  pack: CreditAccountSnapshot,
): CreditAccounts => ({ tariff, gift, pack })
const empty = account(0)

/** «Старт»: 300 credits a month, of them at most 50 a day. */
const start = { creditsPerMonth: 300, creditsPerDay: 50 }
const tariff = (
  status: SubscriptionStatus = 'active',
  plan: { creditsPerMonth: number; creditsPerDay: number | null } = start,
) => ({ status, ...plan })
const credits = (value: string) => new Money(value)
/** What the tariff gave the Moscow day so far: charged and still set aside. */
const day = (charged = 0, held = 0) => ({ charged, held }) as TariffCreditsToday

/** A paid «Старт» with everything in place; a case changes what it is about. */
const ask = (change: Partial<NewTaskInput> = {}) =>
  newTaskVerdict({
    placement: 'new',
    accounts: three(account(300), account(35), account(100)),
    subscription: tariff(),
    tariffCreditsToday: day(),
    unpaidWork: credits('0'),
    rateUsable: true,
    ...change,
  })
/** The same for a workspace that has no tariff: the gift alone. */
const askWithoutTariff = (change: Partial<NewTaskInput> = {}) =>
  ask({ accounts: three(empty, account(35), empty), subscription: null, ...change })

/** What the active reserve rows of the task that asks hold, by account; written like `account`. */
const own = (onTariff = 0, onGift = 0, onPack = 0) =>
  ({ tariff: onTariff, gift: onGift, pack: onPack }) as Record<CreditAccountKind, Credits>
/**
 * «Продолжить» on the paid «Старт»: the first attempt of the task holds a step of 45 tariff
 * credits, nothing else is held.
 */
const continuing = {
  placement: 'continuation',
  accounts: three(account(300, 45), account(35), account(100)),
  heldByTask: own(45),
} satisfies Partial<NewTaskInput>
const askToContinue = (change: Partial<NewTaskInput> = {}) => ask({ ...continuing, ...change })
/** «Продолжить» without a tariff: the first attempt holds 20 of the 35 gift credits. */
const askToContinueWithoutTariff = (change: Partial<NewTaskInput> = {}) =>
  askToContinue({
    accounts: three(empty, account(35, 20), empty),
    heldByTask: own(0, 20),
    subscription: null,
    ...change,
  })

// The answer by its numbers of the accounts: `spendableNow` when a case gives it, the day of a
// tariff in the block that counts it.
type Numbers = { spendable: number; held: number; needed: number; spendableNow?: number }
const answer = (
  verdict: { allowed: boolean; reason: string | null },
  { spendable, held, needed, spendableNow }: Numbers,
) =>
  expect.objectContaining({
    ...verdict,
    spendable,
    held,
    needed,
    ...(spendableNow === undefined ? {} : { spendableNow }),
  }) as Record<string, unknown>
const allowed = (spendable: number, held = 0, needed = 5, spendableNow?: number) =>
  answer({ allowed: true, reason: null }, { spendable, held, needed, spendableNow })
const refused = (reason: string, spendable: number, held = 0, needed = 5, spendableNow?: number) =>
  answer({ allowed: false, reason }, { spendable, held, needed, spendableNow })
/** The day of a paid tariff as the answer tells it. */
const today = (
  limit: number | null,
  charged: number,
  held: number,
  room: number | null,
  left: number,
) => ({ limit, charged, held, used: charged + held, room, left })

describe('newTaskVerdict', () => {
  describe('takes a task', () => {
    it.each<[string, Partial<NewTaskInput>, ReturnType<typeof allowed>]>([
      ['on a paid tariff with all three accounts', {}, allowed(435)],
      ['on tariff credits alone', { accounts: three(account(300), empty, empty) }, allowed(300)],
      [
        'on a pack when the tariff credits are used up',
        { accounts: three(empty, empty, account(100)) },
        allowed(100),
      ],
      [
        'on exactly the credits a task needs to start',
        { accounts: three(account(2), account(2), account(1)) },
        allowed(5),
      ],
      [
        'while other tasks hold credits and enough is free',
        { accounts: three(account(300, 45), account(35, 35), account(100, 90)) },
        allowed(265, 170),
      ],
      [
        'on the last five tariff credits of the day',
        { accounts: three(account(300), empty, empty), tariffCreditsToday: day(45) },
        allowed(300, 0, 5, 5),
      ],
      [
        'on gift and pack credits when the day took every tariff credit',
        { tariffCreditsToday: day(50) },
        allowed(435, 0, 5, 135),
      ],
      [
        'on a plan without a daily limit, whatever the day took',
        {
          subscription: tariff('active', { creditsPerMonth: 300, creditsPerDay: null }),
          tariffCreditsToday: day(500),
        },
        allowed(435, 0, 5, 435),
      ],
      ['a credit under the bound on unpaid work', { unpaidWork: credits('299.99') }, allowed(435)],
      [
        'on the gift without a tariff',
        { accounts: three(empty, account(35), empty), subscription: null },
        allowed(35),
      ],
      [
        'on a gift of exactly five credits',
        { accounts: three(empty, account(5), empty), subscription: null },
        allowed(5),
      ],
      [
        'on the gift without a tariff, whatever the day took: there is no day then',
        {
          accounts: three(empty, account(35), empty),
          subscription: null,
          tariffCreditsToday: day(500, 500),
        },
        allowed(35, 0, 5, 35),
      ],
      [
        'a credit under the bound of the trial',
        {
          accounts: three(empty, account(35), empty),
          subscription: null,
          unpaidWork: credits('69.99'),
        },
        allowed(35),
      ],
      // an overdue or ended tariff does not stop a task the gift can carry
      [
        'on the gift while the tariff is overdue',
        {
          accounts: three(account(300), account(35), account(100)),
          subscription: tariff('past_due'),
        },
        allowed(35),
      ],
      [
        'on the gift after the tariff ended, a pack waiting',
        { accounts: three(empty, account(35), account(40)), subscription: null },
        allowed(35),
      ],
      [
        'for a site whose gift was spent elsewhere, when the tariff is paid',
        { giftSiteClaimedElsewhere: true },
        allowed(435),
      ],
    ])('%s', (_name, change, expected) => {
      expect(ask(change)).toEqual(expected)
    })
  })

  // One case for each text the customer may read in place of «Приняли».
  describe('refuses a task', () => {
    it.each<[string, Partial<NewTaskInput>, ReturnType<typeof refused>]>([
      [
        'no tariff and the gift is spent',
        { accounts: three(empty, empty, empty), subscription: null },
        refused('gift_spent', 0),
      ],
      [
        'no tariff and three gift credits are left',
        { accounts: three(empty, account(3), empty), subscription: null },
        refused('gift_below_start', 3),
      ],
      [
        'no tariff, credits left, and the trial reached its bound on unpaid work',
        {
          accounts: three(empty, account(15), empty),
          subscription: null,
          unpaidWork: credits('70'),
        },
        refused('trial_unpaid_limit', 15),
      ],
      [
        'no tariff and the site spent a gift in another workspace',
        {
          accounts: three(empty, account(35), empty),
          subscription: null,
          giftSiteClaimedElsewhere: true,
        },
        refused('gift_site_used', 35),
      ],
      [
        'a paid tariff and nothing left',
        { accounts: three(empty, empty, empty) },
        refused('empty', 0),
      ],
      [
        'a paid tariff and three credits left',
        { accounts: three(account(1), account(1), account(1)) },
        refused('below_start', 3),
      ],
      [
        'a paid tariff and every credit set aside for tasks in work',
        { accounts: three(account(45, 45), empty, account(45, 45)) },
        refused('held', 0, 90),
      ],
      [
        'no tariff and the gift set aside for the task in work',
        { accounts: three(empty, account(35, 35), empty), subscription: null },
        refused('held', 0, 35),
      ],
      [
        'a paid tariff whose credits of the day are taken, no gift and no pack',
        { accounts: three(account(250), empty, empty), tariffCreditsToday: day(50) },
        refused('daily_limit', 250, 0, 5, 0),
      ],
      [
        'an overdue tariff and a gift that cannot carry the task',
        {
          accounts: three(account(300), account(3), account(100)),
          subscription: tariff('past_due'),
        },
        refused('past_due', 3),
      ],
      [
        'an ended tariff, a pack left and a gift that cannot carry the task',
        { accounts: three(empty, empty, account(40)), subscription: null },
        refused('ended', 0),
      ],
      [
        'a paid tariff whose unpaid work reached its monthly credits',
        { unpaidWork: credits('300') },
        refused('unpaid_limit', 435),
      ],
      ['no usable credit rate', { rateUsable: false }, refused('rate_missing', 435)],
    ])('%s', (_name, change, expected) => {
      expect(ask(change)).toEqual(expected)
    })

    it('has a case for every reason there is', () => {
      const cases: Partial<NewTaskInput>[] = [
        { accounts: three(empty, empty, empty), subscription: null },
        { accounts: three(empty, account(3), empty), subscription: null },
        {
          accounts: three(empty, account(15), empty),
          subscription: null,
          unpaidWork: credits('70'),
        },
        {
          accounts: three(empty, account(35), empty),
          subscription: null,
          giftSiteClaimedElsewhere: true,
        },
        { accounts: three(empty, empty, empty) },
        { accounts: three(account(1), account(1), account(1)) },
        { accounts: three(account(45, 45), empty, account(45, 45)) },
        { accounts: three(account(250), empty, empty), tariffCreditsToday: day(50) },
        { unpaidWork: credits('300') },
        {
          accounts: three(account(300), account(3), account(100)),
          subscription: tariff('past_due'),
        },
        { accounts: three(empty, empty, account(40)), subscription: null },
        { rateUsable: false },
      ]
      expect(cases.map((change) => ask(change).reason)).toEqual([...taskRefusalReasons])
    })
  })

  // When several refusals apply: the credit rate, then credits — the limit a payment lifts —,
  // then the day, then unpaid work, then the gift of the site.
  describe('names the first refusal in one order', () => {
    const noRate = { rateUsable: false }
    const noCredits = { accounts: three(empty, empty, empty) }
    const fewCredits = { accounts: three(account(3), empty, empty) }
    const allHeld = { accounts: three(account(45, 45), empty, empty) }
    // The day took its 50 tariff credits, and no gift or pack is there; a case that is about
    // the accounts as well names them after it.
    const dayUsed = { accounts: three(account(250), empty, empty), tariffCreditsToday: day(50) }
    const unpaidReached = { unpaidWork: credits('300') }
    const siteClaimed = { giftSiteClaimedElsewhere: true }

    it.each<[string, Partial<NewTaskInput>, string]>([
      ['the rate before credits', { ...noRate, ...noCredits }, 'rate_missing'],
      [
        'the rate before everything',
        { ...noRate, ...dayUsed, ...noCredits, ...unpaidReached },
        'rate_missing',
      ],
      ['credits before the day', { ...dayUsed, ...noCredits }, 'empty'],
      ['a few credits before the day', { ...dayUsed, ...fewCredits }, 'below_start'],
      ['held credits before the day', { ...dayUsed, ...allHeld }, 'held'],
      ['credits before unpaid work', { ...noCredits, ...unpaidReached }, 'empty'],
      [
        'credits before the day and unpaid work',
        { ...dayUsed, ...noCredits, ...unpaidReached },
        'empty',
      ],
      ['the day before unpaid work', { ...dayUsed, ...unpaidReached }, 'daily_limit'],
      [
        'the day before everything after it',
        { ...dayUsed, ...unpaidReached, ...siteClaimed },
        'daily_limit',
      ],
      ['unpaid work alone', { ...unpaidReached, ...siteClaimed }, 'unpaid_limit'],
    ])('with a paid tariff: %s', (_name, change, reason) => {
      expect(ask(change).reason).toBe(reason)
    })

    const giftSpent = { accounts: three(empty, empty, empty) }
    const giftShort = { accounts: three(empty, account(4), empty) }
    const giftHeld = { accounts: three(empty, account(35, 35), empty) }
    const trialUnpaid = { unpaidWork: credits('70') }

    it.each<[string, Partial<NewTaskInput>, string]>([
      ['the rate before the gift', { ...noRate, ...giftSpent }, 'rate_missing'],
      ['a short gift first', { ...giftShort, ...trialUnpaid, ...siteClaimed }, 'gift_below_start'],
      ['a held gift first', { ...giftHeld, ...trialUnpaid, ...siteClaimed }, 'held'],
      [
        'a spent gift before everything',
        { ...giftSpent, ...trialUnpaid, ...siteClaimed },
        'gift_spent',
      ],
      [
        'unpaid work before the gift of the site',
        { ...trialUnpaid, ...siteClaimed },
        'trial_unpaid_limit',
      ],
      ['a spent gift before the gift of the site', { ...giftSpent, ...siteClaimed }, 'gift_spent'],
    ])('without a tariff: %s', (_name, change, reason) => {
      expect(askWithoutTariff(change).reason).toBe(reason)
    })

    it('says held before it says how the tariff stands', () => {
      const heldGift = three(account(300), account(35, 35), account(100))
      expect(ask({ accounts: heldGift, subscription: tariff('past_due') }).reason).toBe('held')
      expect(ask({ accounts: heldGift, subscription: null }).reason).toBe('held')
    })

    // Only an overdue tariff is asked to be paid; one that ended, or a trial, is no tariff.
    it.each(['trial', 'cancelled', 'expired'] as const)(
      'reads a subscription that is %s as no tariff at all',
      (status) => {
        const subscription = tariff(status)
        expect(ask({ accounts: three(empty, empty, empty), subscription }).reason).toBe(
          'gift_spent',
        )
        expect(ask({ accounts: three(empty, account(3), empty), subscription }).reason).toBe(
          'gift_below_start',
        )
        expect(ask({ accounts: three(empty, account(3), account(40)), subscription }).reason).toBe(
          'ended',
        )
      },
    )

    it('says an overdue tariff before a pack that waits, and a pack before the gift', () => {
      const withPack = three(empty, account(3), account(40))
      expect(ask({ accounts: withPack, subscription: tariff('past_due') }).reason).toBe('past_due')
      expect(ask({ accounts: withPack, subscription: null }).reason).toBe('ended')
      expect(ask({ accounts: three(empty, account(3), empty), subscription: null }).reason).toBe(
        'gift_below_start',
      )
      // an overdue tariff and a gift that carries the task: the bounds of the trial apply, and
      // the day of its plan does not — tariff credits are not spent then
      const carried = three(account(300), account(35), account(100))
      expect(
        ask({ accounts: carried, subscription: tariff('past_due'), tariffCreditsToday: day(50) }),
      ).toEqual(allowed(35, 0, 5, 35))
      expect(
        ask({ accounts: carried, subscription: tariff('past_due'), unpaidWork: credits('70') })
          .reason,
      ).toBe('trial_unpaid_limit')
    })
  })

  describe('counts what a task may spend', () => {
    it('counts all three accounts while the tariff is paid', () => {
      const accounts = three(account(300, 45), account(35, 5), account(100, 20))
      expect(ask({ accounts })).toEqual(allowed(365, 70))
    })

    it.each(subscriptionStatuses.filter((status) => status !== 'active'))(
      'counts the gift alone while the tariff is %s',
      (status) => {
        const accounts = three(account(300, 45), account(35, 5), account(100, 20))
        expect(ask({ accounts, subscription: tariff(status) })).toEqual(allowed(30, 5))
      },
    )

    it('counts the gift alone without a subscription', () => {
      const accounts = three(account(300, 45), account(35, 5), account(100, 20))
      expect(ask({ accounts, subscription: null })).toEqual(allowed(30, 5))
    })

    it.each([
      // the smallest balance that starts a task is five credits that can be spent
      ['four credits', three(account(4), empty, empty), refused('below_start', 4)],
      ['five credits', three(account(5), empty, empty), allowed(5)],
      ['one credit', three(empty, empty, account(1)), refused('below_start', 1)],
      // held: the accounts hold enough, and tasks in work have it set aside
      [
        'seven credits, four of them held',
        three(account(7, 4), empty, empty),
        refused('held', 3, 4),
      ],
      ['five credits, one of them held', three(account(5, 1), empty, empty), refused('held', 4, 1)],
      ['five credits, all held', three(empty, empty, account(5, 5)), refused('held', 0, 5)],
      // not held: even with everything returned a task could not start
      [
        'four credits, two of them held',
        three(account(4, 2), empty, empty),
        refused('below_start', 2, 2),
      ],
      ['three credits, all held', three(account(3, 3), empty, empty), refused('empty', 0, 3)],
      [
        'held on one account, free on another',
        three(account(45, 45), empty, account(5)),
        allowed(5, 45),
      ],
    ])('with a paid tariff and %s', (_name, accounts, expected) => {
      expect(ask({ accounts })).toEqual(expected)
    })

    it.each([
      ['a gift of four credits', three(empty, account(4), empty), refused('gift_below_start', 4)],
      ['a gift of one credit', three(empty, account(1), empty), refused('gift_below_start', 1)],
      ['a gift of five credits', three(empty, account(5), empty), allowed(5)],
      [
        'a gift of seven, four of them held',
        three(empty, account(7, 4), empty),
        refused('held', 3, 4),
      ],
      [
        'a gift of four, two of them held',
        three(empty, account(4, 2), empty),
        refused('gift_below_start', 2, 2),
      ],
      [
        'a gift of three, all held',
        three(empty, account(3, 3), empty),
        refused('gift_spent', 0, 3),
      ],
      // a pack counts for «ended» only by what waits free on it
      [
        'no gift and a pack all held',
        three(empty, empty, account(40, 40)),
        refused('gift_spent', 0),
      ],
      [
        'no gift and one free pack credit',
        three(empty, empty, account(40, 39)),
        refused('ended', 0),
      ],
      // tariff credits of an ended tariff are not the customer's to spend or to wait for
      [
        'no gift and tariff credits still held',
        three(account(45, 45), empty, empty),
        refused('gift_spent', 0),
      ],
    ])('without a tariff and %s', (_name, accounts, expected) => {
      expect(ask({ accounts, subscription: null })).toEqual(expected)
    })
  })

  // The day caps tariff credits only (decision of 17.10.2026; docs/plan/37-billing-plan.md,
  // «Дневной лимит в кредитах»): what the day has left of them, with the gift and the pack,
  // is what a task may take now.
  describe('counts the tariff credits of the day', () => {
    it('tells the day of a paid tariff beside the accounts', () => {
      expect(ask()).toEqual({
        allowed: true,
        reason: null,
        spendable: 435,
        spendableNow: 185,
        held: 0,
        needed: 5,
        today: today(50, 0, 0, 50, 50),
      })
    })

    // The walk of «Старт» in the decision: 09:00 a standard task set 45 aside, at 09:05 the
    // second one asks while the first is in work.
    it('lets a second task of the day take what the day has left, and the pack', () => {
      const second = ask({
        accounts: three(account(300, 45), empty, account(100)),
        tariffCreditsToday: day(0, 45),
      })
      expect(second).toEqual({
        allowed: true,
        reason: null,
        spendable: 355,
        spendableNow: 105,
        held: 45,
        needed: 5,
        today: today(50, 0, 45, 5, 5),
      })
    })

    it('tells what the tariff can give today: the room, or less when the account has less', () => {
      const fewOnTariff = ask({ accounts: three(account(20), empty, empty) })
      expect(fewOnTariff.today).toEqual(today(50, 0, 0, 50, 20))
      expect(fewOnTariff.spendableNow).toBe(20)
      // credits set aside by a task of an earlier day are not free, and the room is not theirs
      const heldEarlier = ask({
        accounts: three(account(60, 45), empty, empty),
        tariffCreditsToday: day(30),
      })
      expect(heldEarlier.today).toEqual(today(50, 30, 0, 20, 15))
      expect(heldEarlier.spendableNow).toBe(15)
    })

    it.each<[string, Partial<NewTaskInput>, Record<string, unknown>]>([
      // nothing left of the day, 250 tariff credits in the month: wait for tomorrow or buy a pack
      [
        'the day spent, no gift and no pack',
        { accounts: three(account(250), empty, empty), tariffCreditsToday: day(50) },
        refused('daily_limit', 250, 0, 5, 0),
      ],
      [
        'the day spent, a pack bought today',
        { accounts: three(account(250), empty, account(100)), tariffCreditsToday: day(50) },
        allowed(350, 0, 5, 100),
      ],
      [
        'the day spent, the gift left',
        { accounts: three(account(250), account(35), empty), tariffCreditsToday: day(50) },
        allowed(285, 0, 5, 35),
      ],
      // the day need not be used up: three credits of it and one of a pack are four
      [
        'three credits left of the day and one of a pack',
        {
          accounts: three(account(300, 45), empty, account(1)),
          tariffCreditsToday: day(2, 45),
        },
        refused('daily_limit', 256, 45, 5, 4),
      ],
      [
        'four credits left of the day and one of a pack',
        {
          accounts: three(account(300, 45), empty, account(1)),
          tariffCreditsToday: day(1, 45),
        },
        allowed(256, 45, 5, 5),
      ],
      // a renewal onto a smaller plan in the middle of a day: nothing is left of it
      [
        'a day that took more than the plan of now gives',
        { accounts: three(account(800), empty, empty), tariffCreditsToday: day(120) },
        refused('daily_limit', 800, 0, 5, 0),
      ],
    ])('with %s', (_name, change, expected) => {
      expect(ask(change)).toEqual(expected)
    })

    it('counts a day that took more than its limit as one with nothing left', () => {
      const verdict = ask({
        accounts: three(account(800), empty, empty),
        tariffCreditsToday: day(120),
      })
      expect(verdict.today).toEqual(today(50, 120, 0, 0, 0))
    })

    it('reads the limit of the plan the tariff is on', () => {
      const business = tariff('active', { creditsPerMonth: 800, creditsPerDay: 100 })
      const accounts = three(account(800), empty, empty)
      expect(ask({ subscription: business, accounts, tariffCreditsToday: day(95) })).toEqual(
        allowed(800, 0, 5, 5),
      )
      expect(ask({ subscription: business, accounts, tariffCreditsToday: day(96) })).toEqual(
        refused('daily_limit', 800, 0, 5, 4),
      )
    })

    it('has no day on a plan without a daily limit', () => {
      const unlimited = ask({
        subscription: tariff('active', { creditsPerMonth: 300, creditsPerDay: null }),
        accounts: three(account(300, 45), empty, empty),
        tariffCreditsToday: day(400, 45),
      })
      expect(unlimited).toEqual({
        allowed: true,
        reason: null,
        spendable: 255,
        spendableNow: 255,
        held: 45,
        needed: 5,
        today: today(null, 400, 45, null, 255),
      })
    })

    // Tariff credits are not spent without a paid tariff, and gift and pack credits are outside
    // the day: the gift is the bound then.
    it.each(subscriptionStatuses.filter((status) => status !== 'active'))(
      'has no day while the tariff is %s',
      (status) => {
        const verdict = ask({
          accounts: three(account(300), account(35), account(100)),
          subscription: tariff(status),
          tariffCreditsToday: day(500, 500),
        })
        expect(verdict).toEqual({
          allowed: true,
          reason: null,
          spendable: 35,
          spendableNow: 35,
          held: 0,
          needed: 5,
          today: null,
        })
      },
    )

    it('has no day without a subscription, and never refuses by one', () => {
      const verdict = askWithoutTariff({ tariffCreditsToday: day(500, 500) })
      expect(verdict.today).toBeNull()
      expect(verdict.spendableNow).toBe(verdict.spendable)
      // the gift spent in one day: the gift answers, not the day
      expect(
        askWithoutTariff({
          accounts: three(empty, account(35, 35), empty),
          tariffCreditsToday: day(0, 0),
        }).reason,
      ).toBe('held')
      expect(askWithoutTariff({ accounts: three(empty, empty, empty) }).reason).toBe('gift_spent')
    })

    it('says what the accounts lack before it says what the day lacks', () => {
      const dayTaken = { tariffCreditsToday: day(50) }
      // three credits on the tariff: the accounts cannot start a task, whatever the day
      expect(ask({ accounts: three(account(3), empty, empty), ...dayTaken })).toEqual(
        refused('below_start', 3, 0, 5, 0),
      )
      // the tariff credits of the month are set aside: wait for the tasks in work
      expect(ask({ accounts: three(account(45, 45), empty, empty), ...dayTaken })).toEqual(
        refused('held', 0, 45, 5, 0),
      )
      expect(ask({ accounts: three(empty, empty, empty), ...dayTaken }).reason).toBe('empty')
    })

    // «Продолжить» takes tariff credits of the day like a new task: it waits for the next day
    // or a pack at the question it stopped at, never in the middle of a turn.
    it('caps a continuation by the day: it needs one credit of it, or of the gift or a pack', () => {
      const continuation = (
        accounts: CreditAccounts,
        taken: TariffCreditsToday,
      ): ReturnType<typeof askToContinue> =>
        askToContinue({ accounts, heldByTask: own(45), tariffCreditsToday: taken })
      expect(continuation(three(account(300, 45), empty, empty), day(5, 45))).toEqual(
        refused('daily_limit', 255, 0, 1, 0),
      )
      expect(continuation(three(account(300, 45), empty, empty), day(4, 45))).toEqual(
        allowed(255, 0, 1, 1),
      )
      expect(continuation(three(account(300, 45), empty, account(1)), day(5, 45))).toEqual(
        allowed(256, 0, 1, 1),
      )
      // without a tariff a continuation has no day either
      expect(askToContinueWithoutTariff({ tariffCreditsToday: day(500) })).toEqual(
        allowed(15, 0, 1, 15),
      )
    })

    it('caps a retry by the day like a new task', () => {
      const dayTaken = { accounts: three(account(250), empty, empty), tariffCreditsToday: day(50) }
      expect(ask({ placement: 'retry', ...dayTaken })).toEqual(refused('daily_limit', 250, 0, 5, 0))
      expect(ask({ placement: 'new', ...dayTaken })).toEqual(
        ask({ placement: 'retry', ...dayTaken }),
      )
    })

    it('refuses by the day only a paid tariff whose plan has a daily limit', () => {
      const taken = day(5000, 5000)
      for (const status of subscriptionStatuses) {
        for (const creditsPerDay of [50, null]) {
          const verdict = ask({
            accounts: three(account(5000), account(3), account(1)),
            subscription: tariff(status, { creditsPerMonth: 300, creditsPerDay }),
            tariffCreditsToday: taken,
          })
          const dayRefuses = status === 'active' && creditsPerDay !== null
          expect([status, creditsPerDay, verdict.reason === 'daily_limit']).toEqual([
            status,
            creditsPerDay,
            dayRefuses,
          ])
        }
      }
    })

    it('gives a refusal by the day the numbers of the day', () => {
      const verdict = ask({
        accounts: three(account(300, 45), empty, account(1)),
        tariffCreditsToday: day(2, 45),
      })
      if (verdict.allowed) throw new Error('The task was taken')
      const error = taskRefusal(verdict)
      expect(error).toMatchObject({ code: 'BILLING_DAILY_LIMIT_REACHED', httpStatus: 409 })
      expect(error.details).toEqual({
        reason: 'daily_limit',
        spendable: 256,
        held: 45,
        needed: 5,
        spendableNow: 4,
        day: { limit: 50, used: 47 },
      })
    })
  })

  describe('bounds unpaid work', () => {
    it.each([
      ['0', true],
      ['299.9999999999', true],
      ['300', false],
      ['300.0000000001', false],
      ['5000', false],
    ])('%s credits of unpaid work on a tariff of 300 → taken: %s', (unpaid, taken) => {
      expect(ask({ unpaidWork: credits(unpaid) }).allowed).toBe(taken)
      if (!taken) expect(ask({ unpaidWork: credits(unpaid) }).reason).toBe('unpaid_limit')
    })

    it('reads the bound from the monthly credits of the plan', () => {
      const business = tariff('active', { creditsPerMonth: 800, creditsPerDay: 100 })
      expect(ask({ subscription: business, unpaidWork: credits('799.5') }).allowed).toBe(true)
      expect(ask({ subscription: business, unpaidWork: credits('800') }).reason).toBe(
        'unpaid_limit',
      )
    })

    it.each([
      ['0', true],
      ['69.9999999999', true],
      ['70', false],
      ['70.0000000001', false],
      ['299', false],
    ])('%s credits of unpaid work without a tariff → taken: %s', (unpaid, taken) => {
      expect(trialUnpaidWorkCredits).toBe(70)
      expect(askWithoutTariff({ unpaidWork: credits(unpaid) }).allowed).toBe(taken)
      if (!taken) {
        expect(askWithoutTariff({ unpaidWork: credits(unpaid) }).reason).toBe('trial_unpaid_limit')
      }
    })

    it('takes the work as `unpaidWork` counts it: what was charged is not unpaid', () => {
      // 320.5 credits of work in the period, 40 of them charged: 280.5 unpaid, under 300
      const unpaid = unpaidWork({ work: credits('320.5'), charged: toCredits(40) })
      expect(ask({ unpaidWork: unpaid }).allowed).toBe(true)
      // the same work with 20 charged is 300.5
      const more = unpaidWork({ work: credits('320.5'), charged: toCredits(20) })
      expect(ask({ unpaidWork: more }).reason).toBe('unpaid_limit')
    })
  })

  describe('by what asks for the reserve', () => {
    it('knows a new task, a continuation and a retry', () => {
      expect(taskPlacements).toEqual(['new', 'continuation', 'retry'])
    })

    it('asks five credits of a new task and of a retry, one of a continuation', () => {
      expect(minStartCredits).toBe(5)
      expect(minContinueCredits).toBe(1)
      expect(ask({ placement: 'new' }).needed).toBe(5)
      expect(ask({ placement: 'retry' }).needed).toBe(5)
      expect(askToContinue().needed).toBe(1)
      expect(askToContinueWithoutTariff().needed).toBe(1)
    })

    it('continues a task on one credit, and not on none', () => {
      const one = three(empty, empty, account(1))
      expect(ask({ placement: 'new', accounts: one })).toEqual(refused('below_start', 1))
      expect(ask({ placement: 'retry', accounts: one })).toEqual(refused('below_start', 1))

      // the task holds all 45 credits of the tariff; one credit of a pack is free
      const oneFree = three(account(45, 45), empty, account(1))
      expect(askToContinue({ accounts: oneFree })).toEqual(allowed(1, 0, 1))
      // and with nothing free the credits ran out: there is no other task to wait for
      const noneFree = three(account(45, 45), empty, empty)
      expect(askToContinue({ accounts: noneFree })).toEqual(refused('empty', 0, 0, 1))
    })

    it('continues on one gift credit without a tariff, and not on none', () => {
      // the task holds 34 of the 35 gift credits, then all of them
      const continuation = (held: number) =>
        askToContinueWithoutTariff({
          accounts: three(empty, account(35, held), empty),
          heldByTask: own(0, held),
        })
      expect(continuation(34)).toEqual(allowed(1, 0, 1))
      expect(continuation(35)).toEqual(refused('gift_spent', 0, 0, 1))
    })

    // The customer whose credits ran out in the middle of a task is not told to wait for the
    // tasks in work: the one task that holds his credits is the task that waits for him.
    it('does not take the reserve of the task itself for tasks in work', () => {
      // «Старт», 45 tariff credits left, all set aside by the first attempt of the task
      const itsOwn = askToContinue({ accounts: three(account(45, 45), empty, empty) })
      expect(itsOwn).toEqual(refused('empty', 0, 0, 1))
      if (itsOwn.allowed) throw new Error('The task was taken')
      expect(taskRefusal(itsOwn)).toMatchObject({ code: 'BILLING_NOT_ENOUGH_CREDITS' })

      // the same, and another task holds 45 credits of a pack: those are worth waiting for
      const another = askToContinue({ accounts: three(account(45, 45), empty, account(45, 45)) })
      expect(another).toEqual(refused('held', 0, 45, 1))
      if (another.allowed) throw new Error('The task was taken')
      const error = taskRefusal(another)
      expect(error).toMatchObject({ code: 'BILLING_CREDITS_HELD' })
      expect(error.details).toEqual({ reason: 'held', spendable: 0, held: 45, needed: 1 })

      // no tariff: the gift is set aside by the task itself
      const gift = askToContinueWithoutTariff({
        accounts: three(empty, account(35, 35), empty),
        heldByTask: own(0, 35),
      })
      expect(gift).toEqual(refused('gift_spent', 0, 0, 1))
      if (gift.allowed) throw new Error('The task was taken')
      expect(taskRefusal(gift)).toMatchObject({ code: 'BILLING_TASK_NEEDS_SUBSCRIPTION' })

      // a new task in the same workspace has no reserve: every held credit is another task's
      expect(ask({ accounts: three(account(45, 45), empty, empty) })).toEqual(
        refused('held', 0, 45),
      )
      expect(
        askWithoutTariff({ placement: 'retry', accounts: three(empty, account(35, 35), empty) }),
      ).toEqual(refused('held', 0, 35))
    })

    it.each<
      [string, CreditAccounts, ReturnType<typeof own>, ReturnType<typeof allowed | typeof refused>]
    >([
      // the whole reserve of the task, on each account and on all three: nothing to wait for
      [
        'its reserve on the tariff',
        three(account(45, 45), empty, empty),
        own(45),
        refused('empty', 0, 0, 1),
      ],
      [
        'its reserve on the gift',
        three(empty, account(35, 35), empty),
        own(0, 35),
        refused('empty', 0, 0, 1),
      ],
      [
        'its reserve on the pack',
        three(empty, empty, account(40, 40)),
        own(0, 0, 40),
        refused('empty', 0, 0, 1),
      ],
      [
        'its reserve on all three accounts',
        three(account(5, 5), account(35, 35), account(5, 5)),
        own(5, 35, 5),
        refused('empty', 0, 0, 1),
      ],
      // what other tasks hold, account by account: that is what `held` counts
      [
        'another task on the tariff',
        three(account(90, 90), empty, empty),
        own(45),
        refused('held', 0, 45, 1),
      ],
      [
        'another task on the gift',
        three(account(45, 45), account(35, 35), empty),
        own(45),
        refused('held', 0, 35, 1),
      ],
      [
        'another task on the pack',
        three(account(45, 45), empty, account(45, 45)),
        own(45),
        refused('held', 0, 45, 1),
      ],
      [
        'one credit of another task beside its own',
        three(account(46, 46), empty, empty),
        own(45),
        refused('held', 0, 1, 1),
      ],
      [
        'other tasks on every account beside its own',
        three(account(50, 50), account(35, 35), account(60, 60)),
        own(45, 5, 20),
        refused('held', 0, 75, 1),
      ],
      // taken: the numbers still leave its own reserve out
      [
        'free credits beside its own and the reserves of others',
        three(account(300, 90), account(35, 5), account(100, 20)),
        own(45, 5),
        allowed(320, 65, 1),
      ],
      // the smallest reserve there is makes it a continuation
      ['a reserve of one credit', three(account(300, 1), empty, empty), own(1), allowed(299, 0, 1)],
    ])('continues on a paid tariff with %s', (_name, accounts, heldByTask, expected) => {
      expect(askToContinue({ accounts, heldByTask })).toEqual(expected)
    })

    it.each<
      [string, CreditAccounts, ReturnType<typeof own>, ReturnType<typeof allowed | typeof refused>]
    >([
      [
        'the gift held by the task and by another',
        three(empty, account(35, 35), empty),
        own(0, 20),
        refused('held', 0, 15, 1),
      ],
      [
        'the gift held by the task alone, some of it free',
        three(empty, account(35, 20), empty),
        own(0, 20),
        allowed(15, 0, 1),
      ],
      // the tariff ended under the task: its rows there are neither spendable nor waited for
      [
        'its reserve on the tariff that ended',
        three(account(45, 45), empty, empty),
        own(45),
        refused('gift_spent', 0, 0, 1),
      ],
      [
        'its reserve on the tariff that ended, another task on the gift',
        three(account(45, 45), account(5, 5), empty),
        own(45),
        refused('held', 0, 5, 1),
      ],
      [
        'its reserve on the tariff that ended, a pack waiting',
        three(account(45, 45), empty, account(40)),
        own(45),
        refused('ended', 0, 0, 1),
      ],
      [
        'its reserve on the pack of a tariff that ended',
        three(empty, empty, account(40, 40)),
        own(0, 0, 40),
        refused('gift_spent', 0, 0, 1),
      ],
      [
        'its reserve on the tariff and the pack, the gift free',
        three(account(5, 5), account(35), account(40, 40)),
        own(5, 0, 40),
        allowed(35, 0, 1),
      ],
    ])('continues without a tariff with %s', (_name, accounts, heldByTask, expected) => {
      expect(askToContinueWithoutTariff({ accounts, heldByTask })).toEqual(expected)
    })

    it('tells a continuation that its overdue tariff is to be paid, not to wait', () => {
      const overdue = askToContinue({
        accounts: three(account(45, 45), empty, account(100)),
        subscription: tariff('past_due'),
      })
      expect(overdue).toEqual(refused('past_due', 0, 0, 1))
    })

    it('leaves a new task and a retry as they were when their reserve is given as nothing', () => {
      const accounts = three(account(7, 4), account(35, 35), account(100, 90))
      for (const placement of ['new', 'retry'] as const) {
        const asked = ask({ placement, accounts })
        expect(asked).toEqual(allowed(13, 129))
        expect(ask({ placement, accounts, heldByTask: own() })).toEqual(asked)
        expect(ask({ placement, accounts, heldByTask: undefined })).toEqual(asked)
      }
    })

    // The work is in progress and will be charged if it is done.
    it('never refuses a continuation by unpaid work', () => {
      const busy = { unpaidWork: credits('5000') }
      expect(askToContinue(busy)).toEqual(allowed(390, 0, 1, 185))
      expect(askToContinueWithoutTariff(busy)).toEqual(allowed(15, 0, 1))
      expect(ask({ placement: 'new', ...busy }).reason).toBe('unpaid_limit')
      expect(ask({ placement: 'retry', ...busy }).reason).toBe('unpaid_limit')
      expect(askWithoutTariff({ placement: 'retry', ...busy }).reason).toBe('trial_unpaid_limit')
    })

    it('refuses a retry by unpaid work, like a new task', () => {
      expect(ask({ placement: 'retry', unpaidWork: credits('300') }).reason).toBe('unpaid_limit')
      expect(askWithoutTariff({ placement: 'retry', unpaidWork: credits('70') }).reason).toBe(
        'trial_unpaid_limit',
      )
    })

    // Each kind of placement as it comes: a continuation with the reserve of its task.
    const askAs = (placement: TaskPlacement, change: Partial<NewTaskInput>) =>
      placement === 'continuation' ? askToContinue(change) : ask({ placement, ...change })
    const askWithoutTariffAs = (placement: TaskPlacement, change: Partial<NewTaskInput>) =>
      placement === 'continuation'
        ? askToContinueWithoutTariff(change)
        : askWithoutTariff({ placement, ...change })

    it('refuses every placement without a usable rate', () => {
      for (const placement of taskPlacements) {
        expect(askAs(placement, { rateUsable: false }).reason).toBe('rate_missing')
        expect(askWithoutTariffAs(placement, { rateUsable: false }).reason).toBe('rate_missing')
      }
    })

    it('refuses every placement on gift credits of a site whose gift was spent elsewhere', () => {
      for (const placement of taskPlacements) {
        const claimed = askWithoutTariffAs(placement, { giftSiteClaimedElsewhere: true })
        expect(claimed.reason).toBe('gift_site_used')
        expect(askAs(placement, { giftSiteClaimedElsewhere: true }).allowed).toBe(true)
      }
    })

    // The accounts do not say whose rows hold them, and a guess would be the wrong text: a
    // continuation is the placement of a task that has a reserve, and the only one.
    it.each<[string, Partial<NewTaskInput>]>([
      ['a continuation that does not say what its task holds', { placement: 'continuation' }],
      ['a continuation whose task holds nothing', { placement: 'continuation', heldByTask: own() }],
      ['a new task that holds a reserve', { placement: 'new', heldByTask: own(45) }],
      ['a retry that holds a reserve', { placement: 'retry', heldByTask: own(45) }],
      ['a new task that holds a gift credit', { placement: 'new', heldByTask: own(0, 1) }],
      ['a retry that holds a pack credit', { placement: 'retry', heldByTask: own(0, 0, 1) }],
    ])('refuses %s', (_name, change) => {
      // the accounts hold what the task is said to hold, and more
      const accounts = three(account(300, 45), account(35, 1), account(100, 1))
      expect(() => ask({ accounts, ...change })).toThrow(badRequest)
    })

    it.each<[string, CreditAccounts, ReturnType<typeof own>, NewTaskInput['subscription']]>([
      // each beside held credits elsewhere, so that the sum alone would not tell
      ['on the tariff', three(account(300, 40), account(35, 10), account(100)), own(45), tariff()],
      ['on the gift', three(account(300, 45), account(35, 10), account(100)), own(0, 20), tariff()],
      [
        'on the pack',
        three(account(300, 45), account(35), account(100, 10)),
        own(0, 0, 20),
        tariff(),
      ],
      ['by one credit', three(account(300, 44), account(35), account(100)), own(45), tariff()],
      // accounts a task cannot spend without a tariff are checked all the same
      ['on a tariff that ended', three(account(45, 44), account(35, 20), empty), own(45, 20), null],
      [
        'on the pack of a tariff that ended',
        three(empty, account(35, 20), account(40, 39)),
        own(0, 20, 40),
        null,
      ],
    ])(
      'refuses a task said to hold more than its account holds, %s',
      (_name, accounts, heldByTask, subscription) => {
        const continuation = { placement: 'continuation', accounts, subscription } as const
        expect(() => ask({ ...continuation, heldByTask })).toThrow(badRequest)
        // the same accounts with a reserve that fits are answered
        const fits = own(
          Math.min(heldByTask.tariff, accounts.tariff.held),
          Math.min(heldByTask.gift, accounts.gift.held),
          Math.min(heldByTask.pack, accounts.pack.held),
        )
        expect(ask({ ...continuation, heldByTask: fits }).allowed).toBe(true)
      },
    )
  })

  it('leaves the site out when it is not known: a page asks about the workspace', () => {
    expect(askWithoutTariff()).toEqual(allowed(35))
    expect(askWithoutTariff({ giftSiteClaimedElsewhere: undefined })).toEqual(allowed(35))
    expect(askWithoutTariff({ giftSiteClaimedElsewhere: false })).toEqual(allowed(35))
  })

  it('is refused with the code of its reason, the numbers in the details', () => {
    const verdict = ask({ accounts: three(account(45, 45), empty, account(47, 45)) })
    expect(verdict).toEqual(refused('held', 2, 90))
    // the way the queue refuses: the verdict is thrown as it is
    if (verdict.allowed) throw new Error('The task was taken')
    const error = taskRefusal(verdict)
    expect(error).toMatchObject({ code: 'BILLING_CREDITS_HELD', httpStatus: 409 })
    expect(error.details).toEqual({ reason: 'held', spendable: 2, held: 90, needed: 5 })

    for (const reason of taskRefusalReasons) {
      expect(taskRefusal({ ...verdict, reason }).code).toBe(taskRefusalCodes[reason])
    }
  })

  it('answers the same for the same question and does not change it', () => {
    const input: NewTaskInput = {
      placement: 'new',
      accounts: three(account(7, 4), account(0), account(0)),
      subscription: tariff(),
      tariffCreditsToday: day(20, 4),
      unpaidWork: credits('300'),
      rateUsable: true,
    }
    expect(newTaskVerdict(input)).toEqual(newTaskVerdict(input))
    expect(input).toEqual({
      placement: 'new',
      accounts: three(account(7, 4), account(0), account(0)),
      subscription: { status: 'active', creditsPerMonth: 300, creditsPerDay: 50 },
      tariffCreditsToday: { charged: 20, held: 4 },
      unpaidWork: credits('300'),
      rateUsable: true,
    })
  })

  it.each<[string, Record<string, unknown>]>([
    ['a placement that is not one', { placement: 'undo' }],
    ['no placement', { placement: undefined }],
    ['accounts without the gift', { accounts: { tariff: account(300), pack: account(100) } }],
    ['an account that holds more than it has', { accounts: three(account(3, 4), empty, empty) }],
    ['an account of fractions', { accounts: three(account(2.5), empty, empty) }],
    ['a subscription in a status that is not one', { subscription: { ...start, status: 'paid' } }],
    ['a subscription without the terms of its plan', { subscription: { status: 'active' } }],
    ['a plan without monthly credits', { subscription: { ...tariff(), creditsPerMonth: null } }],
    ['a plan of no credits', { subscription: { ...tariff(), creditsPerMonth: 0 } }],
    ['a daily limit of nothing', { subscription: { ...tariff(), creditsPerDay: 0 } }],
    ['a daily limit of a fraction', { subscription: { ...tariff(), creditsPerDay: 2.5 } }],
    ['a daily limit left out', { subscription: { status: 'active', creditsPerMonth: 300 } }],
    [
      'a daily limit of tasks',
      { subscription: { status: 'active', creditsPerMonth: 300, tasksPerDay: 5 } },
    ],
    ['a subscription with a field of its own', { subscription: { ...tariff(), planId: 'start' } }],
    ['no word on the subscription', { subscription: undefined }],
    ['a negative charge of the day', { tariffCreditsToday: { charged: -1, held: 0 } }],
    ['a fraction set aside in the day', { tariffCreditsToday: { charged: 0, held: 2.5 } }],
    ['a day without what is set aside', { tariffCreditsToday: { charged: 0 } }],
    ['a day as a count', { tariffCreditsToday: 5 }],
    ['a day of a field of its own', { tariffCreditsToday: { charged: 0, held: 0, room: 50 } }],
    ['no word on the day', { tariffCreditsToday: undefined }],
    ['launches in place of the day', { tariffCreditsToday: undefined, launchesToday: 0 }],
    ['unpaid work as a number', { unpaidWork: 12.5 }],
    ['unpaid work as a string', { unpaidWork: '12.5' }],
    ['negative unpaid work', { unpaidWork: credits('-1') }],
    ['unpaid work that is not a number', { unpaidWork: new Money(Number.NaN) }],
    ['no unpaid work', { unpaidWork: undefined }],
    ['no word on the rate', { rateUsable: undefined }],
    ['a verdict in place of the word on the rate', { rateUsable: 'usable' }],
    ['a site in place of the word on its gift', { giftSiteClaimedElsewhere: 'example.ru' }],
    // the reserve of the task: each would be answered if it were read loosely
    [
      'a reserve of the task without the gift',
      { ...continuing, heldByTask: { tariff: 45, pack: 0 } },
    ],
    [
      'a reserve of the task in fractions',
      {
        ...continuing,
        accounts: three(account(45, 45), account(35, 20), empty),
        subscription: null,
        heldByTask: { tariff: 44.5, gift: 20, pack: 0 },
      },
    ],
    [
      'a negative reserve of the task',
      {
        ...continuing,
        accounts: three(account(300, 45), account(35), account(100, 50)),
        heldByTask: { tariff: -5, gift: 0, pack: 50 },
      },
    ],
    [
      'a reserve of the task on an account that is not one',
      { ...continuing, heldByTask: { ...own(45), rub: 0 } },
    ],
    ['a count in place of the reserve of the task', { ...continuing, heldByTask: 45 }],
    // a task without a reserve leaves it out; null is not a way to say so
    ['null in place of the reserve of a new task', { heldByTask: null }],
    ['an unknown field', { modelClass: 'standard' }],
  ])('refuses %s', (_name, change) => {
    const input = {
      placement: 'new',
      accounts: three(account(300), account(35), account(100)),
      subscription: tariff(),
      tariffCreditsToday: day(),
      unpaidWork: credits('0'),
      rateUsable: true,
      ...change,
    }
    expect(() => newTaskVerdict(input as unknown as NewTaskInput)).toThrow(badRequest)
  })

  it('refuses what is not a question at all', () => {
    expect(() => newTaskVerdict(null as unknown as NewTaskInput)).toThrow(badRequest)
    expect(() => newTaskVerdict(undefined as unknown as NewTaskInput)).toThrow(badRequest)
  })
})
