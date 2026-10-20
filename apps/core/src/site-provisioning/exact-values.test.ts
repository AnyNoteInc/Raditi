import { siteImportLimits } from '@repo/domain'
import { describe, expect, it } from 'vitest'

import { ExactValues } from './exact-values.ts'

const feed = (values: ExactValues, ...chunks: string[]) => {
  const search = values.file()
  for (const chunk of chunks) search.feed(Buffer.from(chunk))
  return [...search.found]
}

describe('ExactValues', () => {
  it('finds each value inside one chunk and across the boundary of two', () => {
    const values = new ExactValues(['synthetic-secret', 'кириллица-пароль'])
    expect(feed(values, 'a synthetic-secret here')).toEqual([0])
    expect(feed(values, 'a synthe', 'tic-sec', 'ret')).toEqual([0])
    // Bytes, not characters: a Cyrillic value cut inside a letter is found too.
    const cyrillic = Buffer.from('xx кириллица-пароль')
    const search = values.file()
    search.feed(cyrillic.subarray(0, 6))
    search.feed(cyrillic.subarray(6))
    expect([...search.found]).toEqual([1])
    expect(feed(values, 'synthetic-', 'nothing', '-secret')).toEqual([])
  })

  it('ignores empty and repeated values', () => {
    const values = new ExactValues(['', 'same', 'same'])
    expect(values.size).toBe(1)
    expect(feed(values, '')).toEqual([])
  })

  it('refuses a value found in more files than exactValueFiles', () => {
    const values = new ExactValues(['admin'])
    for (let file = 0; file < siteImportLimits.exactValueFiles; file += 1)
      values.record(new Set([0]))
    expect(() => values.record(new Set([0]))).toThrow(
      expect.objectContaining({ code: 'access_value_common' }),
    )
  })
})
