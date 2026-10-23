import { Module } from '@nestjs/common'

import { OutboxRelayService } from './outbox-relay.service.ts'

@Module({
  providers: [OutboxRelayService],
})
export class OutboxModule {}
