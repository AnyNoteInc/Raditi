import {
  ConsoleLogger,
  Logger,
  type INestApplication,
  type INestApplicationContext,
} from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { isProduction, type AppEnv } from '@repo/domain'

import type {
  CoreConfig,
  LlmRoleConfig,
  McpConfig,
  OrchestratorConfig,
  PreviewGatewayConfig,
  RunnerConfig,
} from './config/config.ts'
import { CoreModule } from './core/core.module.ts'
import { LlmAppModule, LlmRuntime } from './llm-gateway/llm-app.module.ts'
import { McpAppModule } from './mcp/mcp-app.module.ts'
import { mountMcp } from './mcp/mcp-server.ts'
import { PreviewGatewayModule } from './preview-gateway/preview-gateway.module.ts'
import { PreviewGatewayServer } from './preview-gateway/preview-gateway.server.ts'
import { ReleaseApiServer } from './release-api/release-api.server.ts'
import { RunnerApiServer } from './runner-api/runner-api.server.ts'
import { RunnerModule } from './runner/runner.module.ts'

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

/**
 * The gateway of previews: its own port, on PREVIEW_GATEWAY_HOST — loopback outside production
 * unless a stand names the Docker bridge (docs/plan/53, Р19, Р21).
 */
export async function startPreview(config: PreviewGatewayConfig): Promise<INestApplicationContext> {
  const app = await NestFactory.createApplicationContext(PreviewGatewayModule.forRoot(config), {
    abortOnError: false,
    logger: appLogger(config.appEnv),
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

export async function startMcp(config: McpConfig): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(McpAppModule.forRoot(config), {
    abortOnError: false,
    logger: appLogger(config.appEnv),
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

/**
 * The runner role opens no port: an application context that polls core's runner API and
 * drives the VM's Docker. A session core retired ends the process, which then restarts as a
 * new session.
 */
export async function startRunner(config: RunnerConfig): Promise<INestApplicationContext> {
  const app = await NestFactory.createApplicationContext(
    RunnerModule.forRoot(config, {
      onRetired: () => {
        process.exitCode = 1
        process.kill(process.pid, 'SIGTERM')
      },
    }),
    { abortOnError: false, logger: appLogger(config.appEnv) },
  )
  app.enableShutdownHooks([...SHUTDOWN_SIGNALS])
  logger.log('runner role polling core (no HTTP server)')
  return app
}

export async function startLlm(config: LlmRoleConfig): Promise<INestApplicationContext> {
  const app = await NestFactory.createApplicationContext(LlmAppModule.forRoot(config), {
    abortOnError: false,
    logger: appLogger(config.appEnv),
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

export interface RoleStarters {
  core: (config: CoreConfig) => Promise<INestApplicationContext>
  mcp: (config: McpConfig) => Promise<INestApplicationContext>
  runner: (config: RunnerConfig) => Promise<INestApplicationContext>
  llm: (config: LlmRoleConfig) => Promise<INestApplicationContext>
  preview: (config: PreviewGatewayConfig) => Promise<INestApplicationContext>
}

/**
 * Starts the selected roles, each as its own Nest app: core and mcp on their own ports, the
 * runner without one. Every app handles SIGTERM/SIGINT through Nest shutdown hooks: HTTP
 * servers stop, workers and polling loops finish, connections close, then the signal is
 * re-raised and the process exits.
 */
export async function startRoles(
  config: OrchestratorConfig,
  starters: RoleStarters = {
    core: startCore,
    mcp: startMcp,
    runner: startRunner,
    llm: startLlm,
    preview: startPreview,
  },
): Promise<INestApplicationContext[]> {
  const apps: INestApplicationContext[] = []
  try {
    if (config.core) apps.push(await starters.core(config.core))
    if (config.mcp) apps.push(await starters.mcp(config.mcp))
    if (config.llm) apps.push(await starters.llm(config.llm))
    if (config.preview) apps.push(await starters.preview(config.preview))
    if (config.runner) apps.push(await starters.runner(config.runner))
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
