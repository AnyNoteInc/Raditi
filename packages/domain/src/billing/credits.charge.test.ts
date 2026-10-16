import { Decimal } from 'decimal.js'
import { describe, expect, it } from 'vitest'
import { Money } from '../money.ts'
import { terminalTaskStatuses } from '../tasks/task-status.ts'
import {
  chargeForOutcome,
  creditsFromCost,
  customerBudgetLeftRub,
  minTaskChargeCredits,
  taskCharge,
  taskOutcomes,
  toCredits,
  unpaidWork,
  type ChargedWork,
  type CostAtRate,
  type CustomerBudgetInput,
  type TaskEnding,
  type UnpaidWorkInput,
} from './credits.ts'

// The work of a task in credits and what it is charged. Every number of the tables below was
// computed by hand from the examples of the model: the credit rate K = 6.00 RUB of accounting
// cost in a credit, a done task charged at least 5 credits and never more than its reserve.

const badRequest = expect.objectContaining({ name: 'DomainError', code: 'BAD_REQUEST' })
const K = '6.00'
const at = (costRub: string, rubPerCredit = K): CostAtRate => ({ costRub, rubPerCredit })
/** Unrounded credits written out, for a case that is about the charge alone. */
const used = (credits: string) => new Money(credits)
const work = (credits: string, reserved: number): ChargedWork => ({
  used: used(credits),
  reserved: toCredits(reserved),
})

describe('creditsFromCost', () => {
  it.each([
    // accounting cost of the calls, RUB → credits: cost ÷ 6.00
    ['a small edit', '22.09', '3.681666666666666666666666666666666666667', '3.68'],
    ['a new block', '101.37', '16.895', '16.90'],
    ['a big task', '176.70', '29.45', '29.45'],
    [
      'the block after one clarification',
      '126.71',
      '21.11833333333333333333333333333333333333',
      '21.12',
    ],
    [
      'three small edits in one message',
      '66.26',
      '11.04333333333333333333333333333333333333',
      '11.04',
    ],
    ['calls already admitted that ran over', '297.00', '49.5', '49.50'],
    ['a task on the last credits', '80.00', '13.33333333333333333333333333333333333333', '13.33'],
    ['the cost of one credit', '6.00', '1', '1.00'],
    ['a cost in the precision of the column', '0.0000000006', '0.0000000001', '0.00'],
  ])('%s: %s RUB is %s credits', (_name, costRub, exact, shown) => {
    const credits = creditsFromCost([at(costRub)])
    expect(credits.toFixed()).toBe(exact)
    expect(credits.toFixed(2)).toBe(shown)
  })

  it('adds the attempts of a chain: 225 RUB under the first reserve and 72 RUB under the second', () => {
    expect(creditsFromCost([at('225.00'), at('72.00')]).toFixed()).toBe('49.5')
  })

  it('counts nothing for no calls and for calls that cost nothing', () => {
    expect(creditsFromCost([]).toFixed()).toBe('0')
    expect(creditsFromCost([at('0')]).toFixed()).toBe('0')
    expect(creditsFromCost([at('0.0000000000'), at('0', '5.98')]).toFixed()).toBe('0')
  })

  // The rate changed while the task worked: each call is converted at the rate of its start.
  it('divides each sum by its own rate when the work crosses a change of the rate', () => {
    // 50.00 ÷ 6.00 = 8.3333…; 51.37 ÷ 5.00 = 10.274; together 18.6073…
    const crossed = creditsFromCost([at('50.00', '6.00'), at('51.37', '5.00')])
    expect(crossed.toFixed(6)).toBe('18.607333')
    // the same 101.37 RUB at one rate or the other
    expect(creditsFromCost([at('101.37', '6.00')]).toFixed(3)).toBe('16.895')
    expect(creditsFromCost([at('101.37', '5.00')]).toFixed(3)).toBe('20.274')
    // 60.00 ÷ 6.00 + 55.00 ÷ 5.00 = 10 + 11
    expect(creditsFromCost([at('60.00', '6.00'), at('55.00', '5.00')]).toFixed()).toBe('21')
  })

  it('does not depend on the order of the sums', () => {
    const sums = [at('50.00', '6.00'), at('51.37', '5.00'), at('14.00', '7.50'), at('3.21')]
    const forward = creditsFromCost(sums)
    expect(creditsFromCost([...sums].reverse()).eq(forward)).toBe(true)
  })

  it('reads one rate written with two or with six decimals as one rate', () => {
    const credits = creditsFromCost([
      at('14.00', '6.00'),
      at('14.00', '6.000000'),
      at('17.00', '6'),
    ])
    expect(credits.toFixed()).toBe('7.5')
  })

  // 14 ÷ 6 = 2⅓, twice, and 17 ÷ 6 = 2⅚: three attempts that cost 45.00 RUB, 7.5 credits. Divided
  // one by one at the forty digits of money they add up to 7.4999…9, which a rounding takes
  // for 7.
  it('makes the half that thirds and sixths add up to, however the cost is split', () => {
    const split = creditsFromCost([at('14.00'), at('14.00'), at('17.00')])
    expect(split.toFixed()).toBe('7.5')
    expect(split.eq(creditsFromCost([at('45.00')]))).toBe(true)
    const oneByOne = ['14.00', '14.00', '17.00'].reduce(
      (sum, cost) => sum.plus(new Money(cost).div(K)),
      new Money(0),
    )
    expect(oneByOne.toFixed()).toBe('7.499999999999999999999999999999999999999')
  })

  // 14 ÷ 6 = 2⅓, 17.50 ÷ 7.50 = 2⅓, 25.50 ÷ 9 = 2⅚ — three rates, 7.5 credits exactly.
  it('makes the same half out of quotients of different rates', () => {
    const credits = creditsFromCost([at('14.00', '6.00'), at('17.50', '7.50'), at('25.50', '9.00')])
    expect(credits.toFixed()).toBe('7.5')
  })

  // 2 ÷ 6 = ⅓, twenty-two times, and 1 ÷ 6 = ⅙: 45.00 RUB again. One digit to spare is not
  // enough for so many quotients; a workspace counted over years of rates has that many sums.
  it('keeps the half through many sums', () => {
    const sums = [...Array.from({ length: 22 }, () => at('2.00')), at('1.00')]
    expect(creditsFromCost(sums).toFixed()).toBe('7.5')
    const rates = ['6.00', '6.000000', '6', '6.0']
    const mixed = sums.map((sum, index) => at(sum.costRub, rates[index % rates.length]))
    expect(creditsFromCost(mixed).toFixed()).toBe('7.5')
  })

  it('rounds nothing per sum: three halves of a credit are a credit and a half', () => {
    expect(creditsFromCost([at('3.00'), at('3.00'), at('3.00')]).toFixed()).toBe('1.5')
    expect(creditsFromCost([at('15.00'), at('15.00'), at('15.00')]).toFixed()).toBe('7.5')
  })

  it('answers in the decimal arithmetic of money, forty digits at most', () => {
    const credits = creditsFromCost([at('22.09'), at('0.0000000001', '7.123457')])
    // of the constructor of money itself: what a caller computes next is rounded as money is
    expect(credits.constructor).toBe(Money)
    expect(credits.precision()).toBeLessThanOrEqual(40)
    expect(credits.div(3).precision()).toBeLessThanOrEqual(40)
  })

  it('takes the largest sum and the smallest rate of the columns', () => {
    const credits = creditsFromCost([at('999999999999.9999999999', '0.000001')])
    // a division by a millionth moves the point six digits
    expect(credits.toFixed()).toBe('999999999999999999.9999')
  })

  it('does not change its input', () => {
    const sums = [at('50.00', '6.00'), at('51.37', '5.00')]
    creditsFromCost(sums)
    expect(sums).toEqual([at('50.00', '6.00'), at('51.37', '5.00')])
  })

  it.each<[string, unknown]>([
    ['a cost as a number', [{ costRub: 22.09, rubPerCredit: K }]],
    ['a cost as a Decimal', [{ costRub: new Money('22.09'), rubPerCredit: K }]],
    ['a negative cost', [at('-1.00')]],
    ['a cost with an exponent', [at('1e2')]],
    ['a cost with a comma', [at('22,09')]],
    ['an eleventh decimal of a cost', [at('0.00000000001')]],
    ['a thirteenth integer digit of a cost', [at('1000000000000')]],
    ['an empty cost', [at('')]],
    ['a rate of zero', [at('22.09', '0')]],
    ['a rate of zero with decimals', [at('22.09', '0.000000')]],
    ['a negative rate', [at('22.09', '-6.00')]],
    ['a seventh decimal of a rate', [at('22.09', '6.0000001')]],
    ['a rate as a number', [{ costRub: '22.09', rubPerCredit: 6 }]],
    ['a sum without its rate', [{ costRub: '22.09' }]],
    ['a sum without its cost', [{ rubPerCredit: K }]],
    ['a sum with a field of its own', [{ ...at('22.09'), attempt: 1 }]],
    ['one sum in place of a list', at('22.09')],
    ['a list with a hole', [at('22.09'), null]],
    ['null', null],
    ['nothing', undefined],
  ])('refuses %s', (_name, sums) => {
    expect(() => creditsFromCost(sums as CostAtRate[])).toThrow(badRequest)
  })
})

describe('taskCharge', () => {
  // The worked examples of the model. A new task reserves the step of its class, 45 credits.
  it.each([
    ['a small edit', [at('22.09')], 45, 5, true, false],
    ['a new block', [at('101.37')], 45, 17, false, false],
    ['a big task', [at('176.70')], 45, 29, false, false],
    ['the same block after one clarification', [at('126.71')], 45, 21, false, false],
    ['three small edits in one message', [at('66.26')], 45, 11, false, false],
    [
      'done, and its only calls were estimates by the fault of the platform',
      [],
      45,
      5,
      true,
      false,
    ],
    ['calls already admitted ran to 297 RUB', [at('297.00')], 45, 45, false, true],
    ['12 credits were all the customer had', [at('80.00')], 12, 12, false, true],
    ['continued once: two reserves of 45', [at('225.00'), at('72.00')], 90, 50, false, false],
    // the rate changed in the middle: 8.33 + 10.27 = 18.61
    [
      'work across a change of the rate',
      [at('50.00', '6.00'), at('51.37', '5.00')],
      45,
      19,
      false,
      false,
    ],
    // three attempts of 14, 14 and 17 RUB: 7.5 credits, a half that must not be lost
    [
      'thirds and sixths that make a half',
      [at('14.00'), at('14.00'), at('17.00')],
      45,
      8,
      false,
      false,
    ],
  ] as const)('%s', (_name, sums, reserved, credits, minimumApplied, capped) => {
    const charge = taskCharge({ used: creditsFromCost(sums), reserved: toCredits(reserved) })
    expect(charge).toEqual({ credits, minimumApplied, capped })
  })

  // 110.63 RUB at a rate of 5.98 is exactly 18.5 credits: 5.98 × 18.5 = 110.63. Binary floating
  // point makes it 18.499999999999996 and rounds it to 18.
  it('charges 19 credits where arithmetic in Number gives 18', () => {
    const inDecimal = creditsFromCost([at('110.63', '5.98')])
    expect(inDecimal.toFixed()).toBe('18.5')
    expect(taskCharge({ used: inDecimal, reserved: toCredits(45) }).credits).toBe(19)

    const inNumber = Number('110.63') / Number('5.98')
    expect(inNumber).toBe(18.499999999999996)
    expect(Math.round(inNumber)).toBe(18)
  })

  // 16.74 + 34.16 + 0.10 = 51.00 RUB, 8.5 credits. Added in Number the cost is
  // 50.99999999999999 and the credits round to 8.
  it('charges 9 credits where the cost added in Number gives 8', () => {
    const costs = ['16.74', '34.16', '0.10']
    const charge = taskCharge({
      used: creditsFromCost(costs.map((cost) => at(cost))),
      reserved: toCredits(45),
    })
    expect(charge.credits).toBe(9)

    const inNumber = costs.reduce((sum, cost) => sum + Number(cost), 0) / Number(K)
    expect(inNumber).toBeLessThan(8.5)
    expect(Math.round(inNumber)).toBe(8)
  })

  it.each([
    // HALF_UP, once, to a whole credit
    ['just under a half', '16.4999999999', 45, 16, false, false],
    // closer to the half than a Number can tell: 16.5 there, and 17 after rounding
    ['a hair under a half', '16.49999999999999999999', 45, 16, false, false],
    ['exactly a half', '16.5', 45, 17, false, false],
    ['just over a half', '16.5000000001', 45, 17, false, false],
    ['a whole number', '16', 45, 16, false, false],
    // the minimum of a done task
    ['no work at all', '0', 45, 5, true, false],
    ['work under a credit', '0.4', 45, 5, true, false],
    ['work that rounds to 4', '4.4999999999', 45, 5, true, false],
    ['work that rounds to the minimum itself', '4.5', 45, 5, false, false],
    ['work of exactly the minimum', '5', 45, 5, false, false],
    ['work that rounds down to the minimum', '5.4999999999', 45, 5, false, false],
    ['work that rounds to one above the minimum', '5.5', 45, 6, false, false],
    // the cap of the reserve
    ['work one credit under the reserve', '44', 45, 44, false, false],
    ['work that rounds down to the reserve', '45.4999999999', 45, 45, false, false],
    ['work of exactly the reserve', '45', 45, 45, false, false],
    ['work that rounds to one above the reserve', '45.5', 45, 45, false, true],
    ['work far above the reserve', '1000000', 45, 45, false, true],
    ['a reserve of the minimum', '3.2', 5, 5, true, false],
    // the cap comes after the minimum: a reserve below it is charged whole
    ['a reserve below the minimum and less work', '1.2', 3, 3, true, true],
    ['a reserve below the minimum and more work', '9', 3, 3, false, true],
    ['a reserve of one credit', '0', 1, 1, true, true],
    [
      'the largest reserve of the column',
      '999999999999.5',
      999_999_999_999,
      999_999_999_999,
      false,
      true,
    ],
    [
      'the largest reserve of the column, not reached',
      '999999999998.5',
      999_999_999_999,
      999_999_999_999,
      false,
      false,
    ],
  ] as const)(
    '%s: %s credits of %i reserved',
    (_name, credits, reserved, charged, minimumApplied, capped) => {
      expect(taskCharge(work(credits, reserved))).toEqual({
        credits: charged,
        minimumApplied,
        capped,
      })
    },
  )

  it('is min(reserved, max(5, round half up)) for every quarter of a credit', () => {
    expect(minTaskChargeCredits).toBe(5)
    for (const reserved of [1, 4, 5, 6, 12, 45, 90]) {
      for (let quarters = 0; quarters <= 400; quarters++) {
        // whole arithmetic: a quarter count q rounds half up to floor((q + 2) / 4)
        const rounded = Math.floor((quarters + 2) / 4)
        const expected = Math.min(reserved, Math.max(5, rounded))
        const charge = taskCharge({
          used: new Money(quarters).div(4),
          reserved: toCredits(reserved),
        })
        expect(charge.credits).toBe(expected)
        expect(charge.minimumApplied).toBe(rounded < 5)
        expect(charge.capped).toBe(Math.max(5, rounded) > reserved)
      }
    }
  })

  it('charges whole credits that pass for a count of credits', () => {
    const { credits } = taskCharge(work('16.895', 45))
    expect(Number.isInteger(credits)).toBe(true)
    expect(toCredits(credits)).toBe(17)
  })

  it('reads a Decimal of any decimal.js constructor, and a zero with a sign', () => {
    expect(taskCharge({ used: new Decimal('16.5'), reserved: toCredits(45) }).credits).toBe(17)
    expect(taskCharge({ used: new Money('-0'), reserved: toCredits(45) }).credits).toBe(5)
  })

  it('does not change its input', () => {
    const input = work('16.895', 45)
    taskCharge(input)
    expect(input.used.toFixed()).toBe('16.895')
    expect(input.reserved).toBe(45)
  })

  it.each<[string, unknown]>([
    ['negative work', { used: used('-0.01'), reserved: 45 }],
    ['work that is not a number', { used: new Money(Number.NaN), reserved: 45 }],
    ['infinite work', { used: new Money(Number.POSITIVE_INFINITY), reserved: 45 }],
    ['work as a number', { used: 16.895, reserved: 45 }],
    ['work as a string', { used: '16.895', reserved: 45 }],
    [
      'work as an object that prints a decimal',
      { used: { toFixed: () => '16.895' }, reserved: 45 },
    ],
    ['no work', { reserved: 45 }],
    ['no reserve', { used: used('16.895') }],
    ['a reserve of nothing', { used: used('16.895'), reserved: 0 }],
    ['a negative reserve', { used: used('16.895'), reserved: -45 }],
    ['a fraction of a reserve', { used: used('16.895'), reserved: 44.5 }],
    ['a reserve as a string', { used: used('16.895'), reserved: '45' }],
    ['a reserve as a Decimal', { used: used('16.895'), reserved: new Money(45) }],
    ['a reserve above the column', { used: used('16.895'), reserved: 1_000_000_000_000 }],
    ['an unknown field', { used: used('16.895'), reserved: 45, outcome: 'done' }],
    ['null', null],
    ['nothing', undefined],
  ])('refuses %s', (_name, input) => {
    expect(() => taskCharge(input as ChargedWork)).toThrow(badRequest)
  })
})

describe('chargeForOutcome', () => {
  const free = { credits: 0, minimumApplied: false, capped: false }

  it('knows the endings of a task: its terminal statuses', () => {
    expect(taskOutcomes).toEqual(['done', 'failed', 'rolled_back', 'cancelled'])
    expect([...taskOutcomes].sort()).toEqual([...terminalTaskStatuses].sort())
  })

  it.each([
    ['a small edit', '3.68', 45, 5, true, false],
    ['a new block', '16.895', 45, 17, false, false],
    ['an overrun of admitted calls', '49.5', 45, 45, false, true],
    ['a task continued once', '49.5', 90, 50, false, false],
  ] as const)(
    'charges a done task: %s',
    (_name, credits, reserved, charged, minimumApplied, capped) => {
      const ended = { outcome: 'done', ...work(credits, reserved) } as const
      expect(chargeForOutcome(ended)).toEqual({ credits: charged, minimumApplied, capped })
      expect(chargeForOutcome(ended)).toEqual(taskCharge(work(credits, reserved)))
    },
  )

  it.each(['failed', 'rolled_back', 'cancelled'] as const)(
    'charges nothing for a task that ended %s, whatever it spent',
    (outcome) => {
      // failed after 150 RUB of calls: 25 credits of work, none of them charged
      expect(chargeForOutcome({ outcome, ...work('25', 45) })).toEqual(free)
      // neither the minimum nor the cap is applied to it
      expect(chargeForOutcome({ outcome, ...work('0', 45) })).toEqual(free)
      expect(chargeForOutcome({ outcome, ...work('300', 45) })).toEqual(free)
      // and its work need not be known at all
      expect(chargeForOutcome({ outcome })).toEqual(free)
    },
  )

  it('charges exactly one ending', () => {
    const charged = taskOutcomes.filter(
      (outcome) => chargeForOutcome({ outcome, ...work('16.895', 45) }).credits > 0,
    )
    expect(charged).toEqual(['done'])
  })

  it('takes an ending that is known only when it happens', () => {
    for (const outcome of taskOutcomes) {
      const ended: TaskEnding = { outcome, ...work('16.895', 45) }
      expect(chargeForOutcome(ended).credits).toBe(outcome === 'done' ? 17 : 0)
    }
  })

  it('does not charge a done task whose work is not given', () => {
    expect(() => chargeForOutcome({ outcome: 'done' } as TaskEnding)).toThrow(badRequest)
    expect(() => chargeForOutcome({ outcome: 'done', used: used('3') } as TaskEnding)).toThrow(
      badRequest,
    )
    expect(() => chargeForOutcome({ outcome: 'done', ...work('3', 0) })).toThrow(badRequest)
  })

  it.each<[string, unknown]>([
    ['a task still running', { outcome: 'running', ...work('16.895', 45) }],
    ['a task that waits for an answer', { outcome: 'awaiting_user' }],
    ['a queued task', { outcome: 'queued' }],
    ['a status that does not exist', { outcome: 'refunded' }],
    ['a name every object has', { outcome: 'toString' }],
    ['an ending in capitals', { outcome: 'DONE', ...work('16.895', 45) }],
    ['an ending that is not text', { outcome: 1 }],
    ['no ending', { ...work('16.895', 45) }],
    ['null', null],
    ['nothing', undefined],
  ])('refuses %s', (_name, input) => {
    expect(() => chargeForOutcome(input as TaskEnding)).toThrow(badRequest)
    // refused as an ending, before its work is looked at
    expect(() => chargeForOutcome(input as TaskEnding)).toThrow('Invalid ending of a task')
  })
})

describe('customerBudgetLeftRub', () => {
  const left = (reserved: number, credits: string, rubPerCredit = K) =>
    customerBudgetLeftRub({ reserved: toCredits(reserved), used: used(credits), rubPerCredit })

  it.each([
    // max(0, reserved − used) × 6.00
    ['a whole step before any call', 45, '0', '270.0000000000'],
    ['a customer with 12 credits', 12, '0', '72.0000000000'],
    ['a block of 16.895 credits done under a step', 45, '16.895', '168.6300000000'],
    ['a chain of 45 + 5 that used 37', 50, '37', '78.0000000000'],
    ['a reserve used to the last credit', 45, '45', '0.0000000000'],
    ['calls already admitted ran over the reserve', 45, '49.5', '0.0000000000'],
    ['a task without a reserve', 0, '0', '0.0000000000'],
    ['a task without a reserve that worked', 0, '12.5', '0.0000000000'],
    ['one credit left', 45, '44', '6.0000000000'],
    ['a tenth of a credit left', 45, '44.9', '0.6000000000'],
  ])('%s: %i reserved, %s used → %s RUB', (_name, reserved, credits, expected) => {
    expect(left(reserved, credits)).toBe(expected)
  })

  it('follows the credit rate of now, not the one the reserve was placed under', () => {
    expect(left(45, '0', '6.00')).toBe('270.0000000000')
    expect(left(45, '0', '7.50')).toBe('337.5000000000')
    expect(left(45, '0', '5.98')).toBe('269.1000000000')
    expect(left(45, '16.895', '5.000000')).toBe('140.5250000000')
  })

  it('counts the work as it comes from the cost, not rounded', () => {
    // 22.09 RUB ÷ 6.00 = 3.6816… credits; 45 − 3.6816… = 41.3183…, × 6.00 = 247.91
    const spent = creditsFromCost([at('22.09')])
    expect(customerBudgetLeftRub({ reserved: toCredits(45), used: spent, rubPerCredit: K })).toBe(
      '247.9100000000',
    )
  })

  it('rounds down to the precision of a cost: the key gets no fraction the reserve does not hold', () => {
    // (1 − 0.55555) × 0.000007 = 0.00000311115: half up would say …112
    expect(left(1, '0.55555', '0.000007')).toBe('0.0000031111')
    // (1 − 0.3) × 0.000007 = 0.0000049 fits the ten decimals and is kept whole
    expect(left(1, '0.3', '0.000007')).toBe('0.0000049000')
    expect(left(1, '0.99999', '0.000001')).toBe('0.0000000000')
  })

  it('answers with a cost of the platform: eight integer digits at most', () => {
    expect(left(999_999, '0', '99.999999')).toBe('99999899.0000010000')
    expect(() => left(1_000_000, '0', '100')).toThrow(badRequest)
    expect(() => left(999_999_999_999, '0', '99999999.999999')).toThrow(badRequest)
  })

  it('does not change its input', () => {
    const input = { reserved: toCredits(45), used: used('16.895'), rubPerCredit: K }
    customerBudgetLeftRub(input)
    expect(input.used.toFixed()).toBe('16.895')
    expect(input).toMatchObject({ reserved: 45, rubPerCredit: '6.00' })
  })

  it.each<[string, unknown]>([
    ['a negative reserve', { reserved: -1, used: used('0'), rubPerCredit: K }],
    ['a fraction of a reserve', { reserved: 44.5, used: used('0'), rubPerCredit: K }],
    [
      'a reserve above the column',
      { reserved: 1_000_000_000_000, used: used('0'), rubPerCredit: K },
    ],
    // refused as a reserve, whatever the rate makes of it
    [
      'a reserve above the column at the smallest rate',
      { reserved: 1_000_000_000_000, used: used('0'), rubPerCredit: '0.000001' },
    ],
    ['negative work', { reserved: 45, used: used('-1'), rubPerCredit: K }],
    ['work as a number', { reserved: 45, used: 16.895, rubPerCredit: K }],
    ['work that is not a number', { reserved: 45, used: new Money(Number.NaN), rubPerCredit: K }],
    ['a rate of zero', { reserved: 45, used: used('0'), rubPerCredit: '0.00' }],
    ['a rate as a number', { reserved: 45, used: used('0'), rubPerCredit: 6 }],
    ['no rate', { reserved: 45, used: used('0') }],
    ['an unknown field', { reserved: 45, used: used('0'), rubPerCredit: K, step: 45 }],
    ['null', null],
  ])('refuses %s', (_name, input) => {
    expect(() => customerBudgetLeftRub(input as CustomerBudgetInput)).toThrow(badRequest)
  })
})

describe('unpaidWork', () => {
  const unpaid = (credits: string, charged: number) =>
    unpaidWork({ work: used(credits), charged: toCredits(charged) }).toFixed()

  it.each([
    // max(0, work − charged), in credits, not rounded
    ['nothing was done', '0', 0, '0'],
    ['everything done was charged above its work: the minimum', '3.68', 5, '0'],
    ['a block done and charged', '16.895', 17, '0'],
    ['a big task done and charged, rounded down', '29.45', 29, '0.45'],
    ['a failed attempt of 25 credits', '25', 0, '25'],
    ['a done block and a failed attempt', '41.895', 17, '24.895'],
    ['work in progress counts until it is charged', '37.2', 0, '37.2'],
    ['the bound of the gift, to the credit', '70', 0, '70'],
    ['a period of failures on a tariff', '320.5', 40, '280.5'],
    ['more charged than worked', '10', 300, '0'],
  ])('%s: %s of work, %i charged → %s', (_name, credits, charged, expected) => {
    expect(unpaid(credits, charged)).toBe(expected)
  })

  it('answers in the decimal arithmetic of money and never below zero', () => {
    const result = unpaidWork({ work: used('3.68'), charged: toCredits(5) })
    expect(result.constructor).toBe(Money)
    expect(result.isNegative()).toBe(false)
    expect(unpaidWork({ work: new Decimal('12.25'), charged: toCredits(2) }).constructor).toBe(
      Money,
    )
    expect(unpaidWork({ work: new Decimal('12.25'), charged: toCredits(2) }).toFixed()).toBe(
      '10.25',
    )
  })

  it('does not change its input', () => {
    const input = { work: used('41.895'), charged: toCredits(17) }
    unpaidWork(input)
    expect(input.work.toFixed()).toBe('41.895')
    expect(input.charged).toBe(17)
  })

  it.each<[string, unknown]>([
    ['negative work', { work: used('-1'), charged: 0 }],
    ['work as a number', { work: 41.895, charged: 0 }],
    ['work as a string', { work: '41.895', charged: 0 }],
    ['infinite work', { work: new Money(Number.POSITIVE_INFINITY), charged: 0 }],
    ['a negative charge', { work: used('41.895'), charged: -17 }],
    ['a fraction of a charge', { work: used('41.895'), charged: 16.895 }],
    ['a charge as a Decimal', { work: used('41.895'), charged: new Money(17) }],
    ['no charge', { work: used('41.895') }],
    ['an unknown field', { work: used('41.895'), charged: 17, limit: 300 }],
    ['null', null],
  ])('refuses %s', (_name, input) => {
    expect(() => unpaidWork(input as UnpaidWorkInput)).toThrow(badRequest)
  })
})
