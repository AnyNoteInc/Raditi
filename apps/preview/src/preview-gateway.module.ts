import { Logger, Module, type DynamicModule } from '@nestjs/common'
import type { PrismaClient } from '@repo/db'

import { PostgresPreviewAccess, PreviewGatewayServer } from '@repo/preview-gateway'
import { createAppPrisma, PRISMA, PrismaLifecycle } from '@repo/service-runtime'

import type { PreviewGatewayConfig } from './config.ts'
import { PREVIEW_GATEWAY_CONFIG } from './tokens.ts'

/**
 * The preview app (docs/plan/53-chat-preview-release.md, Р19, R6): a trusted process with the
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
        { provide: PRISMA, useFactory: () => createAppPrisma(config.db) },
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
