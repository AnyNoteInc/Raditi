import { Module } from '@nestjs/common'

import { OutboxRelayService } from './outbox-relay.service.ts'

@Module({
  providers: [OutboxRelayService],
  // Woken by the signals of the database (task-signals) when new rows commit.
  exports: [OutboxRelayService],
})
export class OutboxModule {}
