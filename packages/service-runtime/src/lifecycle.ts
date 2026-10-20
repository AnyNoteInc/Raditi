import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common'
import type { PrismaClient } from '@repo/db'

import { PRISMA } from './tokens.ts'

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
