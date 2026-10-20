import { Logger, type INestApplication } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { appLogger, listen, listenHost, SHUTDOWN_SIGNALS } from '@repo/app-bootstrap'

import type { CoreConfig } from './config/config.ts'
import { CoreModule } from './core/core.module.ts'
import { ReleaseApiServer } from './release-api/release-api.server.ts'
import { RunnerApiServer } from './runner-api/runner-api.server.ts'

const logger = new Logger('core')

/**
 * Core (spec §5): /health and /metrics on CORE_PORT, never on the MCP port; with runner
 * VMs also the runner API on RUNNER_API_PORT, and the release API on RELEASE_API_PORT.
 */
export async function startCore(config: CoreConfig): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(
    CoreModule.forRoot({ config, background: true }),
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
  if (config.releaseApi) {
    try {
      // The address deploy jobs reach: set explicitly (RELEASE_API_HOST), loopback by default in dev.
      const releaseApi = await app
        .get(ReleaseApiServer)
        .listen(config.releaseApi.port, config.releaseApi.host)
      logger.log(`release API listening on ${config.releaseApi.host}:${releaseApi.port}`)
    } catch (err) {
      await app.close()
      throw err
    }
  }
  return app
}
