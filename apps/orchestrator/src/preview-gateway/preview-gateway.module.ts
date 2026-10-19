import { Logger, Module, type DynamicModule } from '@nestjs/common'
import type { PrismaClient } from '@repo/db'

import type { PreviewGatewayConfig } from '../config/config.ts'
import { PrismaLifecycle } from '../infra/lifecycle.ts'
import { createOrchestratorPrisma } from '../infra/prisma.ts'
import { PREVIEW_GATEWAY_CONFIG, PRISMA } from '../infra/tokens.ts'
import { PostgresPreviewAccess } from './preview-access.ts'
import { PreviewGatewayServer } from './preview-gateway.server.ts'

/**
 * The `preview` role (docs/plan/53-chat-preview-release.md, Р19, R6): a trusted process with the
 * database that routes the exact Host of a preview to its upstream. startPreview opens
 * PreviewGatewayServer on PREVIEW_GATEWAY_PORT.
 */
@Module({})
export class PreviewGatewayModule {
  static forRoot(config: PreviewGatewayConfig): DynamicModule {
    return {
      module: PreviewGatewayModule,
      providers: [
        { provide: PREVIEW_GATEWAY_CONFIG, useValue: config },
        { provide: PRISMA, useFactory: () => createOrchestratorPrisma(config.db) },
        {
          provide: PreviewGatewayServer,
          useFactory: (prisma: PrismaClient) => {
            const logger = new Logger('PreviewGateway')
            return new PreviewGatewayServer({
              appEnv: config.appEnv,
              address: config.address,
              sessionSecret: config.sessionSecret,
              appUrl: config.appUrl,
              browserRelays: config.browserRelays,
              store: new PostgresPreviewAccess(prisma),
              logger: { warn: (message) => logger.warn(message) },
            })
          },
          inject: [PRISMA],
        },
        PrismaLifecycle,
      ],
      exports: [PreviewGatewayServer],
    }
  }
}
