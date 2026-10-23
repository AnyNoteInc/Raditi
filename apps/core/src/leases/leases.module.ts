import { Module } from '@nestjs/common'
import {
  PostgresSiteLeaseStore,
  PostgresTaskTurnAssignmentStore,
  type PrismaClient,
} from '@repo/db'
import { PRISMA } from '@repo/service-runtime'

import { SITE_LEASES, TURN_ASSIGNMENTS } from './leases.tokens.ts'

/**
 * The lease of a site (strictly one turn, deploy or rollback at a time, spec §7) and the
 * assignment of a turn to its executor, both in PostgreSQL: what turns, the runner API, dialogs
 * and releases fence their work with.
 */
@Module({
  providers: [
    {
      provide: SITE_LEASES,
      useFactory: (prisma: PrismaClient) => new PostgresSiteLeaseStore(prisma),
      inject: [PRISMA],
    },
    {
      provide: TURN_ASSIGNMENTS,
      useFactory: (prisma: PrismaClient) => new PostgresTaskTurnAssignmentStore(prisma),
      inject: [PRISMA],
    },
  ],
  exports: [SITE_LEASES, TURN_ASSIGNMENTS],
})
export class LeasesModule {}
