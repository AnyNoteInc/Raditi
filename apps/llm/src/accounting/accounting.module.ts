import { Module, type Logger } from '@nestjs/common'
import type { PrismaClient } from '@repo/db'
import { PRISMA } from '@repo/service-runtime'

import type { LlmRoleConfig } from '../config/config.ts'
import { LLM_CONFIG } from '../config/config.module.ts'
import { LLM_LOGGER } from '../infra/infra.tokens.ts'
import { GATEWAY_STORE } from './accounting.tokens.ts'
import { PostgresGatewayStore } from './gateway-store.ts'
import { LostCallCollector } from './lost-call-collector.ts'

/** What a call costs a turn key: admission, the call ledger and the collector of lost calls. */
@Module({
  providers: [
    {
      provide: GATEWAY_STORE,
      useFactory: (prisma: PrismaClient, config: LlmRoleConfig, logger: Logger) =>
        new PostgresGatewayStore(prisma, {
          maxRequestsPerKey: config.maxRequestsPerKey,
          maxCallsPerKey30s: config.maxCallsPerKey30s,
          maxCallsPerKey: config.maxCallsPerKey,
          logger: { warn: (message) => logger.warn(message) },
        }),
      inject: [PRISMA, LLM_CONFIG, LLM_LOGGER],
    },
    LostCallCollector,
  ],
  exports: [GATEWAY_STORE, LostCallCollector],
})
export class AccountingModule {}
