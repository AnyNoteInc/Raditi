import { browserCloseReasons, browserStreamEndReasons } from '@repo/domain'
import { describe, expect, it } from 'vitest'

import { browserStreamCloseCode, browserStreamCloseCodes } from './close-codes.ts'

describe('browserStreamCloseCode', () => {
  it('gives every end of the gateway its own code in the private range', () => {
    expect(browserStreamCloseCode('unauthorized')).toBe(4401)
    expect(browserStreamCloseCode('forbidden')).toBe(4403)
    expect(browserStreamCloseCode('unavailable')).toBe(4503)
    expect(browserStreamCloseCode('protocol')).toBe(4400)
    for (const code of Object.values(browserStreamCloseCodes)) {
      expect(code).toBeGreaterThanOrEqual(4000)
      expect(code).toBeLessThan(5000)
    }
  })

  it('closes every end of the session itself with one code', () => {
    for (const reason of browserCloseReasons)
      expect(browserStreamCloseCode(reason)).toBe(browserStreamCloseCodes.ended)
    expect(new Set(browserStreamEndReasons.map(browserStreamCloseCode)).size).toBe(5)
  })
})
