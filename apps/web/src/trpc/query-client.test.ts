// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'

import { getQueryClient } from './query-client'

describe('getQueryClient in the browser', () => {
  it('keeps one client per user and never hands one account the cache of another', () => {
    const anna = getQueryClient('user-anna')
    anna.setQueryData(['site', 'list'], ['anna.example.ru'])
    expect(getQueryClient('user-anna')).toBe(anna)

    const boris = getQueryClient('user-boris')
    expect(boris).not.toBe(anna)
    expect(boris.getQueryData(['site', 'list'])).toBeUndefined()

    // Back to the first account (say, a session switched in another tab): a clean client again.
    const annaAgain = getQueryClient('user-anna')
    expect(annaAgain).not.toBe(anna)
    expect(annaAgain.getQueryData(['site', 'list'])).toBeUndefined()
  })
})
