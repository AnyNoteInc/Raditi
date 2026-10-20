import { Module } from '@nestjs/common'

import { OutboxRelayService } from './outbox-relay.service.ts'

@Module({
  providers: [OutboxRelayService],
  exports: [OutboxRelayService],
})
export class OutboxModule {}
