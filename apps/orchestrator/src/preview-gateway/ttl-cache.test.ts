import { describe, expect, it } from 'vitest'

import { TtlCache } from './ttl-cache.ts'

describe('TtlCache', () => {
  it('forgets an entry once it is as old as the TTL', () => {
    let now = 0
    const cache = new TtlCache<string, number | null>(5_000, 10, () => now)
    cache.set('a', 1)
    cache.set('b', null)
    now = 4_999
    expect(cache.get('a')).toBe(1)
    expect(cache.get('b')).toBeNull()
    now = 5_000
    expect(cache.get('a')).toBeUndefined()
    expect(cache.size).toBe(1)
  })

  it('keeps no more than its ceiling, the oldest leaving first', () => {
    const cache = new TtlCache<number, number>(60_000, 3)
    for (const key of [1, 2, 3, 4]) cache.set(key, key)
    expect([1, 2, 3, 4].map((key) => cache.get(key))).toEqual([undefined, 2, 3, 4])
    cache.set(2, 20)
    cache.set(5, 5)
    expect([2, 3, 4, 5].map((key) => cache.get(key))).toEqual([20, undefined, 4, 5])
  })

  it('changes a fresh value in place without making it younger', () => {
    let now = 0
    const cache = new TtlCache<string, number>(1_000, 10, () => now)
    cache.set('a', 1)
    now = 900
    cache.update('a', (value) => value + 1)
    expect(cache.get('a')).toBe(2)
    now = 1_000
    expect(cache.get('a')).toBeUndefined()
    cache.update('a', () => 3)
    expect(cache.get('a')).toBeUndefined()
  })
})
