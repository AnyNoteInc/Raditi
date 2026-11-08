import { Logger } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { readFile } from 'node:fs/promises'
import { appLogger, SHUTDOWN_SIGNALS } from '@repo/app-bootstrap'

import { AppModule } from './app.module.ts'
import type { RunnerConfig } from './config/config.ts'
import { trustCertificateAuthority } from './config/trusted-ca.ts'

const logger = new Logger('runner')

/**
 * The runner opens no port: an application context that polls core's runner API and drives the
 * VM's Docker. A session core retired ends the process, which then restarts as a new session.
 */
export async function startRunner(config: RunnerConfig) {
  // Presigned transfers use the global fetch: a private S3 CA must be a default root before them
  if (config.s3CaFile) trustCertificateAuthority(await readFile(config.s3CaFile, 'utf8'))
  const app = await NestFactory.createApplicationContext(
    AppModule.forRoot(config, {
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
