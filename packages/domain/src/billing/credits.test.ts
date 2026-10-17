import { Decimal } from 'decimal.js'
import { describe, expect, it } from 'vitest'
import { Money } from '../money.ts'
import {
  attemptStepCredits,
  availableCredits,
  creditAccountKinds,
  creditAccountSnapshot,
  creditAccountSnapshotSchema,
  creditAccountsSchema,
  creditAccountUnits,
  creditsSchema,
  dailyTariffCredits,
  emptyCreditAccount,
  expiringTariffCredits,
  maxTaskAttempts,
  minContinueCredits,
  minStartCredits,
  minTaskChargeCredits,
  returnedTariffCreditsExpire,
  signupGiftCredits,
  spendableCredits,
  splitReserve,
  tariffDayRoom,
  tariffHoldCreatedAt,
  toCredits,
  trialUnpaidWorkCredits,
  type CreditAccounts,
  type CreditAccountSnapshot,
  type CreditAmountValue,
  type Credits,
} from './credits.ts'
import { subscriptionAllowsTasks, subscriptionStatuses } from './subscription.ts'

// A snapshot as a test writes it, valid or not: the rules check it themselves.
const account = (balance: number, held = 0) => ({ balance, held }) as CreditAccountSnapshot
/** The three accounts of a workspace; the gift is empty unless given. */
const allAccounts = (
  tariff: CreditAccountSnapshot,
  pack: CreditAccountSnapshot,
  gift: CreditAccountSnapshot = account(0),
): CreditAccounts => ({ tariff, gift, pack })
const badRequest = expect.objectContaining({ name: 'DomainError', code: 'BAD_REQUEST' })
/** A reserve of one credit on a paid tariff: the parts `splitReserve` gives it. */
const oneCredit = (accounts: CreditAccounts) =>
  splitReserve({ accounts, amount: toCredits(1), tariffTakesTasks: true })

describe('credit accounts', () => {
  it('maps the tariff, the gift and the pack to their database units', () => {
    expect(creditAccountUnits).toEqual({
      tariff: 'credit_tariff',
      gift: 'credit_gift',
      pack: 'credit_pack',
    })
    expect(Object.isFrozen(creditAccountUnits)).toBe(true)
  })

  it('names the accounts in the order credits are spent and locked in', () => {
    // What expires soonest goes first; what was given goes before what was paid for.
    expect(creditAccountKinds).toEqual(['tariff', 'gift', 'pack'])
    expect(Object.keys(creditAccountUnits)).toEqual([...creditAccountKinds])
    expect(Object.keys(creditAccountsSchema.shape)).toEqual([...creditAccountKinds])
  })

  it('offers an empty account for a row that does not exist yet', () => {
    expect(emptyCreditAccount).toEqual({ balance: 0, held: 0 })
    expect(Object.isFrozen(emptyCreditAccount)).toBe(true)
    expect(availableCredits(allAccounts(emptyCreditAccount, emptyCreditAccount)).total).toBe(0)
  })

  it('keeps the empty account read-only for the compiler too', () => {
    expect(() => {
      // @ts-expect-error a hold is counted on a copy: the shared empty account is frozen
      emptyCreditAccount.held = toCredits(1)
    }).toThrow(TypeError)
    expect(emptyCreditAccount).toEqual({ balance: 0, held: 0 })
    const copy: CreditAccountSnapshot = { ...emptyCreditAccount }
    copy.balance = toCredits(copy.balance + 1)
    expect(oneCredit(allAccounts(copy, emptyCreditAccount))).toEqual([
      { account: 'tariff', amount: 1 },
    ])
  })
})

describe('creditAccountSnapshot', () => {
  it.each<[string, CreditAmountValue, CreditAmountValue, CreditAccountSnapshot]>([
    ['decimal strings of the column', '30.00', '2.00', account(30, 2)],
    ['whole strings', '250', '0', account(250, 0)],
    ['numbers', 80, 80, account(80, 80)],
    ['Decimal objects', new Decimal('30.00'), new Decimal('1'), account(30, 1)],
    ['Decimal objects of another constructor', new Money('10'), new Money('0.00'), account(10)],
    [
      'any object that prints a decimal',
      { toFixed: () => '7.00' },
      { toFixed: () => '7' },
      account(7, 7),
    ],
    ['the largest Decimal(14,2) whole value', '999999999999.00', '0.00', account(999_999_999_999)],
    ['a zero with a sign', '-0.00', '0.00', account(0, 0)],
  ])('reads %s', (_name, balance, held, expected) => {
    expect(creditAccountSnapshot({ balance, held })).toEqual(expected)
  })

  it('returns plain non-negative zeros', () => {
    const snapshot = creditAccountSnapshot({ balance: '-0.00', held: -0 })
    expect(Object.is(snapshot.balance, 0)).toBe(true)
    expect(Object.is(snapshot.held, 0)).toBe(true)
  })

  it.each<[string, unknown, unknown]>([
    ['a fractional balance (a RUB wallet)', '1500.50', '0.00'],
    ['a fractional hold', '30.00', '0.01'],
    ['a fractional number', 0.5, 0],
    ['a fraction beyond the digits of a number', '30.00000000000000000001', '0'],
    ['such a fraction of a hold', '30', new Money('1.00000000000000000001')],
    ['a negative balance', '-1.00', '0.00'],
    ['a negative hold', '30.00', '-1.00'],
    ['held above balance', '1.00', '2.00'],
    ['a thirteenth integer digit', '1000000000000.00', '0.00'],
    ['NaN', Number.NaN, 0],
    ['infinity', Number.POSITIVE_INFINITY, 0],
    ['text', 'thirty', '0'],
    ['an empty string', '', '0'],
    ['a comma', '30,00', '0'],
    // notations decimal.js reads and the database never prints
    ['a hexadecimal string', '0x1F', '0'],
    ['a binary string', '0b11', '0'],
    ['an octal string', '0o17', '0'],
    ['an exponent', '1e3', '0'],
    ['a digit separator', '3_0', '0'],
    ['a leading plus', '+30', '0'],
    ['a point without a fraction', '30.', '0'],
    ['a point without an integer part', '.0', '0'],
    ['a space around the digits', ' 30', '0'],
    ['a line break after the digits', '30\n', '0'],
    ['the word Infinity', 'Infinity', '0'],
    ['a BigInt', 30n, 0],
    ['a hexadecimal hold', '30', '0x1'],
    ['an object that prints an exponent', { toFixed: () => '3e1' }, 0],
    ['null', null, 0],
    ['undefined', undefined, 0],
    ['a boolean', true, 0],
    ['an object that prints text', { toFixed: () => 'many' }, 0],
    ['an object without toFixed', {}, 0],
  ])('refuses %s', (_name, balance, held) => {
    const row = { balance, held } as { balance: CreditAmountValue; held: CreditAmountValue }
    expect(() => creditAccountSnapshot(row)).toThrow(badRequest)
  })
})

describe('a count of credits', () => {
  it.each<[string, CreditAmountValue, number]>([
    ['a number', 45, 45],
    ['zero', 0, 0],
    ['a zero with a sign', -0, 0],
    ['the amount of a hold as the column prints it', '45.00', 45],
    ['a whole string', '300', 300],
    ['a Decimal of the database client', new Decimal('17.00'), 17],
    ['a Decimal of money', new Money('5'), 5],
    ['any object that prints a decimal', { toFixed: () => '12.00' }, 12],
    ['a total of three full accounts', 2_999_999_999_997, 2_999_999_999_997],
    ['the largest whole number that is safe', Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
  ])('reads %s', (_name, value, expected) => {
    const credits = toCredits(value)
    expect(credits).toBe(expected)
    expect(Object.is(credits, -0)).toBe(false)
  })

  it.each<[string, unknown]>([
    ['a fraction', 4.5],
    ['a fraction of the column', '16.90'],
    ['a fraction as a Decimal', new Money('16.895')],
    // too small a fraction for a number to keep: 45 would be read
    ['a fraction beyond the digits of a number', '45.00000000000000000001'],
    ['such a fraction as a Decimal', new Money('45.00000000000000000001')],
    ['a negative number', -1],
    ['a negative amount of a ledger row', '-17.00'],
    ['NaN', Number.NaN],
    ['infinity', Number.POSITIVE_INFINITY],
    ['a number too large to be exact', 2 ** 53],
    ['digits too many to be exact', '9007199254740993'],
    ['an exponent', '1e3'],
    ['a hexadecimal string', '0x2D'],
    ['a leading plus', '+45'],
    ['a comma', '45,00'],
    ['a space', ' 45'],
    ['an empty string', ''],
    ['text', 'forty-five'],
    ['a BigInt', 45n],
    ['a boolean', true],
    ['an object that prints text', { toFixed: () => 'many' }],
    ['an object without toFixed', {}],
    ['null', null],
    ['nothing', undefined],
  ])('refuses %s', (_name, value) => {
    expect(() => toCredits(value as CreditAmountValue)).toThrow(badRequest)
  })

  it('has a schema for what is already a number: whole, not negative, exact', () => {
    for (const ok of [0, 5, 45, 2_999_999_999_997, Number.MAX_SAFE_INTEGER]) {
      expect(creditsSchema.parse(ok)).toBe(ok)
    }
    for (const bad of [-1, 4.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, '45', null]) {
      expect(creditsSchema.safeParse(bad).success).toBe(false)
    }
  })

  it('is a type of its own: a plain number does not pass for the credits of a customer', () => {
    const counted: Credits = toCredits(45)
    // a count of credits is read as a number wherever one is expected
    const plain: number = counted
    expect(plain + 1).toBe(46)
    // @ts-expect-error the credits of a provider, tokens and roubles are plain numbers
    const mistaken: Credits = plain
    expect(mistaken).toBe(45)
    // the fields of a snapshot and what is free on an account are counts of credits
    const snapshot = creditAccountSnapshot({ balance: '300.00', held: '45.00' })
    const balance: Credits = snapshot.balance
    const free: Credits = availableCredits(allAccounts(snapshot, account(0))).tariff
    expect([balance, free]).toEqual([300, 255])
  })
})

describe('the numbers of the model that no text prints', () => {
  it('asks one credit of a continuation and five of a new task', () => {
    expect(minContinueCredits).toBe(1)
    expect(minStartCredits).toBe(5)
    expect(minContinueCredits).toBeLessThan(minStartCredits)
  })

  it('gives a task three attempts', () => {
    expect(maxTaskAttempts).toBe(3)
  })

  it('bounds the unpaid work of a workspace without a tariff at twice the gift', () => {
    expect(trialUnpaidWorkCredits).toBe(70)
    expect(trialUnpaidWorkCredits).toBe(2 * signupGiftCredits)
  })

  // 45 + 120 + 120 credits: a new task, and two retries in the stronger mode.
  it('lets one task reserve 285 credits at most over its attempts', () => {
    const { standard, heavy } = attemptStepCredits
    expect(standard + (maxTaskAttempts - 1) * heavy).toBe(285)
    expect(minTaskChargeCredits).toBeLessThanOrEqual(attemptStepCredits.light)
  })
})

describe('spendableCredits', () => {
  const accounts = allAccounts(account(300, 45), account(100, 20), account(35, 5))

  it('counts what is free on all three accounts while the tariff is paid', () => {
    expect(spendableCredits(accounts, true)).toEqual({
      tariff: 255,
      gift: 30,
      pack: 80,
      total: 365,
    })
    expect(spendableCredits(accounts, true)).toEqual(availableCredits(accounts))
  })

  it('counts the gift alone while it is not: tariff and pack credits wait for a tariff', () => {
    expect(spendableCredits(accounts, false)).toEqual({ tariff: 0, gift: 30, pack: 0, total: 30 })
    // what is free is not what can be spent
    expect(availableCredits(accounts).total).toBe(365)
  })

  it.each([
    ['nothing anywhere', account(0), account(0), account(0), 0, 0],
    ['a gift alone', account(0), account(0), account(35), 35, 35],
    ['a held-out gift', account(300), account(100), account(35, 35), 400, 0],
    ['a pack that waits for a tariff', account(0), account(40), account(3), 43, 3],
    ['everything held', account(45, 45), account(45, 45), account(35, 35), 0, 0],
  ])('%s', (_name, tariff, pack, gift, paid, unpaid) => {
    const all = allAccounts(tariff, pack, gift)
    expect(spendableCredits(all, true).total).toBe(paid)
    expect(spendableCredits(all, false).total).toBe(unpaid)
  })

  describe('within the tariff day', () => {
    const room = (credits: number) => toCredits(credits)

    it('takes tariff credits no further than is left of the day', () => {
      expect(spendableCredits(accounts, true, room(5))).toEqual({
        tariff: 5,
        gift: 30,
        pack: 80,
        total: 115,
      })
      expect(spendableCredits(accounts, true, room(0))).toEqual({
        tariff: 0,
        gift: 30,
        pack: 80,
        total: 110,
      })
    })

    it('takes what is free on the tariff when the day leaves more', () => {
      expect(spendableCredits(accounts, true, room(255))).toEqual(availableCredits(accounts))
      expect(spendableCredits(accounts, true, room(1000))).toEqual(availableCredits(accounts))
    })

    it('counts as before when the day sets no limit', () => {
      expect(spendableCredits(accounts, true, null)).toEqual(spendableCredits(accounts, true))
      expect(spendableCredits(accounts, false, null)).toEqual(spendableCredits(accounts, false))
    })

    it('asks nothing of the day while the tariff is not paid: gift and pack are outside it', () => {
      for (const credits of [0, 5, 1000]) {
        expect(spendableCredits(accounts, false, room(credits))).toEqual({
          tariff: 0,
          gift: 30,
          pack: 0,
          total: 30,
        })
      }
    })

    it('refuses a room that is not a count of credits', () => {
      for (const bad of [-1, 4.5, '5', Number.NaN, 1_000_000_000_000]) {
        expect(() => spendableCredits(accounts, true, bad as Credits)).toThrow(badRequest)
      }
    })
  })

  it('does not change its input', () => {
    spendableCredits(accounts, false)
    spendableCredits(accounts, true, toCredits(3))
    expect(accounts).toEqual(allAccounts(account(300, 45), account(100, 20), account(35, 5)))
  })

  it('refuses accounts that are not valid and a tariff that is neither paid nor not', () => {
    const bad = allAccounts(account(1, 2), account(0))
    expect(() => spendableCredits(bad, true)).toThrow(badRequest)
    expect(() => spendableCredits(bad, false)).toThrow(badRequest)
    for (const state of ['active', 1, null, undefined]) {
      expect(() => spendableCredits(accounts, state as unknown as boolean)).toThrow(badRequest)
    }
  })
})

describe('tariffDayRoom', () => {
  const room = (limit: number | null, used: number) =>
    tariffDayRoom({ limit: limit === null ? null : toCredits(limit), used: toCredits(used) })

  it.each([
    ['a whole day', 50, 0, 50],
    ['a reserve of 45 placed', 50, 45, 5],
    ['the day taken to the credit', 50, 50, 0],
    ['after a renewal onto a smaller plan: more taken than the new limit', 50, 100, 0],
    ['«Бизнес»', 100, 47, 53],
    ['«Агентство»', 300, 0, 300],
  ] as const)('%s: %i a day, %i taken → %i', (_name, limit, used, expected) => {
    expect(room(limit, used)).toBe(expected)
  })

  it('is null when the day sets no limit, however much it has taken', () => {
    for (const used of [0, 45, 5000]) expect(room(null, used)).toBeNull()
  })

  it.each<[string, unknown]>([
    ['a limit of nothing', { limit: 0, used: 0 }],
    ['a negative limit', { limit: -5, used: 0 }],
    ['a fraction of a limit', { limit: 50.5, used: 0 }],
    ['a limit as a string', { limit: '50', used: 0 }],
    ['taken below zero', { limit: 50, used: -1 }],
    ['a fraction taken', { limit: 50, used: 4.5 }],
    ['nothing said of what was taken', { limit: 50 }],
    ['nothing said of the limit', { used: 0 }],
    ['an unknown field', { limit: 50, used: 0, held: 0 }],
    ['not a day at all', null],
  ])('refuses %s', (_name, day) => {
    expect(() => tariffDayRoom(day as Parameters<typeof tariffDayRoom>[0])).toThrow(badRequest)
  })
})

describe('dailyTariffCredits', () => {
  it('is the daily limit of the plan while the tariff is paid', () => {
    expect(dailyTariffCredits({ status: 'active', creditsPerDay: 50 })).toBe(50)
    expect(dailyTariffCredits({ status: 'active', creditsPerDay: null })).toBeNull()
  })

  it('is null without a live subscription and while the tariff is not paid', () => {
    expect(dailyTariffCredits(null)).toBeNull()
    for (const status of subscriptionStatuses) {
      expect([status, dailyTariffCredits({ status, creditsPerDay: 100 })]).toEqual([
        status,
        subscriptionAllowsTasks(status) ? 100 : null,
      ])
    }
  })

  it('reads the terms of a subscription that carries more than them', () => {
    const subscription = { status: 'active' as const, creditsPerDay: 300, creditsPerMonth: 2500 }
    expect(dailyTariffCredits(subscription)).toBe(300)
  })

  it.each<[string, unknown]>([
    ['a limit of nothing', { status: 'active', creditsPerDay: 0 }],
    ['a fraction of a limit', { status: 'active', creditsPerDay: 49.5 }],
    ['a limit as a string', { status: 'active', creditsPerDay: '50' }],
    ['no word on the limit', { status: 'active' }],
    ['a status that is not one', { status: 'paid', creditsPerDay: 50 }],
    ['an overdue tariff with a broken limit', { status: 'past_due', creditsPerDay: -1 }],
    ['no subscription said at all', undefined],
  ])('refuses %s', (_name, subscription) => {
    expect(() =>
      dailyTariffCredits(subscription as Parameters<typeof dailyTariffCredits>[0]),
    ).toThrow(badRequest)
  })
})

describe('availableCredits', () => {
  it.each([
    ['both accounts empty', account(0), account(0), { tariff: 0, pack: 0, total: 0 }],
    ['a fresh tariff', account(30), account(0), { tariff: 30, pack: 0, total: 30 }],
    ['a pack without a tariff', account(0), account(10), { tariff: 0, pack: 10, total: 10 }],
    ['both accounts', account(30), account(10), { tariff: 30, pack: 10, total: 40 }],
    ['holds on the tariff', account(30, 2), account(10), { tariff: 28, pack: 10, total: 38 }],
    ['holds on both', account(30, 2), account(10, 3), { tariff: 28, pack: 7, total: 35 }],
    ['a held-out tariff', account(5, 5), account(10), { tariff: 0, pack: 10, total: 10 }],
    ['a held-out pack', account(5), account(10, 10), { tariff: 5, pack: 0, total: 5 }],
    ['both held out', account(5, 5), account(10, 10), { tariff: 0, pack: 0, total: 0 }],
    [
      'the largest accounts',
      account(999_999_999_999),
      account(999_999_999_999),
      {
        tariff: 999_999_999_999,
        pack: 999_999_999_999,
        total: 1_999_999_999_998,
      },
    ],
  ])('without a gift: %s', (_name, tariff, pack, expected) => {
    expect(availableCredits(allAccounts(tariff, pack))).toEqual({ ...expected, gift: 0 })
  })

  it.each([
    ['a gift alone', account(0), account(35), account(0), { tariff: 0, gift: 35, pack: 0 }, 35],
    [
      'a gift next to a tariff and a pack',
      account(300),
      account(35),
      account(100),
      { tariff: 300, gift: 35, pack: 100 },
      435,
    ],
    [
      'holds on the three',
      account(300, 45),
      account(35, 5),
      account(100, 20),
      { tariff: 255, gift: 30, pack: 80 },
      365,
    ],
    [
      'a held-out gift',
      account(300),
      account(35, 35),
      account(100),
      { tariff: 300, gift: 0, pack: 100 },
      400,
    ],
    [
      'the largest accounts',
      account(999_999_999_999),
      account(999_999_999_999),
      account(999_999_999_999),
      { tariff: 999_999_999_999, gift: 999_999_999_999, pack: 999_999_999_999 },
      2_999_999_999_997,
    ],
  ])('with a gift: %s', (_name, tariff, gift, pack, each, total) => {
    expect(availableCredits(allAccounts(tariff, pack, gift))).toEqual({ ...each, total })
  })

  it('does not change its input', () => {
    const input = allAccounts(account(30, 2), account(10, 3), account(35, 1))
    availableCredits(input)
    expect(input).toEqual(allAccounts(account(30, 2), account(10, 3), account(35, 1)))
  })
})

// The account a reserve starts on, asked of `splitReserve` for one credit: the tariff while it
// has a free credit, then the pack — the order one credit per task was always reserved in.
describe('the account one credit is reserved on', () => {
  it.each([
    ['empty accounts', account(0), account(0), null],
    ['only tariff credits', account(30), account(0), 'tariff'],
    ['only pack credits', account(0), account(10), 'pack'],
    ['both: the tariff goes first', account(30), account(10), 'tariff'],
    ['the last tariff credit', account(30, 29), account(10), 'tariff'],
    ['a held-out tariff and a pack', account(30, 30), account(10), 'pack'],
    ['a held-out tariff and the last pack credit', account(30, 30), account(10, 9), 'pack'],
    ['a held-out tariff and no pack', account(30, 30), account(0), null],
    ['no tariff and a held-out pack', account(0), account(10, 10), null],
    ['both held out', account(30, 30), account(10, 10), null],
    ['a tariff with one credit and a held-out pack', account(1), account(10, 10), 'tariff'],
  ] as const)('%s → %s', (_name, tariff, pack, expected) => {
    const accounts = allAccounts(tariff, pack)
    // Nothing free on either account: there is nothing to reserve, and the reserve is refused.
    if (expected === null) expect(() => oneCredit(accounts)).toThrow(badRequest)
    else expect(oneCredit(accounts)).toEqual([{ account: expected, amount: 1 }])
  })

  it('spends the tariff down to its last credit before it touches the pack', () => {
    const tariff = account(3)
    const pack = account(2)
    const order: (string | null)[] = []
    for (let hold = 0; hold < 6; hold++) {
      const free = availableCredits(allAccounts(tariff, pack)).total > 0
      const kind = free ? (oneCredit(allAccounts(tariff, pack))[0]?.account ?? null) : null
      order.push(kind)
      if (kind === 'tariff') tariff.held = toCredits(tariff.held + 1)
      if (kind === 'pack') pack.held = toCredits(pack.held + 1)
    }
    expect(order).toEqual(['tariff', 'tariff', 'tariff', 'pack', 'pack', null])
    expect(availableCredits(allAccounts(tariff, pack)).total).toBe(0)
  })

  it('names an account whose unit a hold can copy', () => {
    const [part] = oneCredit(allAccounts(account(0), account(1)))
    expect(part && creditAccountUnits[part.account]).toBe('credit_pack')
  })

  // A reserve is asked of the three accounts together: the gift stands between the tariff and
  // the pack, and a gift nobody looked at is never read as empty.
  it('reserves a gift credit after the tariff and before the pack', () => {
    const gift = account(35)
    expect(oneCredit(allAccounts(account(0), account(0), gift))).toEqual([
      { account: 'gift', amount: 1 },
    ])
    expect(oneCredit(allAccounts(account(30), account(10), gift))).toEqual([
      { account: 'tariff', amount: 1 },
    ])
    expect(oneCredit(allAccounts(account(30, 30), account(10), gift))).toEqual([
      { account: 'gift', amount: 1 },
    ])
    expect(oneCredit(allAccounts(account(30, 30), account(10), account(35, 35)))).toEqual([
      { account: 'pack', amount: 1 },
    ])
    expect(() => oneCredit(allAccounts(account(30, 30), account(10, 10), account(35, 35)))).toThrow(
      badRequest,
    )
  })
})

describe('expiringTariffCredits', () => {
  it.each([
    ['an untouched quota', account(30), 30],
    ['a partly spent quota', account(12), 12],
    ['credits under a hold stay', account(12, 2), 10],
    ['everything left is held', account(3, 3), 0],
    ['an empty account', account(0), 0],
  ])('%s', (_name, tariff, expected) => {
    expect(expiringTariffCredits(tariff)).toBe(expected)
  })

  it('leaves exactly the held credits on the account', () => {
    for (const tariff of [account(30, 2), account(3, 3), account(80), account(0)]) {
      const left = tariff.balance - expiringTariffCredits(tariff)
      expect(left).toBe(tariff.held)
      // The remaining row still satisfies held <= balance.
      expect(creditAccountSnapshotSchema.safeParse(account(left, tariff.held)).success).toBe(true)
    }
  })

  it('equals what availableCredits reports for the tariff and never counts the gift or the pack', () => {
    const tariff = account(30, 4)
    const all = allAccounts(tariff, account(10, 1), account(35, 2))
    expect(expiringTariffCredits(tariff)).toBe(availableCredits(all).tariff)
  })
})

describe('credit account validation', () => {
  const invalid: readonly (readonly [string, unknown])[] = [
    ['a fractional balance', { balance: 1.5, held: 0 }],
    ['a fractional hold', { balance: 2, held: 0.5 }],
    ['a negative balance', { balance: -1, held: 0 }],
    ['a negative hold', { balance: 1, held: -1 }],
    ['held above balance', { balance: 1, held: 2 }],
    ['NaN', { balance: Number.NaN, held: 0 }],
    ['infinity', { balance: Number.POSITIVE_INFINITY, held: 0 }],
    ['more than Decimal(14,2) holds', { balance: 1_000_000_000_000, held: 0 }],
    ['a decimal string', { balance: '30.00', held: '0.00' }],
    ['a Decimal object', { balance: new Money(30), held: new Money(0) }],
    ['a missing field', { balance: 30 }],
    ['an unknown field', { balance: 30, held: 0, unit: 'rub' }],
    ['null', null],
  ]

  it.each(invalid)('refuses %s as an account', (_name, value) => {
    const bad = value as CreditAccountSnapshot
    expect(creditAccountSnapshotSchema.safeParse(bad).success).toBe(false)
    expect(() => expiringTariffCredits(bad)).toThrow(badRequest)
    expect(() => availableCredits(allAccounts(bad, account(1)))).toThrow(badRequest)
    expect(() => availableCredits(allAccounts(account(1), bad))).toThrow(badRequest)
    expect(() => availableCredits(allAccounts(account(1), account(1), bad))).toThrow(badRequest)
    expect(() => oneCredit(allAccounts(bad, account(1)))).toThrow(badRequest)
    expect(() => oneCredit(allAccounts(account(1), bad))).toThrow(badRequest)
    expect(() => oneCredit(allAccounts(account(1), account(1), bad))).toThrow(badRequest)
  })

  it('refuses the accounts without one of the three or with a fourth one', () => {
    const three = allAccounts(account(1), account(1), account(1))
    const { gift: _gift, ...withoutGift } = three
    const { pack: _pack, ...withoutPack } = three
    const onlyTariff = { tariff: account(1) } as CreditAccounts
    const withWallet = { ...three, rub: account(1) } as CreditAccounts
    for (const bad of [
      onlyTariff,
      withoutGift as CreditAccounts,
      withoutPack as CreditAccounts,
      withWallet,
      null as unknown as CreditAccounts,
    ]) {
      expect(creditAccountsSchema.safeParse(bad).success).toBe(false)
      expect(() => availableCredits(bad)).toThrow(badRequest)
    }
    expect(creditAccountsSchema.parse(three)).toEqual(three)
  })

  it('refuses to reserve on accounts without one of the three or with a fourth one', () => {
    const three = allAccounts(account(1), account(1), account(1))
    const { gift: _gift, ...pair } = three
    const onlyTariff = { tariff: account(1) } as CreditAccounts
    const withWallet = { ...three, rub: account(1) } as CreditAccounts
    for (const bad of [
      pair as CreditAccounts,
      onlyTariff,
      withWallet,
      null as unknown as CreditAccounts,
    ]) {
      expect(() => oneCredit(bad)).toThrow(badRequest)
    }
    expect(oneCredit(three)).toEqual([{ account: 'tariff', amount: 1 }])
  })

  it('accepts the boundaries: zero, held equal to balance, the largest value', () => {
    for (const ok of [account(0), account(7, 7), account(999_999_999_999, 999_999_999_999)]) {
      expect(creditAccountSnapshotSchema.parse(ok)).toEqual(ok)
    }
  })
})

describe('returnedTariffCreditsExpire', () => {
  const periodStart = new Date('2026-10-18T09:00:00.000Z')
  const at = (offsetMs: number) => new Date(periodStart.getTime() + offsetMs)
  const DAY_MS = 24 * 60 * 60 * 1000

  it.each([
    ['a hold of the current period', 'active', DAY_MS, false],
    ['a hold placed at the very start of the period', 'active', 0, false],
    ['a hold placed a millisecond before the period', 'active', -1, true],
    ['a hold of the previous period', 'active', -DAY_MS, true],
    ['a hold of a period long gone', 'active', -400 * DAY_MS, true],
    // the charge was refused: the period is over, and a payment starts a new one with its quota
    ['a past_due subscription, a hold of its period', 'past_due', DAY_MS, true],
    ['a past_due subscription, an older hold', 'past_due', -DAY_MS, true],
    // not used yet: no tasks are taken, so nothing comes back either
    ['a trial', 'trial', DAY_MS, true],
    // an ended subscription is not live; the caller passes null, and a row passed by mistake
    // answers the same
    ['a cancelled subscription', 'cancelled', DAY_MS, true],
    ['an expired subscription', 'expired', DAY_MS, true],
  ] as const)('%s → %s', (_name, status, offsetMs, expected) => {
    const subscription = { status, currentPeriodStart: periodStart }
    expect(returnedTariffCreditsExpire(at(offsetMs), subscription)).toBe(expected)
  })

  it('expires the credit when the workspace has no live subscription any more', () => {
    expect(returnedTariffCreditsExpire(at(DAY_MS), null)).toBe(true)
    expect(returnedTariffCreditsExpire(at(-DAY_MS), null)).toBe(true)
  })

  it('returns a credit only where a new task could reserve it again', () => {
    for (const status of subscriptionStatuses) {
      const returns = !returnedTariffCreditsExpire(at(1), {
        status,
        currentPeriodStart: periodStart,
      })
      expect(returns).toBe(subscriptionAllowsTasks(status))
    }
  })

  it('does not change its input', () => {
    const createdAt = at(-1)
    const subscription = { status: 'active', currentPeriodStart: new Date(periodStart) } as const
    returnedTariffCreditsExpire(createdAt, subscription)
    expect(createdAt).toEqual(at(-1))
    expect(subscription.currentPeriodStart).toEqual(periodStart)
  })

  it('refuses a moment that is not one', () => {
    const subscription = { status: 'active', currentPeriodStart: periodStart } as const
    expect(() => returnedTariffCreditsExpire(new Date('invalid'), subscription)).toThrow(badRequest)
    expect(() => returnedTariffCreditsExpire(new Date('invalid'), null)).toThrow(badRequest)
    expect(() =>
      returnedTariffCreditsExpire('2026-10-18' as unknown as Date, subscription),
    ).toThrow(badRequest)
    expect(() =>
      returnedTariffCreditsExpire(at(0), {
        status: 'active',
        currentPeriodStart: new Date(Number.NaN),
      }),
    ).toThrow(badRequest)
  })
})

describe('tariffHoldCreatedAt', () => {
  const start = new Date('2026-09-18T09:00:00.000Z')
  const end = new Date('2026-10-18T09:00:00.000Z')
  const period = { currentPeriodStart: start, currentPeriodEnd: end }
  const MINUTE_MS = 60 * 1000
  const HOUR_MS = 60 * MINUTE_MS
  const inside = new Date('2026-10-04T12:00:00.000Z')
  const lastMoment = new Date(end.getTime() - 1)
  const after = (offsetMs: number) => new Date(end.getTime() + offsetMs)

  it.each([
    ['a moment inside the period', inside, inside],
    ['the start of the period', start, start],
    ['the last millisecond of the period', lastMoment, lastMoment],
    // the clock that queues the task is behind the clock that started the period
    ['two seconds before the period', new Date(start.getTime() - 2000), start],
    ['a moment long before the period', new Date('2025-01-01T00:00:00.000Z'), start],
    // the period is over and its renewal is not settled yet: a credit of the period that ended
    ['the end of the period', end, lastMoment],
    ['two minutes after the period', after(2 * MINUTE_MS), lastMoment],
    ['twelve hours after the period', after(12 * HOUR_MS), lastMoment],
  ])('stamps a hold placed at %s', (_name, placedAt, expected) => {
    expect(tariffHoldCreatedAt(placedAt, period).toISOString()).toBe(expected.toISOString())
  })

  it('stamps a hold so that its credit returns into its period and expires in the next one', () => {
    const placements = [
      new Date(start.getTime() - 2000),
      start,
      inside,
      lastMoment,
      end,
      after(2 * MINUTE_MS),
      after(12 * HOUR_MS),
    ]
    for (const placedAt of placements) {
      const createdAt = tariffHoldCreatedAt(placedAt, period)
      // The subscription still stands in the period the credit was taken from.
      expect(
        returnedTariffCreditsExpire(createdAt, { status: 'active', currentPeriodStart: start }),
      ).toBe(false)
      // The renewal moved it to the period that starts where this one ended.
      expect(
        returnedTariffCreditsExpire(createdAt, { status: 'active', currentPeriodStart: end }),
      ).toBe(true)
    }
  })

  it('keeps the moment of a hold placed after the renewal moved the period', () => {
    const renewed = { currentPeriodStart: end, currentPeriodEnd: new Date('2026-11-18T09:00:00Z') }
    const createdAt = tariffHoldCreatedAt(after(2 * MINUTE_MS), renewed)
    expect(createdAt).toEqual(after(2 * MINUTE_MS))
    expect(
      returnedTariffCreditsExpire(createdAt, { status: 'active', currentPeriodStart: end }),
    ).toBe(false)
  })

  it('returns a new moment and does not change its input', () => {
    const placedAt = after(MINUTE_MS)
    const input = { currentPeriodStart: new Date(start), currentPeriodEnd: new Date(end) }
    expect(tariffHoldCreatedAt(start, input)).not.toBe(input.currentPeriodStart)
    tariffHoldCreatedAt(placedAt, input)
    expect(placedAt).toEqual(after(MINUTE_MS))
    expect(input).toEqual(period)
  })

  it('refuses a moment that is not one and a period that does not run forward', () => {
    const never = new Date(Number.NaN)
    expect(() => tariffHoldCreatedAt(never, period)).toThrow(badRequest)
    expect(() => tariffHoldCreatedAt('2026-10-04' as unknown as Date, period)).toThrow(badRequest)
    expect(() => tariffHoldCreatedAt(start, { ...period, currentPeriodStart: never })).toThrow(
      badRequest,
    )
    expect(() => tariffHoldCreatedAt(start, { ...period, currentPeriodEnd: never })).toThrow(
      badRequest,
    )
    for (const currentPeriodEnd of [start, new Date(start.getTime() - 1)]) {
      expect(() => tariffHoldCreatedAt(start, { ...period, currentPeriodEnd })).toThrow(badRequest)
    }
  })
})
