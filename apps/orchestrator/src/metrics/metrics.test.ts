import { describe, expect, it } from 'vitest'

import { bearerTokenMatches, createMetricsRegistry } from './metrics.ts'

describe('bearerTokenMatches', () => {
  it('accepts the exact bearer token', () => {
    expect(bearerTokenMatches('Bearer s3cret-token', 's3cret-token')).toBe(true)
    expect(bearerTokenMatches('bearer s3cret-token', 's3cret-token')).toBe(true)
  })

  it('rejects a missing, malformed or different token', () => {
    expect(bearerTokenMatches(undefined, 's3cret-token')).toBe(false)
    expect(bearerTokenMatches('', 's3cret-token')).toBe(false)
    expect(bearerTokenMatches('s3cret-token', 's3cret-token')).toBe(false)
    expect(bearerTokenMatches('Basic s3cret-token', 's3cret-token')).toBe(false)
    expect(bearerTokenMatches('Bearer s3cret', 's3cret-token')).toBe(false)
    expect(bearerTokenMatches('Bearer s3cret-token-and-more', 's3cret-token')).toBe(false)
  })
})

describe('createMetricsRegistry', () => {
  it('exposes default process metrics labelled app=orchestrator', async () => {
    const text = await createMetricsRegistry().metrics()

    expect(text).toMatch(/^process_cpu_user_seconds_total\{app="orchestrator"\} /m)
    expect(text).not.toMatch(/task_id|user_id/)
  })
})
