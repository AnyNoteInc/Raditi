import { Logger } from '@nestjs/common'
import { PRISMA } from '@repo/service-runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { LlmConfigModule } from '../config/config.module.ts'
import { testRole, testRoleConfig as config } from '../testing/role.ts'
import { databaseShutdown } from './database-shutdown.ts'
import { InfraModule } from './infra.module.ts'
import { DATABASE_SHUTDOWN, LLM_LOGGER } from './infra.tokens.ts'

describe('llm infra', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('disconnects the database within its bound and warns when the pool does not close', async () => {
    vi.useFakeTimers()
    const warn = vi.fn()
    const stuck = { $disconnect: vi.fn(() => new Promise<void>(() => {})) }
    const closing = databaseShutdown(stuck, { warn })(2000)
    await vi.advanceTimersByTimeAsync(1999)
    expect(warn).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await closing
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({ event: 'llm_database_shutdown_timeout' }),
    )
    const closed = { $disconnect: vi.fn().mockResolvedValue(undefined) }
    await databaseShutdown(closed, { warn })(2000)
    expect(warn).toHaveBeenCalledOnce()
  })

  it('writes everything of the role under the one LlmGateway logger, and closes the pool it provides', async () => {
    const prisma = { $disconnect: vi.fn().mockResolvedValue(undefined) }
    const app = await testRole([LlmConfigModule.forRoot(config()), InfraModule], {
      prisma,
    }).compile()
    const logger = app.get<symbol, Logger>(LLM_LOGGER)
    expect(logger).toBeInstanceOf(Logger)
    expect((logger as unknown as { context: string }).context).toBe('LlmGateway')
    expect(app.get(PRISMA)).toBe(prisma)
    // The module has no hook of its own: the runtime closes the pool, last (llm-runtime.ts).
    await app.close()
    expect(prisma.$disconnect).not.toHaveBeenCalled()
    await app.get<symbol, (withinMs: number) => Promise<void>>(DATABASE_SHUTDOWN)(2000)
    expect(prisma.$disconnect).toHaveBeenCalledOnce()
  })
})
