import { Logger } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { appLogger, listen, SHUTDOWN_SIGNALS } from '@repo/app-bootstrap'

import { AppModule } from './app.module.ts'
import type { McpConfig } from './config/config.ts'
import { mountMcp } from './server/mount-mcp.ts'

const logger = new Logger('mcp')

/** The MCP gateway: its own port, reachable by the sandboxes through sandbox-gw. */
export async function startMcp(config: McpConfig) {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config), {
    abortOnError: false,
    logger: appLogger(config.appEnv, 'mcp'),
  })
  app.disable('x-powered-by')
  app.enableShutdownHooks([...SHUTDOWN_SIGNALS])
  await mountMcp(app)
  const address = await listen(app, config.port, config.appEnv)
  // The profiles are the configuration's (MCP_CONTENT_PROFILE, MCP_BROWSER_PROFILE); the module
  // refuses them in production.
  logger.log(
    `mcp role listening on ${address} (/mcp, /health); content profile ${config.contentProfile}, browser profile ${config.browserProfile}`,
  )
  return app
}
