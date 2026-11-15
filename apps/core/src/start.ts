import { Logger, type INestApplication } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { appLogger, listen, listenHost, SHUTDOWN_SIGNALS } from '@repo/app-bootstrap'

import type { CoreConfig } from './config/config.ts'
import { AppModule } from './app.module.ts'
import { RunnerApiServer } from './runner-api/runner-api.server.ts'

const logger = new Logger('core')

/**
 * Core (spec §5): /health and /metrics on CORE_PORT, never on the MCP port; with runner
 * VMs also the runner API on RUNNER_API_PORT.
 */
export async function startCore(config: CoreConfig): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.forRoot({ config, background: true }),
    { abortOnError: false, logger: appLogger(config.appEnv, 'core') },
  )
  app.disable('x-powered-by')
  app.enableShutdownHooks([...SHUTDOWN_SIGNALS])
  const address = await listen(app, config.port, config.appEnv)
  logger.log(`core role listening on ${address} (/health, /metrics)`)
  if (config.runnerApi) {
    try {
      const host = listenHost(config.appEnv)
      const runnerApi = await app.get(RunnerApiServer).listen(config.runnerApi.port, host)
      logger.log(`runner API listening on ${host ?? '*'}:${runnerApi.port}`)
    } catch (err) {
      await app.close()
      throw err
    }
  }
  return app
}
