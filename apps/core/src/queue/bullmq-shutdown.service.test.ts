import { getQueueToken, WorkerHost } from '@nestjs/bullmq'
import { Logger, type DynamicModule, type INestApplication } from '@nestjs/common'
import type { DiscoveryService } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import { queueNames, withTimeout, type JobQueue, type QueueName } from '@repo/domain'
import type { Job, Queue, Worker } from 'bullmq'
import type { Redis } from 'ioredis'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { RedisLifecycle, createRedisClient } from '../infra/redis.ts'
import { REDIS } from '../infra/infra.tokens.ts'
import { JOB_QUEUE } from './queue.tokens.ts'
import { startFakeRedis, type FakeRedis } from '../testing/fake-redis.ts'
import { BullMqShutdownService } from './bullmq-shutdown.service.ts'
import { QueueModule } from './queue.module.ts'

class TestProcessor extends WorkerHost {
  process(_job: Job): Promise<void> {
    return Promise.resolve()
  }
}

function setup(redisStatus: string, withWorker = true) {
  const workerClose = vi.fn().mockResolvedValue(undefined)
  const host = new TestProcessor()
  if (withWorker) Object.assign(host, { _worker: { close: workerClose } as unknown as Worker })
  const discovery = {
    getProviders: () => [
      { instance: host },
      { instance: { notAWorker: true } },
      { instance: null },
    ],
  } as unknown as DiscoveryService
  const backendClose = vi.fn().mockResolvedValue(undefined)
  const queueClose = vi.fn().mockResolvedValue(undefined)
  const queues = new Map<QueueName, Queue>(
    queueNames.map((name) => [
      name,
      { name, close: queueClose, getBackend: () => ({ close: backendClose }) } as unknown as Queue,
    ]),
  )
  const service = new BullMqShutdownService(discovery, { status: redisStatus } as never, queues)
  return { service, workerClose, backendClose, queueClose }
}

beforeAll(() => {
  Logger.overrideLogger(false)
})

describe('BullMqShutdownService', () => {
  it('closes workers gracefully and leaves queues to @nestjs/bullmq while Redis is reachable', async () => {
    const { service, workerClose, backendClose, queueClose } = setup('ready')

    await service.beforeApplicationShutdown()

    expect(workerClose).toHaveBeenCalledWith(false)
    expect(backendClose).not.toHaveBeenCalled()
    expect(queueClose).not.toHaveBeenCalled()
  })

  it('closes workers and every queue by force when Redis is unreachable, instead of hanging', async () => {
    const { service, workerClose, backendClose } = setup('reconnecting')

    await service.beforeApplicationShutdown()

    expect(workerClose).toHaveBeenCalledWith(true)
    expect(backendClose).toHaveBeenCalledTimes(queueNames.length)
    expect(backendClose.mock.calls.every(([force]) => force === true)).toBe(true)
  })

  it('closes queues by force even when workers were never started (tests, tools)', async () => {
    const { service, workerClose, backendClose } = setup('reconnecting', false)

    await service.beforeApplicationShutdown()

    expect(workerClose).not.toHaveBeenCalled()
    expect(backendClose).toHaveBeenCalledTimes(queueNames.length)
  })
})

describe('shutdown with Redis gone (real BullMQ and ioredis)', () => {
  const SHUTDOWN_DEADLINE_MS = 5_000
  let redis: FakeRedis | undefined
  let app: INestApplication | undefined

  afterEach(async () => {
    await redis?.stop()
    redis = undefined
    app = undefined
  })

  function redisModule(url: string): DynamicModule {
    class TestRedisModule {}
    return {
      module: TestRedisModule,
      global: true,
      providers: [{ provide: REDIS, useFactory: () => createRedisClient(url) }, RedisLifecycle],
      exports: [REDIS],
    }
  }

  it('finishes within the deadline while an add waits for Redis', { timeout: 15_000 }, async () => {
    redis = await startFakeRedis()
    const moduleRef = await Test.createTestingModule({
      imports: [
        redisModule(redis.url),
        QueueModule.forRoot({ redisUrl: redis.url, background: false }),
      ],
    }).compile()
    app = moduleRef.createNestApplication({ logger: false })
    await app.init()
    const client = app.get<Redis>(REDIS)
    await Promise.all(
      queueNames.map((name) => app?.get<Queue>(getQueueToken(name)).waitUntilReady()),
    )
    await vi.waitFor(() => expect(client.status).toBe('ready'))

    await redis.stop()
    await vi.waitFor(() => expect(client.status).not.toBe('ready'))
    // The add sits in ioredis' offline queue (maxRetriesPerRequest: null): QUIT would wait behind it.
    const pending = app
      .get<JobQueue>(JOB_QUEUE)
      .enqueue('notifications', 'auth.welcome', {}, { jobId: 'welcome:u1' })
    pending.catch(() => {})

    // Without the forced close, QUIT waits behind the add and this times out.
    await expect(
      withTimeout(app.close(), SHUTDOWN_DEADLINE_MS, 'shutdown hung'),
    ).resolves.toBeUndefined()
  })
})
