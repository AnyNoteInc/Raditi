import { Decimal } from 'decimal.js'
import { describe, expect, it } from 'vitest'
import { Money } from '../money.ts'
import { terminalTaskStatuses } from '../tasks/task-status.ts'
import {
  chargeForOutcome,
  creditsFromCost,
  customerBudgetLeftRub,
  taskCharge,
  taskOutcomes,
  toCredits,
  type ChargedWork,
  type CostAtRate,
  type CustomerBudgetInput,
  type TaskEnding,
} from './credits.ts'

// The work of a task in credits and what it is charged. Every number of the tables below was
// computed by hand from the examples of the model: the credit rate K = 6.00 RUB of accounting
// cost in a credit, a pass charged its work rounded up (КР5–КР8).

const badRequest = expect.objectContaining({ name: 'DomainError', code: 'BAD_REQUEST' })
const K = '6.00'
const at = (costRub: string, rubPerCredit = K): CostAtRate => ({ costRub, rubPerCredit })
/** Unrounded credits written out, for a case that is about the charge alone. */
const used = (credits: string) => new Money(credits)

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
  // The worked examples of the model (owner's decision of 10.11.2026, КР5–КР8): the work of a
  // pass rounded up to a whole credit — no minimum and no cap of the reserve.
  it.each([
    ['a small edit', [at('22.09')], 4],
    ['a new block', [at('101.37')], 17],
    ['a big task', [at('176.70')], 30],
    ['the same block after one clarification', [at('126.71')], 22],
    ['three small edits in one message', [at('66.26')], 12],
    ['done, and its only calls were estimates by the fault of the platform', [], 0],
    ['calls already admitted ran to 297 RUB: more than any reserve', [at('297.00')], 50],
    ['continued once', [at('225.00'), at('72.00')], 50],
    // the rate changed in the middle: 8.33 + 10.27 = 18.61
    ['work across a change of the rate', [at('50.00', '6.00'), at('51.37', '5.00')], 19],
    // three attempts of 14, 14 and 17 RUB: 7.5 credits
    ['thirds and sixths that make a half', [at('14.00'), at('14.00'), at('17.00')], 8],
  ] as const)('%s', (_name, sums, credits) => {
    expect(taskCharge({ used: creditsFromCost(sums) })).toEqual({ credits })
  })

  // 110.63 RUB at a rate of 5.98 is exactly 18.5 credits: 5.98 × 18.5 = 110.63. Binary floating
  // point makes it 18.499999999999996; rounded up in decimals it is 19 either way, and a hair
  // above a whole number must not round up by an error of Number.
  it('rounds up in decimals, not in Number', () => {
    const inDecimal = creditsFromCost([at('110.63', '5.98')])
    expect(inDecimal.toFixed()).toBe('18.5')
    expect(taskCharge({ used: inDecimal }).credits).toBe(19)
    // 16.74 + 34.16 + 0.10 = 51.00 RUB, exactly 8.5 credits; 60.00 RUB, exactly 10
    expect(
      taskCharge({ used: creditsFromCost(['16.74', '34.16', '0.10'].map((cost) => at(cost))) }),
    ).toEqual({ credits: 9 })
    expect(taskCharge({ used: creditsFromCost([at('60.00')]) })).toEqual({ credits: 10 })
  })

  it.each([
    ['no work at all', '0', 0],
    ['the smallest work', '0.0000000001', 1],
    ['work under a credit', '0.4', 1],
    ['a whole number', '16', 16],
    ['just over a whole number', '16.0000000001', 17],
    ['just under a half', '16.4999999999', 17],
    ['exactly a half', '16.5', 17],
    ['just under a whole number', '16.9999999999', 17],
    ['work far above any reserve', '1000000', 1_000_000],
    ['the largest count of the column', '999999999998.5', 999_999_999_999],
  ] as const)('%s: %s credits → %i', (_name, credits, charged) => {
    expect(taskCharge({ used: used(credits) })).toEqual({ credits: charged })
  })

  it('is the work rounded up for every quarter of a credit', () => {
    for (let quarters = 0; quarters <= 400; quarters++) {
      const charge = taskCharge({ used: new Money(quarters).div(4) })
      expect(charge).toEqual({ credits: Math.ceil(quarters / 4) })
    }
  })

  it('charges whole credits that pass for a count of credits', () => {
    const { credits } = taskCharge({ used: used('16.895') })
    expect(Number.isInteger(credits)).toBe(true)
    expect(toCredits(credits)).toBe(17)
  })

  it('reads a Decimal of any decimal.js constructor, and a zero with a sign', () => {
    expect(taskCharge({ used: new Decimal('16.5') }).credits).toBe(17)
    expect(taskCharge({ used: new Money('-0') }).credits).toBe(0)
  })

  it('does not change its input', () => {
    const input = { used: used('16.895') }
    taskCharge(input)
    expect(input.used.toFixed()).toBe('16.895')
  })

  it.each<[string, unknown]>([
    ['negative work', { used: used('-0.01') }],
    ['work that is not a number', { used: new Money(Number.NaN) }],
    ['infinite work', { used: new Money(Number.POSITIVE_INFINITY) }],
    ['work as a number', { used: 16.895 }],
    ['work as a string', { used: '16.895' }],
    ['work as an object that prints a decimal', { used: { toFixed: () => '16.895' } }],
    ['no work', {}],
    ['a reserve, which no longer bounds the charge', { used: used('16.895'), reserved: 45 }],
    ['the minimum, which is gone', { used: used('16.895'), minimum: true }],
    ['null', null],
    ['nothing', undefined],
  ])('refuses %s', (_name, input) => {
    expect(() => taskCharge(input as ChargedWork)).toThrow(badRequest)
  })
})

describe('chargeForOutcome', () => {
  const free = { credits: 0 }

  it('knows the endings of a task: its terminal statuses', () => {
    expect(taskOutcomes).toEqual(['done', 'failed', 'rolled_back', 'cancelled'])
    expect([...taskOutcomes].sort()).toEqual([...terminalTaskStatuses].sort())
  })

  it.each([
    ['a small edit', '3.68', 4],
    ['a new block', '16.895', 17],
    ['work above any reserve', '49.5', 50],
  ] as const)('charges a done task: %s', (_name, credits, charged) => {
    const ended = { outcome: 'done', used: used(credits) } as const
    expect(chargeForOutcome(ended)).toEqual({ credits: charged })
    expect(chargeForOutcome(ended)).toEqual(taskCharge({ used: used(credits) }))
  })

  it.each(['failed', 'rolled_back', 'cancelled'] as const)(
    'charges nothing for a task that ended %s, whatever it spent',
    (outcome) => {
      // failed after 150 RUB of calls: 25 credits of work, none of them charged
      expect(chargeForOutcome({ outcome, used: used('25') })).toEqual(free)
      expect(chargeForOutcome({ outcome, used: used('300') })).toEqual(free)
      // and its work need not be known at all
      expect(chargeForOutcome({ outcome })).toEqual(free)
    },
  )

  it('charges exactly one ending', () => {
    const charged = taskOutcomes.filter(
      (outcome) => chargeForOutcome({ outcome, used: used('16.895') }).credits > 0,
    )
    expect(charged).toEqual(['done'])
  })

  it('takes an ending that is known only when it happens', () => {
    for (const outcome of taskOutcomes) {
      const ended: TaskEnding = { outcome, used: used('16.895') }
      expect(chargeForOutcome(ended).credits).toBe(outcome === 'done' ? 17 : 0)
    }
  })

  it('does not charge a done task whose work is not given', () => {
    expect(() => chargeForOutcome({ outcome: 'done' } as TaskEnding)).toThrow(badRequest)
  })

  it.each<[string, unknown]>([
    ['a task still running', { outcome: 'running', used: used('16.895') }],
    ['a task that waits for an answer', { outcome: 'awaiting_user' }],
    ['a queued task', { outcome: 'queued' }],
    ['a status that does not exist', { outcome: 'refunded' }],
    ['a name every object has', { outcome: 'toString' }],
    ['an ending in capitals', { outcome: 'DONE', used: used('16.895') }],
    ['an ending that is not text', { outcome: 1 }],
    ['no ending', { used: used('16.895') }],
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
