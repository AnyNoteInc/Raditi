import { describe, expect, it } from 'vitest'
import {
  attemptReserveCredits,
  attemptStepCredits,
  creditAccountKinds,
  creditAccountsSchema,
  creditsFromCost,
  customerBudgetLeftRub,
  distributeCharge,
  spendableCredits,
  splitReserve,
  taskCharge,
  toCredits,
  type ChargeDistribution,
  type ChargeDistributionInput,
  type CreditAccountKind,
  type CreditAccounts,
  type CreditAccountSnapshot,
  type CreditReserveInput,
  type CreditReserveRow,
  type Credits,
} from './credits.ts'
import { subscriptionStatuses, type SubscriptionStatus } from './subscription.ts'

// The reserve of a task and the charge that settles it. A reserve says that the task is funded;
// which credits pay is decided when the task is charged. The walks and the example of the
// period are those of the model, computed by hand.

const badRequest = expect.objectContaining({ name: 'DomainError', code: 'BAD_REQUEST' })

// A snapshot as a test writes it, valid or not: the rules check it themselves.
const account = (balance: number, held = 0) => ({ balance, held }) as CreditAccountSnapshot
const three = (
  tariff: CreditAccountSnapshot,
  gift: CreditAccountSnapshot,
  pack: CreditAccountSnapshot,
): CreditAccounts => ({ tariff, gift, pack })

const DAY_MS = 24 * 60 * 60 * 1000
/** The current period of the tariff started on the 18th. */
const periodStart = new Date('2026-10-18T09:00:00.000Z')
/** Days from the start of the current period; a negative number is before it. */
const day = (days: number, ms = 0) => new Date(periodStart.getTime() + days * DAY_MS + ms)
type Subscription = ChargeDistributionInput['subscription']
const subscriptionIn = (status: SubscriptionStatus): Subscription => ({
  status,
  currentPeriodStart: periodStart,
})
const paid = subscriptionIn('active')

const row = (
  id: string,
  kind: CreditAccountKind,
  amount: number,
  createdAt = day(1),
): CreditReserveRow => ({ id, account: kind, amount: toCredits(amount), createdAt })

const takesTasks = (subscription: Subscription) => subscription?.status === 'active'
const isEnded = (reserved: CreditReserveRow, subscription: Subscription) =>
  reserved.account === 'tariff' &&
  (!takesTasks(subscription) || reserved.createdAt.getTime() < periodStart.getTime())
const sumOf = (amounts: readonly number[]) => amounts.reduce((sum, amount) => sum + amount, 0)

/** The reserve of a task placed on the accounts: its rows, and the accounts with them held. */
function placed(
  accounts: CreditAccounts,
  task: string,
  amount: Credits,
  tariffTakesTasks = true,
  createdAt = day(1),
) {
  const parts = splitReserve({ accounts, amount, tariffTakesTasks })
  const rows = parts.map((part) =>
    row(`${task}-${part.account}`, part.account, part.amount, createdAt),
  )
  const next = { ...accounts }
  for (const part of parts) {
    const { balance, held } = accounts[part.account]
    next[part.account] = account(balance, held + part.amount)
  }
  return { parts, rows, accounts: next }
}

/**
 * The accounts after a charge is posted the way its distribution says: what an account pays
 * and what its ended rows hold leaves the balance, the rows of the task leave `held`. The
 * result must be three valid accounts: nothing negative, held never above balance.
 */
function settled(
  accounts: CreditAccounts,
  rows: readonly CreditReserveRow[],
  distribution: ChargeDistribution,
): CreditAccounts {
  const endedIds = new Set(distribution.endedRows.map((ended) => ended.id))
  const endedTotal = sumOf(rows.filter(({ id }) => endedIds.has(id)).map(({ amount }) => amount))
  const after = (kind: CreditAccountKind) => {
    const ended = kind === 'tariff' ? endedTotal : 0
    const share = distribution.accounts[kind]
    return account(
      accounts[kind].balance - share.paid - ended,
      accounts[kind].held - share.reserved - ended,
    )
  }
  const result = three(after('tariff'), after('gift'), after('pack'))
  expect(creditAccountsSchema.safeParse(result).success).toBe(true)
  return result
}

const nothing = { paid: 0, reserved: 0 }

describe('attemptReserveCredits', () => {
  it.each([
    ['a new task on a full tariff', 'standard', 300, 45],
    ['a new task with 105 credits on two accounts', 'standard', 105, 45],
    ['a new task with exactly the step', 'standard', 45, 45],
    ['a new task one credit short of the step', 'standard', 44, 44],
    ['a customer with 12 credits', 'standard', 12, 12],
    ['the smallest balance that starts a task', 'standard', 5, 5],
    ['a continuation on the last credit', 'standard', 1, 1],
    ['the whole gift: a step is more than it', 'standard', 35, 35],
    ['a retry in the stronger mode', 'heavy', 300, 120],
    ['a retry with 50 credits', 'heavy', 50, 50],
    ['a light task', 'light', 300, 20],
    ['a light task with 19 credits', 'light', 19, 19],
    ['nothing to spend', 'standard', 0, 0],
  ] as const)('%s: %s, %i spendable → %i', (_name, modelClass, spendable, expected) => {
    expect(attemptReserveCredits(modelClass, toCredits(spendable))).toBe(expected)
  })

  it('is the step of the class, or everything that can be spent', () => {
    for (const modelClass of ['light', 'standard', 'heavy'] as const) {
      const step = attemptStepCredits[modelClass]
      for (const spendable of [0, 1, step - 1, step, step + 1, 10 * step]) {
        expect(attemptReserveCredits(modelClass, toCredits(spendable))).toBe(
          Math.min(step, spendable),
        )
      }
    }
  })

  it('refuses a class that is not one and a count that is not one', () => {
    for (const modelClass of ['service', 'STANDARD', '', 'toString', undefined, null]) {
      const reserve = () => attemptReserveCredits(modelClass as 'standard', toCredits(45))
      expect(reserve).toThrow(badRequest)
      expect(reserve).toThrow('Invalid model class')
    }
    for (const spendable of [-1, 4.5, Number.NaN, Number.POSITIVE_INFINITY, undefined, null]) {
      expect(() => attemptReserveCredits('standard', spendable as Credits)).toThrow(badRequest)
    }
  })
})

describe('splitReserve', () => {
  const split = (accounts: CreditAccounts, amount: number, tariffTakesTasks = true) =>
    splitReserve({ accounts, amount: toCredits(amount), tariffTakesTasks })

  it.each([
    [
      'everything on the tariff',
      three(account(300), account(35), account(100)),
      45,
      [['tariff', 45]],
    ],
    [
      'the last 5 tariff credits and 40 of the pack',
      three(account(5), account(0), account(100)),
      45,
      [
        ['tariff', 5],
        ['pack', 40],
      ],
    ],
    [
      '40 tariff credits and 5 of the pack',
      three(account(40), account(0), account(100)),
      45,
      [
        ['tariff', 40],
        ['pack', 5],
      ],
    ],
    [
      'the tariff is held by another task: all on the pack',
      three(account(40, 40), account(0), account(100, 5)),
      45,
      [['pack', 45]],
    ],
    [
      'three accounts: the gift goes before the pack',
      three(account(10), account(20), account(100)),
      45,
      [
        ['tariff', 10],
        ['gift', 20],
        ['pack', 15],
      ],
    ],
    [
      'the tariff and the gift cover it: the pack is not touched',
      three(account(10), account(35), account(100)),
      45,
      [
        ['tariff', 10],
        ['gift', 35],
      ],
    ],
    [
      'no tariff credits left: the gift, then the pack',
      three(account(0), account(35), account(100)),
      45,
      [
        ['gift', 35],
        ['pack', 10],
      ],
    ],
    [
      'only what is free is taken from an account',
      three(account(40, 38), account(35, 30), account(100, 60)),
      45,
      [
        ['tariff', 2],
        ['gift', 5],
        ['pack', 38],
      ],
    ],
    [
      'a reserve of everything there is',
      three(account(3), account(4), account(5)),
      12,
      [
        ['tariff', 3],
        ['gift', 4],
        ['pack', 5],
      ],
    ],
    ['one credit for a continuation', three(account(0), account(0), account(1)), 1, [['pack', 1]]],
  ] as const)('%s', (_name, accounts, amount, parts) => {
    expect(split(accounts, amount)).toEqual(
      parts.map(([kind, credits]) => ({ account: kind, amount: credits })),
    )
  })

  it('reserves only gift credits while the tariff is not paid', () => {
    // an overdue tariff still has its credits, and a pack waits for a tariff
    const accounts = three(account(50), account(35), account(100))
    expect(split(accounts, 35, false)).toEqual([{ account: 'gift', amount: 35 }])
    expect(split(accounts, 5, false)).toEqual([{ account: 'gift', amount: 5 }])
    expect(() => split(accounts, 36, false)).toThrow(badRequest)
    // the same accounts with a paid tariff
    expect(split(accounts, 45, true)).toEqual([{ account: 'tariff', amount: 45 }])
  })

  it('refuses a reserve larger than what can be spent', () => {
    expect(() => split(three(account(5), account(0), account(30)), 36)).toThrow(badRequest)
    expect(() => split(three(account(5, 5), account(0), account(30, 30)), 1)).toThrow(badRequest)
    expect(() => split(three(account(0), account(0), account(0)), 1)).toThrow(badRequest)
    expect(() => split(three(account(0), account(4, 4), account(0)), 1, false)).toThrow(badRequest)
  })

  it('places one part per account, in the order credits are spent, and the parts add up', () => {
    for (const tariff of [0, 1, 7, 45, 300]) {
      for (const gift of [0, 3, 35]) {
        for (const pack of [0, 2, 100]) {
          for (const tariffTakesTasks of [true, false]) {
            const accounts = three(account(tariff + 4, 4), account(gift), account(pack + 9, 9))
            const spendable = spendableCredits(accounts, tariffTakesTasks)
            for (const amount of new Set([1, 5, 45, 120, spendable.total])) {
              if (amount < 1 || amount > spendable.total) continue
              const parts = split(accounts, amount, tariffTakesTasks)
              expect(sumOf(parts.map((part) => part.amount))).toBe(amount)
              expect(parts.every((part) => part.amount > 0)).toBe(true)
              const kinds = parts.map((part) => part.account)
              expect(kinds).toEqual(creditAccountKinds.filter((kind) => kinds.includes(kind)))
              // an account gives nothing while an earlier one still has a credit to give
              for (const [index, part] of parts.entries()) {
                expect(part.amount).toBeLessThanOrEqual(spendable[part.account])
                const earlier = creditAccountKinds.slice(
                  0,
                  creditAccountKinds.indexOf(part.account),
                )
                for (const kind of earlier) {
                  const given = parts.find((other) => other.account === kind)?.amount ?? 0
                  expect(given).toBe(spendable[kind])
                }
                expect(index).toBe(kinds.indexOf(part.account))
              }
            }
          }
        }
      }
    }
  })

  it('does not change its input', () => {
    const input = {
      accounts: three(account(5), account(0), account(100)),
      amount: toCredits(45),
      tariffTakesTasks: true,
    }
    splitReserve(input)
    expect(input).toEqual({
      accounts: three(account(5), account(0), account(100)),
      amount: 45,
      tariffTakesTasks: true,
    })
  })

  it.each<[string, Record<string, unknown>]>([
    ['a reserve of nothing', { amount: 0 }],
    ['a negative reserve', { amount: -5 }],
    ['a fraction of a credit', { amount: 4.5 }],
    ['a reserve as a string', { amount: '45' }],
    ['a reserve above the column', { amount: 1_000_000_000_000 }],
    ['no reserve', { amount: undefined }],
    ['no word on the tariff', { tariffTakesTasks: undefined }],
    ['a status in place of the word on the tariff', { tariffTakesTasks: 'active' }],
    ['accounts without the gift', { accounts: { tariff: account(50), pack: account(50) } }],
    [
      'an account that holds more than it has',
      { accounts: three(account(5, 6), account(0), account(100)) },
    ],
    ['an unknown field', { modelClass: 'standard' }],
  ])('refuses %s', (_name, change) => {
    const input = {
      accounts: three(account(50), account(0), account(100)),
      amount: 45,
      tariffTakesTasks: true,
      ...change,
    }
    expect(() => splitReserve(input as CreditReserveInput)).toThrow(badRequest)
  })

  it('refuses what is not an input at all', () => {
    expect(() => splitReserve(null as unknown as CreditReserveInput)).toThrow(badRequest)
    expect(() => splitReserve(undefined as unknown as CreditReserveInput)).toThrow(badRequest)
  })
})

describe('distributeCharge', () => {
  const charged = (
    charge: number,
    rows: CreditReserveRow[],
    accounts: CreditAccounts,
    subscription: Subscription = paid,
  ) => distributeCharge({ charge: toCredits(charge), rows, accounts, subscription })

  // A customer on «Старт» with 5 tariff credits and 100 pack credits asks for a new block.
  it('walks one task through two accounts', () => {
    const before = three(account(5), account(0), account(100))
    const spendable = spendableCredits(before, true)
    expect(spendable.total).toBe(105)

    // queued: 45 = 5 on the tariff + 40 on the pack, two rows
    const amount = attemptReserveCredits('standard', spendable.total)
    expect(amount).toBe(45)
    const reserve = placed(before, 'block', amount)
    expect(reserve.parts).toEqual([
      { account: 'tariff', amount: 5 },
      { account: 'pack', amount: 40 },
    ])
    expect(reserve.accounts).toEqual(three(account(5, 5), account(0), account(100, 40)))

    // the first turn: the reserve is a whole step, 45 × 6.00
    const beforeWork = { reserved: amount, used: creditsFromCost([]), rubPerCredit: '6.00' }
    expect(customerBudgetLeftRub(beforeWork)).toBe('270.0000000000')

    // the calls cost 101.37 RUB, all billable: 16.90 credits, charged 17
    const used = creditsFromCost([{ costRub: '101.37', rubPerCredit: '6.00' }])
    const charge = taskCharge({ used, reserved: amount })
    expect(charge).toEqual({ credits: 17, minimumApplied: false, capped: false })

    // the tariff has 5 of its own row and nothing free: it pays 5; the pack pays 12
    const distribution = distributeCharge({
      charge: charge.credits,
      rows: reserve.rows,
      accounts: reserve.accounts,
      subscription: paid,
    })
    expect(distribution).toEqual({
      endedRows: [],
      accounts: {
        tariff: { paid: 5, reserved: 5 },
        gift: nothing,
        pack: { paid: 12, reserved: 40 },
      },
      from: { tariff: 5, gift: 0, pack: 12 },
      expired: 0,
    })
    // left: 0 on the tariff, 88 in the pack
    expect(settled(reserve.accounts, reserve.rows, distribution)).toEqual(
      three(account(0), account(0), account(88)),
    )
  })

  // Tariff 40, pack 100. Task A, a small edit, is queued first; task B, a block, after it.
  describe('two tasks at once', () => {
    // placed anew for every case: a case that cannot place them fails by itself
    const queued = () => {
      const before = three(account(40), account(0), account(100))
      const a = placed(before, 'a', toCredits(45))
      return { a, b: placed(a.accounts, 'b', toCredits(45)) }
    }

    it('reserves A on the tariff and the pack, and B on the pack alone', () => {
      const { a, b } = queued()
      expect(a.parts).toEqual([
        { account: 'tariff', amount: 40 },
        { account: 'pack', amount: 5 },
      ])
      expect(b.parts).toEqual([{ account: 'pack', amount: 45 }])
      expect(b.accounts).toEqual(three(account(40, 40), account(0), account(100, 50)))
    })

    it('keeps the order of the owner when A is done first: the tariff pays for B', () => {
      const { a, b } = queued()
      // A is done for 5: the tariff pays 5 from A's own row, the other 35 and the 5 of the
      // pack stop being held
      const forA = charged(5, a.rows, b.accounts)
      expect(forA.accounts).toEqual({
        tariff: { paid: 5, reserved: 40 },
        gift: nothing,
        pack: { paid: 0, reserved: 5 },
      })
      const afterA = settled(b.accounts, a.rows, forA)
      expect(afterA).toEqual(three(account(35), account(0), account(100, 45)))

      // B is done for 17: the tariff has 35 free, so the tariff pays all 17, although B's
      // reserve stood on the pack; the pack row of 45 stops being held
      const forB = charged(17, b.rows, afterA)
      expect(forB).toEqual({
        endedRows: [],
        accounts: {
          tariff: { paid: 17, reserved: 0 },
          gift: nothing,
          pack: { paid: 0, reserved: 45 },
        },
        from: { tariff: 17, gift: 0, pack: 0 },
        expired: 0,
      })
      expect(settled(afterA, b.rows, forB)).toEqual(three(account(18), account(0), account(100)))
    })

    // What the rule does not repair: the order is kept among credits that are free at the
    // moment of a charge, and credits another task still holds are not given away.
    it('takes 17 from the pack when B is done before A, and A returns 35 tariff credits', () => {
      const { a, b } = queued()
      const forB = charged(17, b.rows, b.accounts)
      expect(forB.accounts).toEqual({
        tariff: nothing,
        gift: nothing,
        pack: { paid: 17, reserved: 45 },
      })
      expect(forB.from).toEqual({ tariff: 0, gift: 0, pack: 17 })
      const afterB = settled(b.accounts, b.rows, forB)
      expect(afterB).toEqual(three(account(40, 40), account(0), account(83, 5)))

      const forA = charged(5, a.rows, afterB)
      expect(forA.from).toEqual({ tariff: 5, gift: 0, pack: 0 })
      expect(settled(afterB, a.rows, forA)).toEqual(three(account(35), account(0), account(83)))
    })
  })

  // 45 tariff credits reserved on the 17th; the period renews on the 18th with 300 new
  // credits: balance 345, held 45; the task is done on the 19th for 17.
  it('charges the row of an ended period first and expires the rest of it', () => {
    const rows = [row('old', 'tariff', 45, day(-1))]
    const accounts = three(account(345, 45), account(0), account(0))
    const distribution = charged(17, rows, accounts)
    expect(distribution).toEqual({
      endedRows: [{ id: 'old', paid: 17, expired: 28 }],
      accounts: { tariff: nothing, gift: nothing, pack: nothing },
      from: { tariff: 17, gift: 0, pack: 0 },
      expired: 28,
    })
    // the new period is exactly its quota
    expect(settled(accounts, rows, distribution)).toEqual(
      three(account(300), account(0), account(0)),
    )
  })

  it('returns the unused part of a tariff row into the period it was reserved in', () => {
    const rows = [row('own', 'tariff', 45, day(0))]
    const accounts = three(account(100, 45), account(0), account(0))
    const distribution = charged(17, rows, accounts)
    expect(distribution).toEqual({
      endedRows: [],
      accounts: { tariff: { paid: 17, reserved: 45 }, gift: nothing, pack: nothing },
      from: { tariff: 17, gift: 0, pack: 0 },
      expired: 0,
    })
    expect(settled(accounts, rows, distribution)).toEqual(
      three(account(83), account(0), account(0)),
    )
  })

  it('tells an ended period by the stamp of the row, to the millisecond', () => {
    const accounts = three(account(345, 45), account(0), account(0))
    expect(charged(17, [row('r', 'tariff', 45, day(0, -1))], accounts).endedRows).toEqual([
      { id: 'r', paid: 17, expired: 28 },
    ])
    expect(charged(17, [row('r', 'tariff', 45, day(0))], accounts).endedRows).toEqual([])
  })

  // A task continued across a renewal: the first attempt on credits of the period that ended,
  // the second on credits of the new one.
  it('pays from the ended row to its last credit before the credits of the new period', () => {
    const rows = [row('second', 'tariff', 45, day(1)), row('first', 'tariff', 45, day(-1))]
    const accounts = three(account(345, 90), account(0), account(0))
    const distribution = charged(60, rows, accounts)
    expect(distribution).toEqual({
      endedRows: [{ id: 'first', paid: 45, expired: 0 }],
      accounts: { tariff: { paid: 15, reserved: 45 }, gift: nothing, pack: nothing },
      from: { tariff: 60, gift: 0, pack: 0 },
      expired: 0,
    })
    expect(settled(accounts, rows, distribution)).toEqual(
      three(account(285), account(0), account(0)),
    )
  })

  it('pays from ended rows oldest first, whatever order they are given in', () => {
    const older = row('older', 'tariff', 20, day(-40))
    const newer = row('newer', 'tariff', 25, day(-2))
    const accounts = three(account(345, 45), account(0), account(0))
    const expected = [
      { id: 'older', paid: 20, expired: 0 },
      { id: 'newer', paid: 10, expired: 15 },
    ]
    expect(charged(30, [older, newer], accounts).endedRows).toEqual(expected)
    expect(charged(30, [newer, older], accounts).endedRows).toEqual(expected)
    // a charge the oldest row covers alone leaves the newer one to expire whole
    expect(charged(5, [newer, older], accounts).endedRows).toEqual([
      { id: 'older', paid: 5, expired: 15 },
      { id: 'newer', paid: 0, expired: 25 },
    ])
  })

  it('lets ended rows of one stamp pay in the order they are given', () => {
    const stamp = day(0, -1)
    const first = row('first', 'tariff', 20, stamp)
    const second = row('second', 'tariff', 25, new Date(stamp))
    const accounts = three(account(345, 45), account(0), account(0))
    expect(charged(22, [first, second], accounts).endedRows).toEqual([
      { id: 'first', paid: 20, expired: 0 },
      { id: 'second', paid: 2, expired: 23 },
    ])
    expect(charged(22, [second, first], accounts).endedRows).toEqual([
      { id: 'second', paid: 22, expired: 3 },
      { id: 'first', paid: 0, expired: 20 },
    ])
  })

  describe('a tariff that no longer takes tasks', () => {
    const rows = [row('t', 'tariff', 30, day(2)), row('p', 'pack', 15, day(2))]
    const accounts = three(account(100, 30), account(0), account(60, 15))
    const ended: [string, Subscription][] = [
      ['overdue', subscriptionIn('past_due')],
      ['cancelled', subscriptionIn('cancelled')],
      ['expired', subscriptionIn('expired')],
      ['in a trial', subscriptionIn('trial')],
      ['gone', null],
    ]

    it.each(ended)('%s: every tariff row is of an ended period', (_name, subscription) => {
      const distribution = charged(17, rows, accounts, subscription)
      expect(distribution).toEqual({
        endedRows: [{ id: 't', paid: 17, expired: 13 }],
        accounts: { tariff: nothing, gift: nothing, pack: { paid: 0, reserved: 15 } },
        from: { tariff: 17, gift: 0, pack: 0 },
        expired: 13,
      })
      // the 70 tariff credits that were free are not this charge's to take or to expire
      expect(settled(accounts, rows, distribution)).toEqual(
        three(account(70), account(0), account(60)),
      )
    })

    it.each(ended)(
      '%s: the pack pays from the row of the task, not from what is free',
      (_name, subscription) => {
        const distribution = charged(40, rows, accounts, subscription)
        expect(distribution.endedRows).toEqual([{ id: 't', paid: 30, expired: 0 }])
        expect(distribution.accounts.pack).toEqual({ paid: 10, reserved: 15 })
        expect(distribution.accounts.tariff).toEqual(nothing)
        expect(settled(accounts, rows, distribution)).toEqual(
          three(account(70), account(0), account(50)),
        )
      },
    )

    it.each(ended)('%s: free gift credits still go before the pack', (_name, subscription) => {
      const withGift = three(account(100, 30), account(35), account(60, 15))
      const distribution = charged(40, rows, withGift, subscription)
      expect(distribution.from).toEqual({ tariff: 30, gift: 10, pack: 0 })
      expect(distribution.accounts.gift).toEqual({ paid: 10, reserved: 0 })
      expect(distribution.accounts.pack).toEqual({ paid: 0, reserved: 15 })
      expect(settled(withGift, rows, distribution)).toEqual(
        three(account(70), account(25), account(60)),
      )
    })
  })

  it('spends the three accounts in the order of the owner', () => {
    const rows = [row('t', 'tariff', 10), row('g', 'gift', 20), row('p', 'pack', 15)]
    const accounts = three(account(10, 10), account(20, 20), account(100, 15))
    expect(charged(28, rows, accounts)).toEqual({
      endedRows: [],
      accounts: {
        tariff: { paid: 10, reserved: 10 },
        gift: { paid: 18, reserved: 20 },
        pack: { paid: 0, reserved: 15 },
      },
      from: { tariff: 10, gift: 18, pack: 0 },
      expired: 0,
    })
    expect(charged(45, rows, accounts).from).toEqual({ tariff: 10, gift: 20, pack: 15 })
    expect(charged(31, rows, accounts).from).toEqual({ tariff: 10, gift: 20, pack: 1 })
    expect(charged(5, rows, accounts).from).toEqual({ tariff: 5, gift: 0, pack: 0 })
  })

  it('moves a charge to the gift that came free since the reserve, before the pack', () => {
    // the reserve stood on the pack; meanwhile another task returned 12 gift credits
    const rows = [row('p', 'pack', 45)]
    const accounts = three(account(0), account(12), account(100, 45))
    const distribution = charged(17, rows, accounts)
    expect(distribution.from).toEqual({ tariff: 0, gift: 12, pack: 5 })
    expect(settled(accounts, rows, distribution)).toEqual(
      three(account(0), account(0), account(95)),
    )
  })

  it('never takes what another task holds', () => {
    // 60 tariff credits, all held by another task; 35 gift credits, 30 of them held as well
    const rows = [row('p', 'pack', 45)]
    const accounts = three(account(60, 60), account(35, 30), account(100, 45))
    const distribution = charged(17, rows, accounts)
    expect(distribution.from).toEqual({ tariff: 0, gift: 5, pack: 12 })
    expect(settled(accounts, rows, distribution)).toEqual(
      three(account(60, 60), account(30, 30), account(88)),
    )
  })

  it('charges the whole reserve when the charge is the cap', () => {
    const rows = [row('t', 'tariff', 5), row('p', 'pack', 40)]
    const accounts = three(account(5, 5), account(0), account(100, 40))
    const distribution = charged(45, rows, accounts)
    expect(distribution.from).toEqual({ tariff: 5, gift: 0, pack: 40 })
    expect(settled(accounts, rows, distribution)).toEqual(
      three(account(0), account(0), account(60)),
    )
  })

  // A task that ends without a charge: its ended rows expire, the other rows return.
  it('settles a charge of zero: ended rows expire whole, every other row returns', () => {
    const rows = [
      row('old', 'tariff', 45, day(-1)),
      row('new', 'tariff', 10, day(1)),
      row('g', 'gift', 10),
      row('p', 'pack', 25),
    ]
    const accounts = three(account(345, 55), account(35, 10), account(100, 25))
    const distribution = charged(0, rows, accounts)
    expect(distribution).toEqual({
      endedRows: [{ id: 'old', paid: 0, expired: 45 }],
      accounts: {
        tariff: { paid: 0, reserved: 10 },
        gift: { paid: 0, reserved: 10 },
        pack: { paid: 0, reserved: 25 },
      },
      from: { tariff: 0, gift: 0, pack: 0 },
      expired: 45,
    })
    expect(settled(accounts, rows, distribution)).toEqual(
      three(account(300), account(35), account(100)),
    )
  })

  it('settles a task without rows only for nothing', () => {
    const accounts = three(account(300), account(35), account(100))
    expect(charged(0, [], accounts)).toEqual({
      endedRows: [],
      accounts: { tariff: nothing, gift: nothing, pack: nothing },
      from: { tariff: 0, gift: 0, pack: 0 },
      expired: 0,
    })
    expect(() => charged(1, [], accounts)).toThrow(badRequest)
  })

  it('refuses a charge above the rows of the task, however much is free', () => {
    const rows = [row('t', 'tariff', 5), row('p', 'pack', 40)]
    const accounts = three(account(300, 5), account(35), account(100, 40))
    expect(charged(45, rows, accounts).from).toEqual({ tariff: 45, gift: 0, pack: 0 })
    expect(() => charged(46, rows, accounts)).toThrow(badRequest)
  })

  it('refuses rows that hold more than their account does', () => {
    const rows = [row('t', 'tariff', 5), row('p', 'pack', 40)]
    expect(() => charged(17, rows, three(account(5, 4), account(0), account(100, 40)))).toThrow(
      badRequest,
    )
    expect(() => charged(17, rows, three(account(5, 5), account(0), account(100, 39)))).toThrow(
      badRequest,
    )
    expect(() =>
      charged(
        17,
        [...rows, row('g', 'gift', 1)],
        three(account(5, 5), account(35), account(100, 40)),
      ),
    ).toThrow(badRequest)
    // two rows of one account are held together
    expect(() =>
      charged(
        17,
        [row('p1', 'pack', 30), row('p2', 'pack', 30)],
        three(account(0), account(0), account(100, 59)),
      ),
    ).toThrow(badRequest)
  })

  it('refuses a row given twice', () => {
    const accounts = three(account(0), account(0), account(100, 90))
    expect(() => charged(17, [row('p', 'pack', 45), row('p', 'pack', 45)], accounts)).toThrow(
      badRequest,
    )
    expect(charged(17, [row('p', 'pack', 45), row('q', 'pack', 45)], accounts).from.pack).toBe(17)
  })

  it('does not change its input', () => {
    const rows = [row('newer', 'tariff', 25, day(-2)), row('older', 'tariff', 20, day(-40))]
    const input = {
      charge: toCredits(30),
      rows,
      accounts: three(account(345, 45), account(0), account(0)),
      subscription: { status: 'active' as const, currentPeriodStart: new Date(periodStart) },
    }
    distributeCharge(input)
    expect(input.rows.map(({ id }) => id)).toEqual(['newer', 'older'])
    expect(input).toEqual({
      charge: 30,
      rows: [row('newer', 'tariff', 25, day(-2)), row('older', 'tariff', 20, day(-40))],
      accounts: three(account(345, 45), account(0), account(0)),
      subscription: paid,
    })
  })

  it.each<[string, Record<string, unknown>]>([
    ['a negative charge', { charge: -1 }],
    ['a fraction of a charge', { charge: 16.895 }],
    ['a charge as a string', { charge: '17' }],
    ['no charge', { charge: undefined }],
    ['rows that are not a list', { rows: row('p', 'pack', 45) }],
    // beside a row that covers the charge: the row itself is what is refused
    ['a row of nothing', { rows: [row('p', 'pack', 45), { ...row('q', 'pack', 45), amount: 0 }] }],
    ['a row of a fraction', { rows: [{ ...row('p', 'pack', 45), amount: 44.5 }] }],
    ['a row on a wallet', { rows: [{ ...row('p', 'pack', 45), account: 'rub' }] }],
    [
      'a row by the unit of its account',
      { rows: [{ ...row('p', 'pack', 45), account: 'credit_pack' }] },
    ],
    ['a row without a name', { rows: [{ ...row('p', 'pack', 45), id: '' }] }],
    ['a row without a stamp', { rows: [{ id: 'p', account: 'pack', amount: 45 }] }],
    [
      'a row with a stamp that is not a moment',
      { rows: [row('p', 'pack', 45, new Date(Number.NaN))] },
    ],
    ['a row with a field of its own', { rows: [{ ...row('p', 'pack', 45), attempt: 1 }] }],
    ['accounts without the gift', { accounts: { tariff: account(0), pack: account(100, 45) } }],
    [
      'an account that holds more than it has',
      { accounts: three(account(0), account(0), account(44, 45)) },
    ],
    ['a subscription without its period', { subscription: { status: 'active' } }],
    [
      'a subscription in a status that is not one',
      { subscription: { status: 'paid', currentPeriodStart: periodStart } },
    ],
    [
      'a period start that is not a moment',
      { subscription: { status: 'active', currentPeriodStart: new Date(Number.NaN) } },
    ],
    ['no word on the subscription', { subscription: undefined }],
    ['a word in place of the subscription', { subscription: true }],
    ['an unknown field', { tariffTakesTasks: true }],
  ])('refuses %s', (_name, change) => {
    const input = {
      charge: 17,
      rows: [row('p', 'pack', 45)],
      accounts: three(account(0), account(0), account(100, 45)),
      subscription: paid,
      ...change,
    }
    expect(() => distributeCharge(input as unknown as ChargeDistributionInput)).toThrow(badRequest)
  })

  it('refuses what is not an input at all', () => {
    expect(() => distributeCharge(null as unknown as ChargeDistributionInput)).toThrow(badRequest)
    expect(() => distributeCharge(undefined as unknown as ChargeDistributionInput)).toThrow(
      badRequest,
    )
  })

  // Generated cases with a fixed seed: the properties the distribution must keep whatever the
  // rows, the accounts, the subscription and the charge are.
  describe('over generated cases', () => {
    /** mulberry32: a small generator with a fixed seed, the same cases on every run. */
    function generator(seed: number) {
      let state = seed
      return () => {
        state = (state + 0x6d2b79f5) | 0
        let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
        mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
        return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
      }
    }
    const random = generator(20261011)
    const upTo = (max: number) => Math.floor(random() * (max + 1))
    const oneOf = <Item>(items: readonly Item[]): Item => items[upTo(items.length - 1)] as Item

    const stamps = [day(-40), day(-1), day(0, -1), day(0), day(0, 1), day(3)]
    const subscriptions: Subscription[] = [
      paid,
      paid,
      paid,
      null,
      ...subscriptionStatuses.map(subscriptionIn),
    ]

    interface Generated {
      input: ChargeDistributionInput
      distribution: ChargeDistribution
    }

    const generate = (_unused: unknown, index: number): Generated => {
      const rows = Array.from({ length: upTo(5) }, (_row, position) =>
        row(`h${position}`, oneOf(creditAccountKinds), 1 + upTo(59), oneOf(stamps)),
      )
      const own = (kind: CreditAccountKind) =>
        sumOf(rows.filter((reserved) => reserved.account === kind).map(({ amount }) => amount))
      // other tasks hold some more on every account, and some of it is free
      const snapshot = (kind: CreditAccountKind) => {
        const held = own(kind) + (random() < 0.5 ? 0 : upTo(50))
        return account(held + (random() < 0.4 ? 0 : upTo(80)), held)
      }
      const total = sumOf(rows.map(({ amount }) => amount))
      const input: ChargeDistributionInput = {
        charge: toCredits(index % 5 === 0 ? total : index % 7 === 0 ? 0 : upTo(total)),
        rows,
        accounts: three(snapshot('tariff'), snapshot('gift'), snapshot('pack')),
        subscription: oneOf(subscriptions),
      }
      return { input, distribution: distributeCharge(input) }
    }
    // built by the first case that asks: a rule that cannot settle a case fails the cases
    // themselves, each by its own name
    let built: Generated[] | undefined
    const generated = () => (built ??= Array.from({ length: 3000 }, generate))

    const ownRows = ({ rows }: ChargeDistributionInput, kind: CreditAccountKind) =>
      rows.filter((reserved) => reserved.account === kind)
    const endedOf = ({ rows, subscription }: ChargeDistributionInput) =>
      rows.filter((reserved) => isEnded(reserved, subscription))
    /** What an account has for the task from its credits of now: its other rows and what is free. */
    const hasNow = (input: ChargeDistributionInput, kind: CreditAccountKind) => {
      const current = ownRows(input, kind).filter(
        (reserved) => !isEnded(reserved, input.subscription),
      )
      const free = input.accounts[kind].balance - input.accounts[kind].held
      const freeCounts = kind === 'gift' || takesTasks(input.subscription)
      return sumOf(current.map(({ amount }) => amount)) + (freeCounts ? free : 0)
    }

    it('covers every kind of case', () => {
      const count = (wanted: (one: Generated) => boolean) => generated().filter(wanted).length
      expect(count(({ distribution }) => distribution.endedRows.length > 0)).toBeGreaterThan(300)
      expect(count(({ distribution }) => distribution.expired > 0)).toBeGreaterThan(200)
      expect(count(({ distribution }) => distribution.from.pack > 0)).toBeGreaterThan(300)
      expect(count(({ distribution }) => distribution.from.gift > 0)).toBeGreaterThan(300)
      expect(count(({ distribution }) => distribution.accounts.tariff.paid > 0)).toBeGreaterThan(
        200,
      )
      expect(count(({ input }) => !takesTasks(input.subscription))).toBeGreaterThan(500)
      expect(count(({ input }) => input.charge === 0)).toBeGreaterThan(200)
      expect(count(({ input }) => input.rows.length === 0)).toBeGreaterThan(100)
      // free credits paid above what the task's own rows on the account held
      expect(
        count(({ distribution }) =>
          creditAccountKinds.some(
            (kind) => distribution.accounts[kind].paid > distribution.accounts[kind].reserved,
          ),
        ),
      ).toBeGreaterThan(200)
    })

    it('adds the parts up to the charge', () => {
      for (const { input, distribution } of generated()) {
        const { endedRows, accounts, from } = distribution
        const parts =
          sumOf(endedRows.map((ended) => ended.paid)) +
          accounts.tariff.paid +
          accounts.gift.paid +
          accounts.pack.paid
        expect(parts).toBe(input.charge)
        expect(from.tariff + from.gift + from.pack).toBe(input.charge)
        expect(from.tariff).toBe(sumOf(endedRows.map((ended) => ended.paid)) + accounts.tariff.paid)
        expect(from.gift).toBe(accounts.gift.paid)
        expect(from.pack).toBe(accounts.pack.paid)
      }
    })

    it('lets the pack pay nothing while the tariff or the gift had a credit to give', () => {
      for (const { input, distribution } of generated()) {
        const tariffHad =
          sumOf(endedOf(input).map(({ amount }) => amount)) + hasNow(input, 'tariff')
        const giftHad = hasNow(input, 'gift')
        if (distribution.from.pack > 0) {
          expect(distribution.from.tariff).toBe(tariffHad)
          expect(distribution.from.gift).toBe(giftHad)
        }
        // and the gift nothing while the tariff had one
        if (distribution.from.gift > 0) expect(distribution.from.tariff).toBe(tariffHad)
        // within the tariff, the credits of now pay only after every ended row paid whole
        if (distribution.accounts.tariff.paid > 0) expect(distribution.expired).toBe(0)
      }
    })

    it('makes an ended row pay and expire its whole amount: nothing returns from it', () => {
      for (const { input, distribution } of generated()) {
        const ended = endedOf(input)
        expect(distribution.endedRows.map(({ id }) => id).sort()).toEqual(
          ended.map(({ id }) => id).sort(),
        )
        const stampOf = (id: string) => ended.find((reserved) => reserved.id === id)?.createdAt
        let earlierPaidWhole = true
        for (const [position, settledRow] of distribution.endedRows.entries()) {
          const reserved = ended.find(({ id }) => id === settledRow.id)
          expect(settledRow.paid + settledRow.expired).toBe(reserved?.amount)
          // oldest first: a row pays only after every older one paid whole
          if (settledRow.paid > 0) expect(earlierPaidWhole).toBe(true)
          earlierPaidWhole &&= settledRow.expired === 0
          const before = distribution.endedRows[position - 1]
          if (before !== undefined) {
            expect(stampOf(before.id)?.getTime()).toBeLessThanOrEqual(
              stampOf(settledRow.id)?.getTime() ?? Number.NaN,
            )
          }
        }
        expect(distribution.expired).toBe(sumOf(distribution.endedRows.map((row) => row.expired)))
      }
    })

    it('takes every row of the task off `held`, and no account pays more than it has for the task', () => {
      for (const { input, distribution } of generated()) {
        const endedTotal = sumOf(endedOf(input).map(({ amount }) => amount))
        for (const kind of creditAccountKinds) {
          const share = distribution.accounts[kind]
          const own = sumOf(ownRows(input, kind).map(({ amount }) => amount))
          expect(share.reserved + (kind === 'tariff' ? endedTotal : 0)).toBe(own)
          expect(share.paid).toBeLessThanOrEqual(hasNow(input, kind))
          expect(share.paid).toBeLessThanOrEqual(
            share.reserved + input.accounts[kind].balance - input.accounts[kind].held,
          )
        }
        if (!takesTasks(input.subscription)) {
          expect(distribution.accounts.tariff).toEqual(nothing)
          expect(distribution.accounts.pack.paid).toBeLessThanOrEqual(
            distribution.accounts.pack.reserved,
          )
        }
      }
    })

    it('leaves three valid accounts: nothing negative, held never above balance', () => {
      for (const { input, distribution } of generated()) {
        const after = settled(input.accounts, input.rows, distribution)
        const ended = sumOf(endedOf(input).map(({ amount }) => amount))
        for (const kind of creditAccountKinds) {
          // what other tasks hold on the account is still held, to the credit
          const own = sumOf(ownRows(input, kind).map(({ amount }) => amount))
          expect(after[kind].held).toBe(input.accounts[kind].held - own)
          const gone = distribution.accounts[kind].paid + (kind === 'tariff' ? ended : 0)
          expect(after[kind].balance).toBe(input.accounts[kind].balance - gone)
        }
      }
    })

    it('answers the same for the same input', () => {
      for (const { input, distribution } of generated().slice(0, 200)) {
        expect(distributeCharge(input)).toEqual(distribution)
      }
    })
  })
})
