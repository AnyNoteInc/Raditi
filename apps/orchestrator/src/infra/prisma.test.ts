import { describe, expect, it, vi } from 'vitest'

const { createPrismaClient } = vi.hoisted(() => ({ createPrismaClient: vi.fn(() => ({})) }))
vi.mock('@repo/db', () => ({ createPrismaClient }))

const { createOrchestratorPrisma } = await import('./prisma.ts')

describe('createOrchestratorPrisma', () => {
  it('keeps warnings, leaves errors to the callers and /health, and bounds the pool wait', () => {
    const databaseUrl = 'postgresql://raditi:raditi@localhost:5432/raditi'

    createOrchestratorPrisma({ databaseUrl })

    expect(createPrismaClient).toHaveBeenCalledWith({
      databaseUrl,
      log: ['warn'],
      connectionTimeoutMs: 3_000,
    })
  })
})
