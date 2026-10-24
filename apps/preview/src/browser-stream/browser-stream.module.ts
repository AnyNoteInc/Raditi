import { Logger, Module } from '@nestjs/common'
import type { PrismaClient } from '@repo/db'
import { PRISMA } from '@repo/service-runtime/tokens'

import { PREVIEW_CONFIG, type PreviewGatewayConfig } from '../config/config.tokens.ts'
import { BrowserStreamListener, PostgresBrowserStreamStore } from './browser-stream.ts'

/**
 * The stream of a task's browser (docs/plan/57-browser-tasks.md, Б12): its own listener, which
 * startPreview opens on BROWSER_STREAM_PORT. AppModule imports it only when the browser worker
 * is configured, so the factory always finds the stream's settings. No module injects the
 * listener, so the module exports nothing: startPreview takes it with app.get.
 */
@Module({
  providers: [
    {
      provide: BrowserStreamListener,
      useFactory: (config: PreviewGatewayConfig, prisma: PrismaClient) => {
        const stream = config.browserStream
        if (stream === null) throw new Error('The browser stream needs BROWSER_WORKER_URL')
        const logger = new Logger('BrowserStream')
        return new BrowserStreamListener({
          config: stream,
          appUrl: config.appUrl,
          store: new PostgresBrowserStreamStore(prisma),
          logger: { warn: (message) => logger.warn(message) },
        })
      },
      inject: [PREVIEW_CONFIG, PRISMA],
    },
  ],
})
export class BrowserStreamModule {}
