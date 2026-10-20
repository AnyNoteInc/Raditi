import { Logger } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { appLogger, SHUTDOWN_SIGNALS } from '@repo/app-bootstrap'

import type { LlmRoleConfig } from './config.ts'
import { LlmAppModule, LlmRuntime } from './gateway/llm-app.module.ts'

const logger = new Logger('llm')

/** The subscription gateway: an application context that listens on its own port. */
export async function startLlm(config: LlmRoleConfig) {
  const app = await NestFactory.createApplicationContext(LlmAppModule.forRoot(config), {
    abortOnError: false,
    logger: appLogger(config.appEnv, 'llm'),
  })
  app.enableShutdownHooks([...SHUTDOWN_SIGNALS])
  try {
    const address = await app.get(LlmRuntime).listen()
    logger.log(`llm role listening on ${address.address}:${address.port}`)
  } catch (err) {
    await app.close()
    throw err
  }
  return app
}
