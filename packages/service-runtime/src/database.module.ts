import { Global, Module, type DynamicModule } from '@nestjs/common'
import type { DbConfig } from '@repo/db'

import { PrismaLifecycle } from './lifecycle.ts'
import { createAppPrisma } from './prisma.ts'
import { PRISMA } from './tokens.ts'

/**
 * The one PrismaClient of an app process (createAppPrisma), for every module of it: global, so
 * no module imports it, and Nest stops a global module after the others — PrismaLifecycle closes
 * the pool once the HTTP server and the workers have stopped. Called once per app: Nest tells
 * dynamic modules apart by reference, and a second call would open a second pool.
 */
@Global()
@Module({})
export class DatabaseModule {
  static forRoot(db: DbConfig): DynamicModule {
    return {
      module: DatabaseModule,
      providers: [{ provide: PRISMA, useFactory: () => createAppPrisma(db) }, PrismaLifecycle],
      exports: [PRISMA],
    }
  }
}
