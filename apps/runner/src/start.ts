import { Logger } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { RunnerModule } from '@repo/runner-engine'
import { appLogger, SHUTDOWN_SIGNALS } from '@repo/app-bootstrap'

import type { RunnerConfig } from './config.ts'

const logger = new Logger('runner')

/**
 * The runner opens no port: an application context that polls core's runner API and drives the
 * VM's Docker. A session core retired ends the process, which then restarts as a new session.
 */
export async function startRunner(config: RunnerConfig) {
  const app = await NestFactory.createApplicationContext(
    RunnerModule.forRoot(config, {
      onRetired: () => {
        process.exitCode = 1
        process.kill(process.pid, 'SIGTERM')
      },
    }),
    { abortOnError: false, logger: appLogger(config.appEnv, 'runner') },
  )
  app.enableShutdownHooks([...SHUTDOWN_SIGNALS])
  logger.log('runner role polling core (no HTTP server)')
  return app
}
