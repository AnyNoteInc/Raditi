import { describe, expect, it } from 'vitest'

import { plural } from './plural'

describe('plural', () => {
  it.each([
    [0, 'сайтов'],
    [1, 'сайт'],
    [2, 'сайта'],
    [4, 'сайта'],
    [5, 'сайтов'],
    [11, 'сайтов'],
    [14, 'сайтов'],
    [21, 'сайт'],
    [22, 'сайта'],
    [100, 'сайтов'],
    [111, 'сайтов'],
    [121, 'сайт'],
  ])('picks the form for %i', (count, word) => {
    expect(plural(count, 'сайт', 'сайта', 'сайтов')).toBe(word)
  })
})
