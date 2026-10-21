import { Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { createPrismaClient, events } = vi.hoisted(() => {
  const events: string[] = []
  const createPrismaClient = vi.fn(() => ({
    $disconnect: vi.fn(() => {
      events.push('database')
      return Promise.resolve()
    }),
  }))
  return { createPrismaClient, events }
})
vi.mock('@repo/db', () => ({ createPrismaClient }))

const { DatabaseModule } = await import('./database.module.ts')
const { PRISMA } = await import('./tokens.ts')

const databaseUrl = 'postgresql://raditi:raditi@localhost:5432/raditi'

/** A provider of a module that uses the database and imports nothing for it. */
@Injectable()
class Worker implements OnApplicationShutdown {
  constructor(@Inject(PRISMA) readonly prisma: unknown) {}

  async onApplicationShutdown(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 5))
    events.push('worker')
  }
}

@Module({ providers: [Worker] })
class WorkersModule {}

describe('DatabaseModule', () => {
  beforeEach(() => {
    createPrismaClient.mockClear()
    events.length = 0
  })

  it('gives every module of the app one client of the app, without an import', async () => {
    const app = await Test.createTestingModule({
      imports: [DatabaseModule.forRoot({ databaseUrl }), WorkersModule],
    }).compile()

    expect(app.get(Worker).prisma).toBe(app.get(PRISMA))
    expect(createPrismaClient).toHaveBeenCalledExactlyOnceWith({
      databaseUrl,
      log: ['warn'],
      connectionTimeoutMs: 3_000,
    })
    await app.close()
  })

  it('closes the pool after the modules that use it have stopped', async () => {
    const app = await Test.createTestingModule({
      imports: [DatabaseModule.forRoot({ databaseUrl }), WorkersModule],
    }).compile()

    await app.close()

    expect(events).toEqual(['worker', 'database'])
  })
})
