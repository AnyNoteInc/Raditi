import { ConsoleLogger, Logger, type INestApplication } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { isProduction, notImplemented, type AppEnv } from '@repo/domain'

import type { CoreConfig, McpConfig, OrchestratorConfig } from './config/config.ts'
import { CoreModule } from './core/core.module.ts'
import { McpAppModule } from './mcp/mcp-app.module.ts'
import { RunnerApiServer } from './runner-api/runner-api.server.ts'
import { createMcpStrategy, mountMcp } from './mcp/mcp-server.ts'

/** Hard stop when graceful shutdown hangs (e.g. a worker waiting for a stuck job). */
const SHUTDOWN_TIMEOUT_MS = 30_000
const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT'] as const
/** Outside production the HTTP ports answer this machine only. */
export const LOCAL_HOST = '127.0.0.1'

const logger = new Logger('Orchestrator')

function appLogger(appEnv: AppEnv): ConsoleLogger {
  return new ConsoleLogger({ prefix: 'Orchestrator', json: isProduction(appEnv) })
}

/**
 * The address to listen on: every interface in production (the container network and
 * sandbox-gw reach the ports), loopback only elsewhere. Docker Desktop still forwards
 * host.docker.internal to the host's loopback, so the dev Prometheus keeps scraping.
 */
export function listenHost(appEnv: AppEnv): string | undefined {
  return isProduction(appEnv) ? undefined : LOCAL_HOST
}

async function listen(app: INestApplication, port: number, appEnv: AppEnv): Promise<string> {
  const host = listenHost(appEnv)
  if (host === undefined) await app.listen(port)
  else await app.listen(port, host)
  return `${host ?? '*'}:${port}`
}

export async function startCore(config: CoreConfig): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(
    CoreModule.forRoot({ config, background: true }),
    { abortOnError: false, logger: appLogger(config.appEnv) },
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

export async function startMcp(config: McpConfig): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(McpAppModule.forRoot(config), {
    abortOnError: false,
    logger: appLogger(config.appEnv),
  })
  app.disable('x-powered-by')
  app.enableShutdownHooks([...SHUTDOWN_SIGNALS])
  await mountMcp(app, createMcpStrategy())
  const address = await listen(app, config.port, config.appEnv)
  logger.log(`mcp role listening on ${address} (/mcp, /health)`)
  return app
}

export interface RoleStarters {
  core: (config: CoreConfig) => Promise<INestApplication>
  mcp: (config: McpConfig) => Promise<INestApplication>
}

/** Roles that cannot run yet fail before any port opens. */
function assertStartable(config: OrchestratorConfig): void {
  if (config.roles.includes('runner')) throw notImplemented('runner role (P2)')
  if (config.mcp && isProduction(config.appEnv)) {
    throw notImplemented('mcp role in production: the per-task MCP token check (P6)')
  }
}

/**
 * Starts the selected roles, each as its own Nest app on its own port. Every app handles
 * SIGTERM/SIGINT through Nest shutdown hooks: HTTP servers stop, workers and polling loops
 * finish, connections close, then the signal is re-raised and the process exits.
 */
export async function startRoles(
  config: OrchestratorConfig,
  starters: RoleStarters = { core: startCore, mcp: startMcp },
): Promise<INestApplication[]> {
  assertStartable(config)

  const apps: INestApplication[] = []
  try {
    if (config.core) apps.push(await starters.core(config.core))
    if (config.mcp) apps.push(await starters.mcp(config.mcp))
  } catch (err) {
    await Promise.allSettled(apps.map((app) => app.close()))
    throw err
  }

  for (const signal of SHUTDOWN_SIGNALS) {
    process.once(signal, () => {
      logger.log(`${signal} received, shutting down`)
      setTimeout(() => {
        logger.error(`Shutdown took longer than ${SHUTDOWN_TIMEOUT_MS} ms, exiting`)
        process.exit(1)
      }, SHUTDOWN_TIMEOUT_MS).unref()
    })
  }
  return apps
}
