import type { TestingModule } from '@nestjs/testing'
import type { GatewayFinish } from '@repo/turn-keys'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { GATEWAY_STORE } from '../accounting/accounting.tokens.ts'
import type { GatewayCall } from '../accounting/gateway-types.ts'
import { LlmConfigModule } from '../config/config.module.ts'
import { GENERATION_EGRESS } from '../egress/egress.tokens.ts'
import { InfraModule } from '../infra/infra.module.ts'
import { SubscriptionPoolHealth } from '../pool/pool-health.ts'
import { CREDENTIAL_SOURCE } from '../pool/pool.tokens.ts'
import { testRole, testRoleConfig as config } from '../testing/role.ts'

const createGateway = vi.hoisted(() => vi.fn())
vi.mock('./server.ts', () => ({ createLlmGateway: createGateway }))

import { GatewayModule } from './gateway.module.ts'
import { GatewayReadiness } from './readiness.ts'
import type { LlmGatewayOptions } from './server.ts'

const pool = {
  pause: vi.fn(),
  observe: vi.fn(),
  probeAccount: vi.fn(),
  refreshAccount: vi.fn(),
  recheckRegion: vi.fn(),
  tick: vi.fn(),
  close: vi.fn(),
}

describe('llm role lifecycle', () => {
  let app: TestingModule | undefined
  afterEach(async () => {
    await app?.close()
    app = undefined
    vi.resetAllMocks()
  })
  const gateway = async () => {
    createGateway.mockReturnValue({ listen: vi.fn(), close: vi.fn().mockResolvedValue(undefined) })
    app = await testRole([LlmConfigModule.forRoot(config()), InfraModule, GatewayModule])
      .overrideProvider(SubscriptionPoolHealth)
      .useValue(pool)
      .compile()
    return { app, options: createGateway.mock.calls[0]![0] as LlmGatewayOptions }
  }

  it('builds the gateway on the store, the account keys and the gate of generations of the role', async () => {
    const { app, options } = await gateway()
    expect(options.store).toBe(app.get(GATEWAY_STORE))
    expect(options.credentials).toBe(app.get(CREDENTIAL_SOURCE))
    // Never the ungated transport: a closed channel sends no generation.
    expect(options.egress).toBe(app.get(GENERATION_EGRESS))
    expect(options.metricsToken).toBe('test')
    const readiness = app.get(GatewayReadiness)
    readiness.close()
    expect(options.ready?.()).toBe(false)
  })

  it('forwards lifecycle calls to the bound account', async () => {
    const { options } = await gateway()
    const call = { accountId: 'synthetic-account', credentialVersion: 7 } as GatewayCall
    const finish = { state: 'completed' } as GatewayFinish
    pool.pause.mockReturnValue({ reason: 'transient', retryAfterMs: 1000 })
    pool.observe.mockResolvedValue(undefined)
    pool.probeAccount.mockResolvedValue(null)
    pool.refreshAccount.mockResolvedValue(null)
    expect(options.lifecycle?.pause(call)).toEqual({ reason: 'transient', retryAfterMs: 1000 })
    await options.lifecycle?.observe(call, finish)
    expect(pool.pause).toHaveBeenCalledExactlyOnceWith('synthetic-account')
    expect(pool.observe).toHaveBeenCalledExactlyOnceWith(call, finish)
    await options.lifecycle?.probeAccounts?.(['synthetic-account', 'other-synthetic-account'])
    // Core's issue asks because the windows are unknown, without a snapshot of its own.
    expect(pool.probeAccount.mock.calls).toEqual([
      ['synthetic-account', {}],
      ['other-synthetic-account', {}],
    ])
    const unknownWindows = { limitsSeenAt: new Date(0) }
    await options.lifecycle?.probeAccounts?.(['synthetic-account'], unknownWindows)
    expect(pool.probeAccount).toHaveBeenLastCalledWith('synthetic-account', unknownWindows)
    // A snapshot that has only grown old is the pool's own question: neither unknown windows
    // nor a signal waiting for its confirmation.
    await options.lifecycle?.refreshAccount?.('synthetic-account')
    expect(pool.refreshAccount).toHaveBeenCalledExactlyOnceWith('synthetic-account')
    expect(pool.probeAccount).toHaveBeenCalledTimes(3)
  })
})
