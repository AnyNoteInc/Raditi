import { Logger } from '@nestjs/common'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { LlmConfigModule } from '../config/config.module.ts'
import type * as Egress from '../egress/egress.ts'
import type * as EgressProbe from '../egress/egress-probe.ts'
import { InfraModule } from '../infra/infra.module.ts'
import { testRole, testRoleConfig as config } from '../testing/role.ts'

const fakes = vi.hoisted(() => ({
  createPool: vi.fn(),
  transportRequest: vi.fn(),
  createControlEgress: vi.fn(),
}))
vi.mock('../egress/egress.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof Egress>()),
  createEgressTransport: () => ({ request: fakes.transportRequest }),
  createControlEgress: fakes.createControlEgress,
}))
vi.mock('../egress/egress-probe.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof EgressProbe>()),
  createEgressProbe: () => ({ check: () => Promise.resolve(true) }),
}))
vi.mock('./pool-health.ts', () => ({
  SubscriptionPoolHealth: class {
    constructor(options: unknown) {
      fakes.createPool(options)
    }
  },
}))

import { EgressNotDelivered } from '../egress/egress.ts'
import { EgressHealth } from '../egress/egress-probe.ts'
import type { SubscriptionPoolHealthOptions } from './pool-health.ts'
import { PoolModule } from './pool.module.ts'

describe('llm role lifecycle', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('lets only the account recheck through the channel while a confirmed region block holds', async () => {
    fakes.createControlEgress.mockImplementation((transport: { request: unknown }) => ({
      request: transport.request,
    }))
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {})
    const app = await testRole([
      LlmConfigModule.forRoot(config(true)),
      InfraModule,
      PoolModule,
    ]).compile()
    const channel = app.get(EgressHealth)
    await channel.check()
    const pool = fakes.createPool.mock.calls[0]![0] as SubscriptionPoolHealthOptions
    expect(pool.channelHealthy()).toBe(true)
    pool.onRegion('synthetic-account')
    expect(channel.healthy()).toBe(false)
    expect(pool.channelHealthy()).toBe(false)
    const usage = {
      method: 'GET' as const,
      url: 'https://api.z.ai/api/monitor/usage/quota/limit',
      headers: new Headers(),
    }
    const signal = new AbortController().signal
    await expect(pool.http.request(usage, { signal })).rejects.toBeInstanceOf(EgressNotDelivered)
    expect(fakes.transportRequest).not.toHaveBeenCalled()
    // Only the recheck may use the channel while the region block holds.
    fakes.transportRequest.mockResolvedValueOnce({ status: 200 })
    await pool.regionHttp!.request(usage, { signal })
    expect(fakes.transportRequest).toHaveBeenCalledOnce()
    await app.close()
  })
})
