import { Module } from '@nestjs/common'
import type { PrismaClient } from '@repo/db'
import { PRISMA } from '@repo/service-runtime'

import { McpScheduleController } from './mcp-schedule.controller.ts'
import { McpScheduleService } from './schedule-service.ts'
import { postgresScheduleStore } from './schedule-store.ts'
import { MCP_SCHEDULE } from './schedule.tokens.ts'

/**
 * The scheduled tasks of the chat's author (docs/plan/82-scheduled-tasks.md, Зп31–Зп33): no profile
 * and no setting — the database alone —, so every composition has them. The role reserves a change;
 * core applies it when the turn ends.
 */
@Module({
  controllers: [McpScheduleController],
  providers: [
    {
      provide: MCP_SCHEDULE,
      inject: [PRISMA],
      useFactory: (prisma: PrismaClient) =>
        new McpScheduleService({ store: postgresScheduleStore(prisma) }),
    },
  ],
})
export class ScheduleModule {}
