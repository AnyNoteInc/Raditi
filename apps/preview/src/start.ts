import { Logger } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { appLogger, SHUTDOWN_SIGNALS } from '@repo/app-bootstrap'

import { AppModule } from './app.module.ts'
import { BrowserStreamListener } from './browser-stream/browser-stream.ts'
import type { PreviewGatewayConfig } from './config/config.ts'
import { PreviewGatewayServer } from './gateway/preview-gateway.server.ts'

const logger = new Logger('preview')

/**
 * The gateway of previews: its own port, on PREVIEW_GATEWAY_HOST — loopback outside production
 * unless a stand names the Docker bridge (docs/plan/53-chat-preview-release.md, Р19, Р21). With
 * the browser worker configured, also the stream of a task's browser on BROWSER_STREAM_PORT
 * (docs/plan/57-browser-tasks.md, Б12); health stays on the preview port.
 */
export async function startPreview(config: PreviewGatewayConfig) {
  const app = await NestFactory.createApplicationContext(AppModule.forRoot(config), {
    abortOnError: false,
    logger: appLogger(config.appEnv, 'preview'),
  })
  app.enableShutdownHooks([...SHUTDOWN_SIGNALS])
  try {
    const host = config.host
    const address = await app.get(PreviewGatewayServer).listen(config.port, host)
    logger.log(`preview role listening on ${host ?? '*'}:${address.port}`)
    const stream = config.browserStream
    if (stream !== null) {
      const streamAddress = await app.get(BrowserStreamListener).listen(stream.port, stream.host)
      logger.log(`browser stream listening on ${stream.host ?? '*'}:${streamAddress.port}`)
    }
  } catch (err) {
    await app.close()
    throw err
  }
  return app
}
