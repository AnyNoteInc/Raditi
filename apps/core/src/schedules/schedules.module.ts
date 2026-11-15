import { Logger, Module } from '@nestjs/common'
import type { PrismaClient } from '@repo/db'
import { PRISMA } from '@repo/service-runtime'

import type { CoreConfig } from '../config/config.ts'
import { CORE_CONFIG } from '../config/config.tokens.ts'
import { notificationDeliveryOf } from '../tasks/notification-delivery.ts'
import { ScheduleNotify } from './schedule-notify.ts'
import { ScheduleScheduler } from './schedule-scheduler.ts'
import { ScheduleStart } from './schedule-start.ts'
import { ScheduleTick } from './schedule-tick.ts'
import { SchedulesProcessor } from './schedules.processor.ts'
import { SCHEDULE_NOTIFY, SCHEDULE_START, SCHEDULE_TICK } from './schedules.tokens.ts'

/**
 * The scheduled tasks in core (docs/plan/82-scheduled-tasks.md, §4.4): the tick that claims the due
 * tasks, the starts of their runs at the intake of web, the notices of a run that did not start, a
 * task that paused and a run missed. AppModule imports it only with SCHEDULE_INTAKE_URL and
 * SCHEDULE_INTAKE_SECRET set; without them no run starts and the cabinet still keeps the tasks.
 */
@Module({
  providers: [
    {
      provide: SCHEDULE_NOTIFY,
      useFactory: async (prisma: PrismaClient, config: CoreConfig) =>
        new ScheduleNotify({
          db: prisma,
          delivery: await notificationDeliveryOf(prisma, config),
          logger: new Logger('ScheduleNotify'),
        }),
      inject: [PRISMA, CORE_CONFIG],
    },
    {
      provide: SCHEDULE_TICK,
      useFactory: (prisma: PrismaClient, notify: ScheduleNotify) =>
        new ScheduleTick({ db: prisma, notify, logger: new Logger('ScheduleTick') }),
      inject: [PRISMA, SCHEDULE_NOTIFY],
    },
    {
      provide: SCHEDULE_START,
      useFactory: (prisma: PrismaClient, notify: ScheduleNotify, config: CoreConfig) => {
        const intake = config.schedules
        if (!intake)
          throw new Error('SchedulesModule needs SCHEDULE_INTAKE_URL and SCHEDULE_INTAKE_SECRET')
        return new ScheduleStart({
          db: prisma,
          intake: { url: intake.intakeUrl, secret: intake.secret },
          notify,
          logger: new Logger('ScheduleStart'),
        })
      },
      inject: [PRISMA, SCHEDULE_NOTIFY, CORE_CONFIG],
    },
    SchedulesProcessor,
    ScheduleScheduler,
  ],
})
export class SchedulesModule {}
