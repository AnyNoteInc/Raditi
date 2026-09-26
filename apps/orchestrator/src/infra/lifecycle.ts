import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common'
import type { PrismaClient } from '@repo/db'
import type { Redis } from 'ioredis'

import { PRISMA, REDIS } from './tokens.ts'

/** Closes the database pool after the HTTP server and the workers have stopped. */
@Injectable()
export class PrismaLifecycle implements OnApplicationShutdown {
  readonly #prisma: PrismaClient

  constructor(@Inject(PRISMA) prisma: PrismaClient) {
    this.#prisma = prisma
  }

  async onApplicationShutdown(): Promise<void> {
    await this.#prisma.$disconnect()
  }
}

@Injectable()
export class RedisLifecycle implements OnApplicationShutdown {
  readonly #redis: Redis

  constructor(@Inject(REDIS) redis: Redis) {
    this.#redis = redis
  }

  async onApplicationShutdown(): Promise<void> {
    // QUIT needs a live connection; otherwise just stop reconnecting.
    if (this.#redis.status !== 'ready') {
      this.#redis.disconnect()
      return
    }
    await this.#redis.quit().catch(() => this.#redis.disconnect())
  }
}
