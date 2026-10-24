import type { Server } from 'node:http'

import { Logger, type NestApplicationOptions } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { appLogger, SHUTDOWN_SIGNALS } from '@repo/app-bootstrap'

import { WorkerApiFilter } from './api/worker-api.filter.ts'
import { AppModule } from './app.module.ts'
import type { BrowserWorkerConfig } from './config/config.ts'
import { BrowserWorker } from './worker/browser-worker.ts'

const logger = new Logger('browser')

/**
 * How the app is made: no body parser of Nest's, so nothing reads a body before the token is
 * checked — the API reads its bodies itself.
 */
export function browserAppOptions(config: BrowserWorkerConfig): NestApplicationOptions {
  return { abortOnError: false, bodyParser: false, logger: appLogger(config.appEnv, 'browser') }
}

/**
 * The browser worker on its own port (docs/plan/57-browser-tasks.md, Б10): the API of the
 * sessions, their stream, /health and /metrics, on BROWSER_WORKER_HOST — loopback outside
 * production unless set.
 */
export async function startBrowser(config: BrowserWorkerConfig) {
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.forRoot(config),
    browserAppOptions(config),
  )
  return serveBrowser(app, config)
}

/**
 * What every browser app gets before it listens — the refusals of the API as codes, the shutdown
 * on the signals of the container, the stream on the HTTP server — and its port. The tests give it
 * an app of their own module, with stand-ins (src/testing/app.ts).
 */
export async function serveBrowser(app: NestExpressApplication, config: BrowserWorkerConfig) {
  app.disable('x-powered-by')
  app.useGlobalFilters(new WorkerApiFilter(app.getHttpAdapter()))
  app.enableShutdownHooks([...SHUTDOWN_SIGNALS])
  app.get(BrowserWorker).listenOn(app.getHttpServer() as Server)
  try {
    const host = config.host
    if (host === undefined) await app.listen(config.port)
    else await app.listen(config.port, host)
    logger.log(`browser role listening on ${host ?? '*'}:${config.port} (/v1/sessions, /health)`)
  } catch (err) {
    await app.close()
    throw err
  }
  return app
}
