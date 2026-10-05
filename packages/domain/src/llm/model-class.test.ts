import { describe, expect, it } from 'vitest'

import { modelClassSchema, quotaAttemptCeilingsRub } from './model-class.ts'

describe('product model profiles', () => {
  it('rejects the removed service class and unknown profiles', () => {
    expect(modelClassSchema.safeParse('service').success).toBe(false)
    expect(modelClassSchema.safeParse('custom').success).toBe(false)
  })

  it('exposes immutable quota ceilings as decimal strings', () => {
    expect(quotaAttemptCeilingsRub).toEqual({
      light: '135.00',
      standard: '285.00',
      heavy: '735.00',
    })
    expect(Object.isFrozen(quotaAttemptCeilingsRub)).toBe(true)
  })
})
