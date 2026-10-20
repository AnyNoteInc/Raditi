import { ConsoleLogger, type INestApplication, type Logger } from '@nestjs/common'
import { isProduction, type AppEnv } from '@repo/domain'

/** Hard stop when graceful shutdown hangs (e.g. a worker waiting for a stuck job). */
export const SHUTDOWN_TIMEOUT_MS = 30_000
export const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT'] as const
/** Outside production the HTTP ports answer this machine only. */
export const LOCAL_HOST = '127.0.0.1'

/**
 * The logger of an app: its lines start with `[<app>]` — the name of the app's container (core,
 * llm, mcp, preview, runner) — and are one JSON line per record in production.
 */
export function appLogger(appEnv: AppEnv, app: string): ConsoleLogger {
  return new ConsoleLogger({ prefix: app, json: isProduction(appEnv) })
}

/**
 * The address to listen on: every interface in production (the container network and
 * sandbox-gw reach the ports), loopback only elsewhere. Docker Desktop still forwards
 * host.docker.internal to the host's loopback, so the dev Prometheus keeps scraping.
 */
export function listenHost(appEnv: AppEnv): string | undefined {
  return isProduction(appEnv) ? undefined : LOCAL_HOST
}

/** Listens on `port` at the address of `listenHost`; returns what it listens on, for the log. */
export async function listen(app: INestApplication, port: number, appEnv: AppEnv): Promise<string> {
  const host = listenHost(appEnv)
  if (host === undefined) await app.listen(port)
  else await app.listen(port, host)
  return `${host ?? '*'}:${port}`
}

/**
 * Every app handles SIGTERM/SIGINT through Nest shutdown hooks: HTTP servers stop, workers and
 * polling loops finish, connections close, then the signal is re-raised and the process exits.
 * This only arms the hard stop for a shutdown that hangs.
 */
export function armShutdownTimeout(logger: Logger): void {
  for (const signal of SHUTDOWN_SIGNALS) {
    process.once(signal, () => {
      logger.log(`${signal} received, shutting down`)
      setTimeout(() => {
        logger.error(`Shutdown took longer than ${SHUTDOWN_TIMEOUT_MS} ms, exiting`)
        process.exit(1)
      }, SHUTDOWN_TIMEOUT_MS).unref()
    })
  }
}
