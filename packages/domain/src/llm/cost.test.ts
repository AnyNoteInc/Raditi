import { Decimal } from 'decimal.js'
import { describe, expect, it } from 'vitest'
import { DomainError } from '../errors.ts'
import type { CallUsage } from '../ports/llm-backend.ts'
import { llmCallCostRub, type LlmModelPrices } from './cost.ts'

const noUsage: CallUsage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 }
// Historical vectors from p3-litellm-design §5.4, not live subscription rates.
const historicalKimiPrices: LlmModelPrices = {
  inputPer1m: '175.680000',
  cacheReadPer1m: null,
  cacheWritePer1m: null,
  outputPer1m: '725.900000',
}
const historicalQwenPrices: LlmModelPrices = {
  inputPer1m: '200.000000',
  cacheReadPer1m: '50.000000',
  cacheWritePer1m: null,
  outputPer1m: '300.000000',
}

describe('llmCallCostRub', () => {
  it('matches the historical Kimi and Qwen cost vectors', () => {
    expect(
      llmCallCostRub({ ...noUsage, input: 100_000, output: 2_000 }, historicalKimiPrices),
    ).toBe('19.0198000000')
    expect(
      llmCallCostRub(
        { ...noUsage, input: 250_000, cacheRead: 200_000, output: 5_000 },
        historicalQwenPrices,
      ),
    ).toBe('21.5000000000')
  })

  it('charges cache reads, cache writes and uncached input once, with reasoning inside output', () => {
    const usage = {
      input: 1_000_000,
      cacheRead: 600_000,
      cacheWrite: 300_000,
      output: 10_000,
      reasoning: 10_000,
    }
    const prices = { ...historicalQwenPrices, cacheWritePer1m: '250' }
    expect(llmCallCostRub(usage, prices)).toBe('128.0000000000')
    expect(llmCallCostRub({ ...usage, reasoning: 0 }, prices)).toBe('128.0000000000')
  })

  it('uses the input rate for null cache rates and preserves an explicit zero rate', () => {
    const usage = { ...noUsage, input: 1_000_000, cacheRead: 600_000, cacheWrite: 400_000 }
    expect(llmCallCostRub(usage, historicalKimiPrices)).toBe('175.6800000000')
    expect(
      llmCallCostRub(usage, { ...historicalKimiPrices, cacheReadPer1m: '0', cacheWritePer1m: '0' }),
    ).toBe('0.0000000000')
  })

  it.each([
    ['0.000049', '0.0000000000'],
    ['0.000050', '0.0000000001'],
    ['0.000150', '0.0000000002'],
  ])('rounds rate %s HALF_UP to ten decimal places', (inputPer1m, expected) => {
    expect(llmCallCostRub({ ...noUsage, input: 1 }, { ...historicalKimiPrices, inputPer1m })).toBe(
      expected,
    )
  })

  it('returns fixed decimal zero and accepts the highest storable price', () => {
    expect(llmCallCostRub(noUsage, historicalKimiPrices)).toBe('0.0000000000')
    expect(
      llmCallCostRub(
        { ...noUsage, input: 1_000_000 },
        { ...historicalKimiPrices, inputPer1m: '99999999.999999' },
      ),
    ).toBe('99999999.9999990000')
  })

  it('rejects a result that does not fit Decimal(18,10)', () => {
    expect(() =>
      llmCallCostRub({ ...noUsage, input: Number.MAX_SAFE_INTEGER }, historicalKimiPrices),
    ).toThrow(expect.objectContaining({ name: 'DomainError', code: 'BAD_REQUEST' }))
  })

  it('isolates its decimal precision from unrelated code', () => {
    const previous = { precision: Decimal.precision, rounding: Decimal.rounding }
    try {
      Decimal.set({ precision: 2, rounding: Decimal.ROUND_DOWN })
      expect(
        llmCallCostRub({ ...noUsage, input: 100_000, output: 2_000 }, historicalKimiPrices),
      ).toBe('19.0198000000')
    } finally {
      Decimal.set(previous)
    }
  })

  it.each([null, undefined])('rejects missing prices (%s), even for zero usage', (prices) => {
    expect(() => llmCallCostRub(noUsage, prices)).toThrow(
      expect.objectContaining({ name: 'DomainError', code: 'LLM_PRICE_MISSING' }),
    )
  })

  it.each([
    { input: -1 },
    { input: 1.5 },
    { cacheRead: Number.NaN },
    { cacheWrite: Number.POSITIVE_INFINITY },
    { output: Number.MAX_SAFE_INTEGER + 1 },
    { reasoning: 1 },
    { input: 5, cacheRead: 3, cacheWrite: 3 },
    { input: Number.MAX_SAFE_INTEGER, cacheRead: Number.MAX_SAFE_INTEGER, cacheWrite: 1 },
    { input: 'secret-value' },
    { model: 'secret-value' },
  ])('rejects invalid or inconsistent usage without exposing it: %o', (change) => {
    expect(() =>
      llmCallCostRub({ ...noUsage, ...change } as CallUsage, historicalKimiPrices),
    ).toThrow('Invalid LLM call usage')
  })

  it.each([
    '-1',
    'NaN',
    'Infinity',
    '1e2',
    '0x10',
    '1\n',
    ' 1',
    '1 ',
    '+1',
    '.1',
    '1.',
    '100000000',
    '1.0000001',
    '',
    'secret-value',
    1,
    null,
  ])('rejects invalid prices without leaking raw values: %j', (inputPer1m) => {
    const prices = { ...historicalKimiPrices, inputPer1m } as LlmModelPrices
    try {
      llmCallCostRub(noUsage, prices)
      expect.fail('Expected invalid prices to be rejected')
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError)
      expect(error).toMatchObject({ code: 'BAD_REQUEST', message: 'Invalid LLM model prices' })
      expect((error as DomainError).details).toBeUndefined()
    }
  })

  it('validates every rate even when its token partition is unused', () => {
    for (const field of ['inputPer1m', 'cacheReadPer1m', 'cacheWritePer1m', 'outputPer1m']) {
      expect(() => llmCallCostRub(noUsage, { ...historicalKimiPrices, [field]: '-1' })).toThrow(
        'Invalid LLM model prices',
      )
    }
    expect(() =>
      llmCallCostRub(noUsage, { ...historicalKimiPrices, cacheReadPer1m: undefined } as never),
    ).toThrow('Invalid LLM model prices')
  })
})
