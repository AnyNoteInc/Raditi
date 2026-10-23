import type { TestingModule } from '@nestjs/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LlmConfigModule } from '../config/config.module.ts'
import { InfraModule } from '../infra/infra.module.ts'
import { testRole, testRoleConfig as config } from '../testing/role.ts'
import type * as Egress from './egress.ts'
import type * as EgressProbe from './egress-probe.ts'

const fakes = vi.hoisted(() => ({
  createTransport: vi.fn(),
  transportRequest: vi.fn(),
  probe: vi.fn(),
}))
vi.mock('./egress.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof Egress>()),
  createEgressTransport: (...args: unknown[]) => {
    fakes.createTransport(...args)
    return { request: fakes.transportRequest }
  },
}))
vi.mock('./egress-probe.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof EgressProbe>()),
  createEgressProbe: () => ({ check: fakes.probe }),
}))

import { EgressNotDelivered, type StreamingEgress } from './egress.ts'
import { EgressHealth } from './egress-probe.ts'
import { EgressModule } from './egress.module.ts'
import { GENERATION_EGRESS } from './egress.tokens.ts'

const usage = {
  method: 'GET' as const,
  url: 'https://api.z.ai/api/monitor/usage/quota/limit',
  headers: new Headers(),
}

describe('llm role lifecycle', () => {
  let app: TestingModule | undefined
  beforeEach(() => {
    vi.resetAllMocks()
  })
  afterEach(async () => {
    await app?.close()
    app = undefined
  })
  const egress = async (withEgress: boolean) =>
    (app = await testRole([
      LlmConfigModule.forRoot(config(withEgress)),
      InfraModule,
      EgressModule,
    ]).compile())

  it('keeps transport closed after a failed initial egress probe', async () => {
    fakes.probe.mockResolvedValue(false)
    const role = await egress(true)
    const channel = role.get(EgressHealth)
    await channel.check()
    expect(channel.healthy()).toBe(false)
    await expect(
      role
        .get<symbol, StreamingEgress>(GENERATION_EGRESS)
        .request(usage, { signal: new AbortController().signal }),
    ).rejects.toBeInstanceOf(EgressNotDelivered)
    expect(fakes.transportRequest).not.toHaveBeenCalled()
  })

  it('tells the channel of every connection the role opens to a provider itself', async () => {
    const role = await egress(false)
    const channel = role.get(EgressHealth)
    const { onDirectConnection } = fakes.createTransport.mock.calls[0]![2] as {
      onDirectConnection: (established: boolean) => void
    }
    expect(channel.directReachable()).toBe(true)
    for (let failure = 0; failure < 3; failure++) onDirectConnection(false)
    expect(channel.directReachable()).toBe(false)
    onDirectConnection(true)
    expect(channel.directReachable()).toBe(true)
  })
})
