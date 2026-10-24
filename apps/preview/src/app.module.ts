import { Module, type DynamicModule } from '@nestjs/common'
import { DatabaseModule } from '@repo/service-runtime'

import { BrowserStreamModule } from './browser-stream/browser-stream.module.ts'
import { PreviewConfigModule } from './config/config.module.ts'
import type { PreviewGatewayConfig } from './config/config.ts'
import { GatewayModule } from './gateway/gateway.module.ts'

/**
 * The preview app (docs/plan/53-chat-preview-release.md, Р19, R6): a trusted process with the
 * database that routes the exact Host of a preview to its upstream. startPreview opens
 * PreviewGatewayServer on PREVIEW_GATEWAY_PORT and, when the browser worker is configured,
 * BrowserStreamListener on BROWSER_STREAM_PORT (docs/plan/57-browser-tasks.md, Б12). The
 * database module is global, so Nest closes its pool after the gateway and the stream have
 * closed.
 */
@Module({})
export class AppModule {
  static forRoot(config: PreviewGatewayConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        PreviewConfigModule.forRoot(config),
        DatabaseModule.forRoot(config.db),
        GatewayModule,
        // The module reads its settings through PREVIEW_CONFIG; they are there whenever it is.
        ...(config.browserStream === null ? [] : [BrowserStreamModule]),
      ],
    }
  }
}
