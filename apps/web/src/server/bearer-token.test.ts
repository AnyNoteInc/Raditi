import { describe, expect, it } from 'vitest'

import { bearerTokenMatches } from './bearer-token'

const TOKEN = 's3cret-token'

describe('bearerTokenMatches', () => {
  it('accepts the exact bearer token', () => {
    expect(bearerTokenMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true)
    expect(bearerTokenMatches(`bearer ${TOKEN}`, TOKEN)).toBe(true)
  })

  it('rejects a missing, malformed or different token', () => {
    expect(bearerTokenMatches(null, TOKEN)).toBe(false)
    expect(bearerTokenMatches('', TOKEN)).toBe(false)
    expect(bearerTokenMatches(TOKEN, TOKEN)).toBe(false)
    expect(bearerTokenMatches(`Basic ${TOKEN}`, TOKEN)).toBe(false)
    expect(bearerTokenMatches('Bearer s3cret', TOKEN)).toBe(false)
    expect(bearerTokenMatches(`Bearer ${TOKEN}-and-more`, TOKEN)).toBe(false)
  })
})
