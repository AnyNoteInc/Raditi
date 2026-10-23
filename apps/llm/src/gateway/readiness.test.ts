import type { PrismaClient } from '@repo/db'
import type { SecretStore } from '@repo/domain'
import { cachedHealthProbe, databaseCheck, vaultCheck } from '@repo/observability'
import { describe, expect, it, vi } from 'vitest'

import { EgressHealth } from '../egress/egress-probe.ts'
import { GatewayReadiness } from './readiness.ts'

// Database and Vault that answer, and a role without a proxy whose first check has passed.
const readinessOf = async (collector: { healthy(): boolean }) => {
  const prisma = { $queryRaw: vi.fn().mockResolvedValue([]) } as unknown as PrismaClient
  const secrets = {
    health: vi.fn().mockResolvedValue({ initialized: true, sealed: false }),
  } as unknown as SecretStore
  // Without a proxy there is no channel of the platform to measure (egress-probe.ts).
  const channel = new EgressHealth({ check: () => Promise.resolve(true) })
  await channel.check()
  const readiness = new GatewayReadiness(
    collector,
    channel,
    cachedHealthProbe({
      database: databaseCheck(() => prisma),
      vault: vaultCheck(() => secrets),
    }),
  )
  return { channel, readiness }
}

describe('llm role lifecycle', () => {
  it('answers degraded, with admission left open, while its own connections to a provider fail', async () => {
    const { channel, readiness } = await readinessOf({ healthy: () => true })
    expect(await readiness.health()).toBe(true)
    // Without a proxy nothing probes a provider: the transport's own word is the one sign
    // (egress.module.test.ts gives it to the channel).
    for (let failure = 0; failure < 3; failure++) channel.observeDirect(false)
    expect(await readiness.health()).toBe(false)
    expect(readiness.ready()).toBe(true)
    channel.observeDirect(true)
    expect(await readiness.health()).toBe(true)
    readiness.close()
    expect(readiness.ready()).toBe(false)
  })

  it('closes admission and answers degraded while the last scan for lost calls has not finished in time', async () => {
    // The channel, the database and Vault are all well: the collector alone decides here.
    const { readiness } = await readinessOf({ healthy: () => false })
    expect(readiness.ready()).toBe(false)
    expect(await readiness.health()).toBe(false)
  })
})
