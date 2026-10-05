import { callUsageSchema, parseLlmJson, type LlmBackend, type MeterResult } from '@repo/domain'

export type UsageMeter = ReturnType<LlmBackend['usageMeter']>

export const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const encoder = new TextEncoder()

/** Structural JSON limits are shared with request validation; parser errors never escape. */
export function parseEvent(data: string): Record<string, unknown> | null {
  try {
    return parseLlmJson(encoder.encode(data))
  } catch {
    return null
  }
}

export const emptyMeterResult = (): MeterResult => ({
  usage: null,
  outcome: 'incomplete',
  signal: null,
  usageIssue: 'no_usage',
  deltaTextBytes: 0,
})

export function setUsage(result: MeterResult, candidate: unknown, mapped: unknown): void {
  if (candidate === undefined || candidate === null) {
    result.usage = null
    result.usageIssue = 'no_usage'
    return
  }
  const parsed = callUsageSchema.safeParse(mapped)
  result.usage = parsed.success ? parsed.data : null
  result.usageIssue = parsed.success ? null : 'invalid_usage'
}

/** Missing optional counters are zero; supplied null/string/negative counters stay invalid. */
export const optionalCount = (value: unknown): unknown => (value === undefined ? 0 : value)

export function addDelta(result: MeterResult, value: unknown): void {
  if (typeof value !== 'string') return
  const total = result.deltaTextBytes + encoder.encode(value).byteLength
  if (!Number.isSafeInteger(total)) throw new RangeError('Upstream delta byte count overflow')
  result.deltaTextBytes = total
}

export function copyResult(result: MeterResult): MeterResult {
  return {
    ...result,
    usage: result.usage === null ? null : { ...result.usage },
    signal: result.signal === null ? null : { ...result.signal },
  }
}
