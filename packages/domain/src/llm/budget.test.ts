import { describe, expect, it } from 'vitest'
import type { CallUsage } from '../ports/llm-backend.ts'
import {
  attemptBudgetRub,
  callCacheShare,
  callFitsBudget,
  callReserveRub,
  estimatedCacheReadTokens,
  firstCallReserveRub,
  turnKeyBudgetVerdict,
  type AttemptBudgetInput,
  type TurnKeyBudgetInput,
} from './budget.ts'
import { llmCallCostRub, type LlmModelPrices } from './cost.ts'

// Synthetic accounting rates for arithmetic tests only.
const prices: LlmModelPrices = {
  inputPer1m: '200',
  cacheReadPer1m: '20',
  cacheWritePer1m: '250',
  outputPer1m: '1000',
}
const noUsage: CallUsage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 }
const noSpend = { spentRub: '0', openReservedRub: '0' }
const quota = { kind: 'quota', modelClass: 'standard', ...noSpend } as const
const payg = {
  kind: 'payg',
  holdRub: '600.00',
  feeRub: '30.00',
  markup: '2.0000',
  ...noSpend,
} as const

describe('attemptBudgetRub', () => {
  it.each([
    ['light', '135.00'],
    ['standard', '285.00'],
    ['heavy', '735.00'],
  ] as const)('uses the quota ceiling for %s', (modelClass, expected) => {
    expect(attemptBudgetRub({ ...quota, modelClass })).toBe(expected)
  })

  it.each([
    ['300.00', '135.00'],
    ['600.00', '285.00'],
    ['1500.00', '735.00'],
  ])('derives the payg budget from hold %s, fee and markup', (holdRub, expected) => {
    expect(attemptBudgetRub({ ...payg, holdRub })).toBe(expected)
  })

  it('deducts settled costs and open reserves from all keys of the attempt', () => {
    for (const input of [quota, payg]) {
      expect(
        attemptBudgetRub({
          ...input,
          spentRub: '100.1234567890',
          openReservedRub: '20.0065432110',
        }),
      ).toBe('164.87')
      expect(attemptBudgetRub({ ...input, spentRub: '284.9999999999' })).toBe('0.00')
    }
  })

  it('rounds repeating division and fractional remaining amounts down, never up', () => {
    expect(attemptBudgetRub({ ...payg, holdRub: '31', markup: '3' })).toBe('0.33')
    expect(attemptBudgetRub({ ...quota, spentRub: '0.0000000001' })).toBe('284.99')
  })

  it('caps the remaining budget, after spending, at 750 RUB', () => {
    expect(attemptBudgetRub({ ...payg, holdRub: '2030' })).toBe('750.00')
    expect(attemptBudgetRub({ ...payg, holdRub: '2030', spentRub: '300' })).toBe('700.00')
  })

  it('returns zero when spending or the fee exhausts the available ceiling', () => {
    expect(attemptBudgetRub({ ...quota, spentRub: '285' })).toBe('0.00')
    expect(attemptBudgetRub({ ...quota, spentRub: '300' })).toBe('0.00')
    expect(attemptBudgetRub({ ...payg, openReservedRub: '300' })).toBe('0.00')
    expect(attemptBudgetRub({ ...payg, holdRub: '20' })).toBe('0.00')
  })

  it.each([
    { spentRub: '-1' },
    { spentRub: 1 },
    { spentRub: '1e2' },
    { openReservedRub: '100000000' },
    { spentRub: '0.00000000001' },
    { holdRub: '1000000000000' },
    { holdRub: '1.001' },
    { feeRub: '-1' },
    { markup: '0' },
    { markup: '0.0000' },
    { markup: '-1' },
    { markup: '1.00001' },
    { markup: 'secret-value' },
    { markup: '1\n' },
    { markup: '10000' },
    { kind: 'unsupported' },
    { unexpected: 'secret-value' },
  ])('rejects invalid budgets without exposing their values: %o', (change) => {
    expect(() => attemptBudgetRub({ ...payg, ...change } as AttemptBudgetInput)).toThrow(
      expect.objectContaining({
        name: 'DomainError',
        code: 'BAD_REQUEST',
        message: 'Invalid LLM attempt budget',
      }),
    )
  })

  it('rejects removed or unknown model classes', () => {
    expect(() => attemptBudgetRub({ ...quota, modelClass: 'service' } as never)).toThrow(
      'Invalid LLM attempt budget',
    )
  })
})

describe('callReserveRub', () => {
  const reserve = {
    estimatedInputTokens: 100_000,
    reserveOutputTokens: 32_000,
    lastCompletedUsage: null,
  }

  it('divides per-million rates and uses no cache discount for a new attempt', () => {
    expect(callReserveRub(reserve, prices)).toBe('52.0000000000')
    expect(firstCallReserveRub(32_000, prices)).toBe('40.0000000000')
    expect(firstCallReserveRub(32_768, prices)).toBe('40.7680000000')
  })

  it('uses the last completed attempt usage across keys and caps the cache share at 90%', () => {
    const lastCompletedUsage = { ...noUsage, input: 100_000, cacheRead: 80_000 }
    expect(callReserveRub({ ...reserve, lastCompletedUsage }, prices)).toBe('37.6000000000')
    expect(
      callReserveRub(
        { ...reserve, lastCompletedUsage: { ...lastCompletedUsage, cacheRead: 100_000 } },
        prices,
      ),
    ).toBe('35.8000000000')
  })

  it('uses only cache reads for the ratio; zero total input gives no cache discount', () => {
    expect(
      callReserveRub(
        { ...reserve, lastCompletedUsage: { ...noUsage, input: 100_000, cacheWrite: 100_000 } },
        prices,
      ),
    ).toBe('52.0000000000')
    expect(callReserveRub({ ...reserve, lastCompletedUsage: noUsage }, prices)).toBe(
      '52.0000000000',
    )
  })

  it('preserves null fallback and explicit zero cache prices in reserves', () => {
    const input = {
      ...reserve,
      lastCompletedUsage: { ...noUsage, input: 100_000, cacheRead: 80_000 },
    }
    expect(callReserveRub(input, { ...prices, cacheReadPer1m: null })).toBe('52.0000000000')
    expect(callReserveRub(input, { ...prices, cacheReadPer1m: '0' })).toBe('36.0000000000')
  })

  it('keeps fractional cache ratios in decimal arithmetic', () => {
    const input = {
      estimatedInputTokens: 1,
      reserveOutputTokens: 1024,
      lastCompletedUsage: { ...noUsage, input: 3, cacheRead: 1 },
    }
    expect(
      callReserveRub(input, { ...prices, inputPer1m: '1', cacheReadPer1m: '0', outputPer1m: '0' }),
    ).toBe('0.0000006667')
  })

  it('requires approved prices and storable results', () => {
    expect(() => firstCallReserveRub(32_000, null)).toThrow(
      expect.objectContaining({ code: 'LLM_PRICE_MISSING' }),
    )
    expect(() =>
      callReserveRub({ ...reserve, estimatedInputTokens: Number.MAX_SAFE_INTEGER }, prices),
    ).toThrow('LLM cost exceeds its supported range')
  })

  it('accepts both output reserve limits from the model catalog', () => {
    expect(firstCallReserveRub(1024, prices)).toBe('9.0240000000')
    expect(firstCallReserveRub(131_072, prices)).toBe('139.0720000000')
  })

  it.each([
    { estimatedInputTokens: -1 },
    { estimatedInputTokens: 0.1 },
    { estimatedInputTokens: Number.MAX_SAFE_INTEGER + 1 },
    { reserveOutputTokens: 0 },
    { reserveOutputTokens: 1023 },
    { reserveOutputTokens: 131_073 },
    { reserveOutputTokens: Number.NaN },
    { reserveOutputTokens: Number.POSITIVE_INFINITY },
    { lastCompletedUsage: { ...noUsage, cacheRead: 1 } },
    { lastCompletedUsage: { ...noUsage, reasoning: 1 } },
    { lastCompletedUsage: undefined },
  ])('rejects invalid reserve inputs: %o', (change) => {
    expect(() => callReserveRub({ ...reserve, ...change } as never, prices)).toThrow(
      'Invalid LLM call reserve',
    )
  })
})

describe('the cache share of estimates', () => {
  const cached = (cacheRead: number, input = 100_000): CallUsage => ({
    ...noUsage,
    input,
    cacheRead,
  })
  const estimate = (input: number, cacheRead: number, rates: LlmModelPrices) =>
    llmCallCostRub({ input, cacheRead, cacheWrite: 0, output: 32_000, reasoning: 0 }, rates)

  it('is the share of the last completed call of the attempt, at most 0.9', () => {
    expect(callCacheShare(null)).toBe('0')
    expect(callCacheShare(noUsage)).toBe('0')
    expect(callCacheShare(cached(80_000))).toBe('0.8')
    expect(callCacheShare(cached(95_000))).toBe('0.9')
    expect(callCacheShare({ ...noUsage, input: 100_000, cacheWrite: 100_000 })).toBe('0')
  })

  it('prices an estimated input like its reserve, never above it', () => {
    // Rates of the lens repro: 150k tokens of context after a call with 95 % cache.
    const rates: LlmModelPrices = {
      inputPer1m: '230',
      cacheReadPer1m: '23',
      cacheWritePer1m: null,
      outputPer1m: '1150',
    }
    const input = { estimatedInputTokens: 150_000, lastCompletedUsage: cached(95_000) }
    const cacheRead = estimatedCacheReadTokens(input, rates)
    expect(cacheRead).toBe(135_000)
    const reserve = callReserveRub({ ...input, reserveOutputTokens: 32_000 }, rates)
    expect(reserve).toBe('43.3550000000')
    expect(estimate(150_000, cacheRead, rates)).toBe(reserve)
    expect(estimate(150_000, 0, rates)).toBe('71.3000000000')
  })

  it('gives no cache share to a first call or a zero estimate', () => {
    expect(
      estimatedCacheReadTokens({ estimatedInputTokens: 40_000, lastCompletedUsage: null }, prices),
    ).toBe(0)
    expect(
      estimatedCacheReadTokens(
        { estimatedInputTokens: 0, lastCompletedUsage: cached(90_000) },
        prices,
      ),
    ).toBe(0)
  })

  it.each([
    ['a cheaper cache rate rounds the cached part up', '20', 1, 34],
    ['a missing cache rate costs the same either way', null, 1, 34],
    ['a dearer cache rate rounds the cached part down', '300', 0, 33],
  ] as const)('%s', (_name, cacheReadPer1m, one, hundred) => {
    const rates = { ...prices, cacheReadPer1m }
    const lastCompletedUsage = cached(1, 3)
    for (const [estimatedInputTokens, expected] of [
      [1, one],
      [100, hundred],
    ] as const) {
      const cacheRead = estimatedCacheReadTokens(
        { estimatedInputTokens, lastCompletedUsage },
        rates,
      )
      expect(cacheRead).toBe(expected)
      expect(cacheRead).toBeLessThanOrEqual(estimatedInputTokens)
      const reserve = callReserveRub(
        { estimatedInputTokens, reserveOutputTokens: 32_000, lastCompletedUsage },
        rates,
      )
      expect(Number(estimate(estimatedInputTokens, cacheRead, rates))).toBeLessThanOrEqual(
        Number(reserve),
      )
    }
  })

  it('requires approved prices and valid inputs', () => {
    const input = { estimatedInputTokens: 1_000, lastCompletedUsage: cached(50_000) }
    expect(() => estimatedCacheReadTokens(input, null)).toThrow(
      expect.objectContaining({ code: 'LLM_PRICE_MISSING' }),
    )
    expect(() => estimatedCacheReadTokens({ ...input, estimatedInputTokens: -1 }, prices)).toThrow(
      'Invalid LLM call reserve',
    )
    expect(() => callCacheShare({ ...noUsage, cacheRead: 1 })).toThrow('Invalid LLM call reserve')
  })
})

describe('callFitsBudget', () => {
  it('admits an exact fit and rejects an excess of 0.0000000001 RUB without float arithmetic', () => {
    const input = {
      budgetRub: '100',
      spentRub: '30.0000000001',
      openReservedRub: '20.0000000002',
      reserveRub: '49.9999999997',
    }
    expect(callFitsBudget(input)).toBe(true)
    expect(callFitsBudget({ ...input, reserveRub: '49.9999999998' })).toBe(false)
  })

  it('checks the first-call threshold, rejects zero budgets and permits a zero cost with positive budget', () => {
    const reserveRub = firstCallReserveRub(32_000, prices)
    expect(callFitsBudget({ budgetRub: '40.00', ...noSpend, reserveRub })).toBe(true)
    expect(callFitsBudget({ budgetRub: '39.99', ...noSpend, reserveRub })).toBe(false)
    expect(callFitsBudget({ budgetRub: '0', ...noSpend, reserveRub: '0' })).toBe(false)
    expect(callFitsBudget({ budgetRub: '0.01', ...noSpend, reserveRub: '0' })).toBe(true)
  })

  it('counts an existing concurrent call and refuses further calls after overspend', () => {
    expect(
      callFitsBudget({ budgetRub: '100', spentRub: '20', openReservedRub: '50', reserveRub: '40' }),
    ).toBe(false)
    expect(
      callFitsBudget({ budgetRub: '100', spentRub: '101', openReservedRub: '0', reserveRub: '0' }),
    ).toBe(false)
  })

  it.each([
    { budgetRub: '750.01' },
    { budgetRub: '-1' },
    { spentRub: 'NaN' },
    { openReservedRub: 'secret-value' },
    { reserveRub: '1e2' },
    { reserveRub: '1\n' },
  ])('rejects invalid admission amounts safely: %o', (change) => {
    expect(() =>
      callFitsBudget({ budgetRub: '100', ...noSpend, reserveRub: '40', ...change }),
    ).toThrow(
      expect.objectContaining({
        name: 'DomainError',
        code: 'BAD_REQUEST',
        message: 'Invalid LLM call budget',
      }),
    )
  })
})

describe('turnKeyBudgetVerdict', () => {
  // The first call reserves exactly 40 RUB at these rates: 40,000 input and 32,000 output tokens.
  const key = (change: Partial<TurnKeyBudgetInput> = {}): TurnKeyBudgetInput => ({
    budgetRub: '285.00',
    attempt: quota,
    reserveOutputTokens: 32_000,
    ...change,
  })

  it.each([
    ['light', '135.00', '135.01'],
    ['standard', '285.00', '285.01'],
    ['heavy', '735.00', '735.01'],
  ] as const)('bounds a %s key on a quota plan by its class ceiling', (modelClass, top, above) => {
    const attempt = { ...quota, modelClass }
    expect(turnKeyBudgetVerdict(key({ attempt, budgetRub: top }), prices)).toBe('ok')
    expect(turnKeyBudgetVerdict(key({ attempt, budgetRub: above }), prices)).toBe('above_ceiling')
    expect(turnKeyBudgetVerdict(key({ attempt, budgetRub: '750.00' }), prices)).toBe(
      'above_ceiling',
    )
  })

  it('requires the budget to admit the first call, to the kopeck', () => {
    expect(turnKeyBudgetVerdict(key({ budgetRub: '40.00' }), prices)).toBe('ok')
    for (const budgetRub of ['39.99', '3.00', '0.01', '0.00', '0'])
      expect(turnKeyBudgetVerdict(key({ budgetRub }), prices)).toBe('below_first_call')
  })

  it('takes the first-call reserve from the model output reserve and its rates', () => {
    const large = key({ attempt: { ...quota, modelClass: 'light' }, budgetRub: '135.00' })
    expect(turnKeyBudgetVerdict(large, prices)).toBe('ok')
    expect(turnKeyBudgetVerdict({ ...large, reserveOutputTokens: 131_072 }, prices)).toBe(
      'below_first_call',
    )
    // 8 RUB of input plus 32,000 output tokens at 3,968.75 RUB per million is exactly 135 RUB.
    expect(turnKeyBudgetVerdict(large, { ...prices, outputPer1m: '3968.75' })).toBe('ok')
    expect(turnKeyBudgetVerdict(large, { ...prices, outputPer1m: '3968.750001' })).toBe(
      'below_first_call',
    )
  })

  it('lowers the ceiling by the spend and open reserves the caller supplies for the attempt', () => {
    const attempt = { ...quota, spentRub: '100.1234567890', openReservedRub: '20.0065432110' }
    expect(turnKeyBudgetVerdict(key({ attempt, budgetRub: '164.87' }), prices)).toBe('ok')
    expect(turnKeyBudgetVerdict(key({ attempt, budgetRub: '164.88' }), prices)).toBe(
      'above_ceiling',
    )
    const exhausted = { ...quota, spentRub: '285' }
    expect(turnKeyBudgetVerdict(key({ attempt: exhausted, budgetRub: '0.01' }), prices)).toBe(
      'above_ceiling',
    )
  })

  it('derives the payg ceiling from the hold, so a topped-up hold may exceed the class ceiling', () => {
    expect(turnKeyBudgetVerdict(key({ attempt: payg, budgetRub: '285.00' }), prices)).toBe('ok')
    expect(turnKeyBudgetVerdict(key({ attempt: payg, budgetRub: '285.01' }), prices)).toBe(
      'above_ceiling',
    )
    const toppedUp = { ...payg, holdRub: '1200.00' }
    expect(turnKeyBudgetVerdict(key({ attempt: toppedUp, budgetRub: '585.00' }), prices)).toBe('ok')
    expect(turnKeyBudgetVerdict(key({ attempt: toppedUp, budgetRub: '585.01' }), prices)).toBe(
      'above_ceiling',
    )
  })

  it('never lets any key exceed 750 RUB and reports it as a verdict, not as invalid input', () => {
    const attempt = { ...payg, holdRub: '2030' }
    expect(turnKeyBudgetVerdict(key({ attempt, budgetRub: '750.00' }), prices)).toBe('ok')
    for (const budgetRub of ['750.01', '751', '99999999'])
      expect(turnKeyBudgetVerdict(key({ attempt, budgetRub }), prices)).toBe('above_ceiling')
  })

  it.each([
    [quota, '285.00', 'ok'],
    [payg, '285.00', 'ok'],
    [{ ...quota, modelClass: 'light', spentRub: '94.999' }, '40.00', 'ok'],
    [{ ...quota, modelClass: 'light', spentRub: '95.001' }, '39.99', 'below_first_call'],
    [{ ...quota, spentRub: '285' }, '0.00', 'below_first_call'],
    [{ ...payg, holdRub: '20' }, '0.00', 'below_first_call'],
    [{ ...payg, holdRub: '2030', spentRub: '300' }, '700.00', 'ok'],
  ] as const)(
    'issues or defers the budget attemptBudgetRub computes, never calls it excessive: %o',
    (attempt, budgetRub, verdict) => {
      expect(attemptBudgetRub(attempt)).toBe(budgetRub)
      expect(turnKeyBudgetVerdict(key({ attempt, budgetRub }), prices)).toBe(verdict)
    },
  )

  it('admits a free first call only with a positive budget', () => {
    const free = { ...prices, inputPer1m: '0', outputPer1m: '0' }
    expect(turnKeyBudgetVerdict(key({ budgetRub: '0.01' }), free)).toBe('ok')
    expect(turnKeyBudgetVerdict(key({ budgetRub: '0.00' }), free)).toBe('below_first_call')
  })

  it('issues no verdict without an approved rate', () => {
    for (const budgetRub of ['285.00', '750.00', '0.01'])
      for (const missing of [null, undefined])
        expect(() => turnKeyBudgetVerdict(key({ budgetRub }), missing)).toThrow(
          expect.objectContaining({ code: 'LLM_PRICE_MISSING' }),
        )
  })

  it.each([
    { budgetRub: '-1' },
    { budgetRub: 285 },
    { budgetRub: '1e2' },
    { budgetRub: 'NaN' },
    { budgetRub: 'secret-value' },
    { budgetRub: '285.00\n' },
    { budgetRub: '100000000' },
    { reserveOutputTokens: 1023 },
    { reserveOutputTokens: 131_073 },
    { reserveOutputTokens: Number.NaN },
    { attempt: { ...quota, modelClass: 'service' } },
    { attempt: { ...quota, spentRub: '-1' } },
    { attempt: { kind: 'quota', modelClass: 'standard' } },
    { attempt: { ...payg, kind: 'unsupported' } },
    { attempt: undefined },
    { unexpected: 'secret-value' },
  ])('rejects invalid input without exposing its values: %o', (change) => {
    expect(() => turnKeyBudgetVerdict({ ...key(), ...change } as never, prices)).toThrow(
      expect.objectContaining({
        name: 'DomainError',
        code: 'BAD_REQUEST',
        message: 'Invalid turn key budget',
      }),
    )
  })

  it('rejects a non-positive payg markup like attemptBudgetRub does', () => {
    expect(() => turnKeyBudgetVerdict(key({ attempt: { ...payg, markup: '0' } }), prices)).toThrow(
      expect.objectContaining({ code: 'BAD_REQUEST' }),
    )
  })
})
