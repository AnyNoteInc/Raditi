import { Module } from '@nestjs/common'

import { TaskLifecycleService } from './task-lifecycle.service.ts'

@Module({
  providers: [TaskLifecycleService],
  exports: [TaskLifecycleService],
})
export class TasksModule {}
