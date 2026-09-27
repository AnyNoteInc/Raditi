import { describe, expect, it } from 'vitest'

import {
  bearerTokenMatches,
  createMetricsRegistry,
  DEV_METRICS_TOKEN,
  metricsTokenProblem,
  MIN_METRICS_TOKEN_LENGTH,
} from './metrics.ts'

const TOKEN = 's3cret-token'

describe('bearerTokenMatches', () => {
  it('accepts the exact bearer token', () => {
    expect(bearerTokenMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true)
    expect(bearerTokenMatches(`bearer ${TOKEN}`, TOKEN)).toBe(true)
  })

  it('rejects a missing, malformed or different token', () => {
    for (const header of [null, undefined, '', TOKEN, `Basic ${TOKEN}`, 'Bearer s3cret']) {
      expect(bearerTokenMatches(header, TOKEN)).toBe(false)
    }
    expect(bearerTokenMatches(`Bearer ${TOKEN}-and-more`, TOKEN)).toBe(false)
  })
})

describe('createMetricsRegistry', () => {
  it('exposes default process metrics labelled with the app', async () => {
    const text = await createMetricsRegistry('web').metrics()

    expect(text).toMatch(/^process_cpu_user_seconds_total\{app="web"\} /m)
    expect(text).not.toMatch(/task_id|user_id/)
  })
})

describe('metricsTokenProblem', () => {
  const prodToken = 'test-metrics-token-'.padEnd(MIN_METRICS_TOKEN_LENGTH, 'x')

  it('accepts any token outside production', () => {
    for (const token of [undefined, DEV_METRICS_TOKEN, 'short']) {
      expect(metricsTokenProblem(token, 'development')).toBeUndefined()
      expect(metricsTokenProblem(token, 'test')).toBeUndefined()
    }
  })

  it('refuses a missing token and the dev placeholder in production', () => {
    for (const token of [undefined, DEV_METRICS_TOKEN]) {
      expect(metricsTokenProblem(token, 'production')).toBe(
        'set a unique token in production (the dev placeholder is refused)',
      )
    }
  })

  it('requires at least 32 characters in production, without echoing the token', () => {
    const short = 'k'.repeat(MIN_METRICS_TOKEN_LENGTH - 1)
    expect(MIN_METRICS_TOKEN_LENGTH).toBe(32)
    expect(metricsTokenProblem(short, 'production')).toBe(
      'must be at least 32 characters in production',
    )
    expect(metricsTokenProblem(prodToken, 'production')).toBeUndefined()
  })
})
