import { describe, expect, it } from 'vitest'

import { isArtifactRank, rankBetween, rankForIndex } from './artifact-rank.ts'

describe('fractional ranks of blocks (plan 88, Ар11)', () => {
  it('puts a rank strictly between two, and at either end', () => {
    expect(rankBetween(null, null)).toBe('i')
    for (const [low, high] of [
      ['1', '2'],
      ['1', '11'],
      ['0001', '0002'],
      ['a', 'b'],
      ['az', 'b'],
      ['y', 'z'],
      ['zz', null],
      [null, '01'],
    ] as const) {
      const mid = rankBetween(low, high)
      expect(isArtifactRank(mid)).toBe(true)
      if (low !== null) expect(mid > low).toBe(true)
      if (high !== null) expect(mid < high).toBe(true)
    }
  })

  it('keeps finding room after many inserts at one place, and the order of JavaScript', () => {
    const ranks = [rankForIndex(0), rankForIndex(1)]
    // Always right after the first: the worst case for the length of the keys.
    for (let n = 0; n < 500; n += 1) ranks.splice(1, 0, rankBetween(ranks[0]!, ranks[1]!))
    for (let n = 0; n < 500; n += 1) ranks.push(rankBetween(ranks.at(-1)!, null))
    for (let n = 0; n < 500; n += 1) ranks.unshift(rankBetween(null, ranks[0]!))
    expect([...ranks].sort()).toEqual(ranks)
    expect(new Set(ranks).size).toBe(ranks.length)
    expect(ranks.every(isArtifactRank)).toBe(true)
    expect(Math.max(...ranks.map((rank) => rank.length))).toBeLessThan(120)
  })

  it('numbers a list as the backfill of the migration does', () => {
    expect([0, 1, 35, 36, 1295, 1296, 46_655].map(rankForIndex)).toEqual([
      '000i',
      '001i',
      '00zi',
      '010i',
      '0zzi',
      '100i',
      'zzzi',
    ])
    const list = Array.from({ length: 2000 }, (_, index) => rankForIndex(index))
    expect([...list].sort()).toEqual(list)
    expect(() => rankForIndex(46_656)).toThrow(RangeError)
  })

  it('refuses what is not a rank, and bounds out of order', () => {
    expect(isArtifactRank('a0')).toBe(false)
    expect(isArtifactRank('A')).toBe(false)
    expect(isArtifactRank('')).toBe(false)
    expect(() => rankBetween('b', 'a')).toThrow(RangeError)
    expect(() => rankBetween('a', 'a')).toThrow(RangeError)
    expect(() => rankBetween('a0', null)).toThrow(RangeError)
  })
})
