import { describe, expect, it } from 'vitest'

import {
  crossBorderNotCleared,
  llmGatewayUnavailable,
  llmPriceMissing,
  subscriptionBusy,
  subscriptionWait,
} from '../errors.ts'

describe('subscription failures', () => {
  it('carries a serializable retry time for both queue outcomes', () => {
    const retryAt = new Date('2026-09-29T00:01:00Z')
    expect(subscriptionWait(retryAt)).toMatchObject({
      code: 'SUBSCRIPTION_WAIT',
      httpStatus: 503,
      details: { retryAt: retryAt.toISOString() },
    })
    expect(subscriptionBusy(retryAt)).toMatchObject({
      code: 'SUBSCRIPTION_BUSY',
      httpStatus: 503,
      details: { retryAt: retryAt.toISOString() },
    })
    expect(subscriptionWait(new Date('invalid'))).toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('distinguishes missing rates, unavailable transport and the data-transfer gate', () => {
    expect(llmPriceMissing()).toMatchObject({ code: 'LLM_PRICE_MISSING', httpStatus: 503 })
    expect(llmGatewayUnavailable()).toMatchObject({
      code: 'LLM_GATEWAY_UNAVAILABLE',
      httpStatus: 503,
    })
    expect(crossBorderNotCleared()).toMatchObject({
      code: 'CROSS_BORDER_NOT_CLEARED',
      httpStatus: 403,
    })
  })
})
