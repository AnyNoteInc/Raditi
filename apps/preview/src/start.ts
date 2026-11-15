import { Logger } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { appLogger, SHUTDOWN_SIGNALS } from '@repo/app-bootstrap'

import { AppModule } from './app.module.ts'
import { BrowserStreamListener } from './browser-stream/browser-stream.ts'
import type { PreviewConfig } from './config/config.ts'
import { PagesServer } from './pages/pages-server.ts'

const logger = new Logger('preview')

/**
 * The listeners of the preview app: with the browser worker configured, the stream of a chat's
 * browser on BROWSER_STREAM_PORT (docs/plan/57-browser-tasks.md, Б12); with PAGES_BASE_DOMAIN, the
 * published pages on PAGES_PORT (docs/plan/69-pages.md, Ст4), which also answers the health of the
 * role, `GET /__raditi/health` on any host that is not a page's.
 */
export async function startPreview(config: PreviewConfig) {
  const app = await NestFactory.createApplicationContext(AppModule.forRoot(config), {
    abortOnError: false,
    logger: appLogger(config.appEnv, 'preview'),
  })
  app.enableShutdownHooks([...SHUTDOWN_SIGNALS])
  try {
    const stream = config.browserStream
    if (stream !== null) {
      const streamAddress = await app.get(BrowserStreamListener).listen(stream.port, stream.host)
      logger.log(`browser stream listening on ${stream.host ?? '*'}:${streamAddress.port}`)
    }
    const pages = config.pages
    if (pages !== null) {
      const pagesAddress = await app.get(PagesServer).listen(pages.port, pages.host)
      logger.log(`pages listening on ${pages.host ?? '*'}:${pagesAddress.port}`)
    }
  } catch (err) {
    await app.close()
    throw err
  }
  return app
}
