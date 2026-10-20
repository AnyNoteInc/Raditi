import { Logger } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { PreviewGatewayServer } from '@repo/preview-gateway'
import { appLogger, SHUTDOWN_SIGNALS } from '@repo/app-bootstrap'

import type { PreviewGatewayConfig } from './config.ts'
import { PreviewGatewayModule } from './preview-gateway.module.ts'

const logger = new Logger('preview')

/**
 * The gateway of previews: its own port, on PREVIEW_GATEWAY_HOST — loopback outside production
 * unless a stand names the Docker bridge (docs/plan/53-chat-preview-release.md, Р19, Р21).
 */
export async function startPreview(config: PreviewGatewayConfig) {
  const app = await NestFactory.createApplicationContext(PreviewGatewayModule.forRoot(config), {
    abortOnError: false,
    logger: appLogger(config.appEnv, 'preview'),
  })
  app.enableShutdownHooks([...SHUTDOWN_SIGNALS])
  try {
    const host = config.host
    const address = await app.get(PreviewGatewayServer).listen(config.port, host)
    logger.log(`preview role listening on ${host ?? '*'}:${address.port}`)
  } catch (err) {
    await app.close()
    throw err
  }
  return app
}
