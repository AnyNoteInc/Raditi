// The preview app as a process of its own for core's tests (docs/plan/56-nest-modules.md, §2,
// decision 4): the build of apps/preview (`pnpm --filter preview build`), started as compose
// starts it and never imported — apps talk over the network. Only for *.test.ts files.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { PreviewAddress } from '@repo/domain'

const directory = fileURLToPath(new URL('../../../preview/', import.meta.url))
const main = join(directory, 'dist/main.js')
// Loaded into the app by --import: it connects to nothing outside this machine either.
const networkGuard = import.meta.resolve('@repo/app-bootstrap/testing/network-guard')
const STARTUP_MS = 30_000

export interface PreviewAppOptions {
  databaseUrl: string
  /** PREVIEW_BASE_DOMAIN, PREVIEW_SCHEME and PREVIEW_PUBLIC_PORT. */
  address: PreviewAddress
  /** PREVIEW_GATEWAY_PORT. */
  port: number
  /** PREVIEW_GATEWAY_HOST. */
  host: string
  appUrl: string
  sessionSecret: string
}

export interface PreviewApp {
  /**
   * SIGTERM, as compose stops it, then its exit; fails when the guard refused a connection or the
   * app did not stop by that SIGTERM or with code 0.
   */
  stop(): Promise<void>
}

/**
 * Starts the preview app and waits for its own start line and its /__raditi/health: another
 * server on the port (an app a killed test worker left behind) answers the health check too, while
 * this one dies of EADDRINUSE.
 */
export async function startPreviewApp(options: PreviewAppOptions): Promise<PreviewApp> {
  if (!existsSync(main))
    throw new Error(`${main} is missing: build the preview app first (pnpm --filter preview build)`)
  const refusals = join(tmpdir(), `raditi-guard-${randomUUID()}`)
  const { address } = options
  const child = spawn(
    process.execPath,
    ['--import', `${networkGuard}?report=${encodeURIComponent(refusals)}`, 'dist/main.js'],
    {
      cwd: directory,
      env: {
        PATH: process.env.PATH,
        // load-env reads no .env in production; APP_ENV keeps the checks of a test.
        NODE_ENV: 'production',
        NO_COLOR: '1',
        APP_ENV: 'test',
        DATABASE_URL: options.databaseUrl,
        APP_URL: options.appUrl,
        PREVIEW_BASE_DOMAIN: address.baseDomain,
        PREVIEW_SCHEME: address.scheme,
        ...(address.publicPort === null ? {} : { PREVIEW_PUBLIC_PORT: String(address.publicPort) }),
        PREVIEW_GATEWAY_PORT: String(options.port),
        PREVIEW_GATEWAY_HOST: options.host,
        PREVIEW_SESSION_SECRET: options.sessionSecret,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let output = ''
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk: Buffer) => (output += chunk.toString()))
  const exited = once(child, 'exit')
  // A failed spawn rejects it; whoever awaits it next sees that.
  exited.catch(() => undefined)
  const running = () => child.exitCode === null && child.signalCode === null

  // What start.ts logs once its server listens (preview role listening on <host>:<port>).
  const listening = `preview role listening on ${options.host}:${options.port}`
  const health = `http://${options.host === '0.0.0.0' ? '127.0.0.1' : options.host}:${options.port}/__raditi/health`
  const deadline = Date.now() + STARTUP_MS
  for (;;) {
    if (!running()) throw new Error(`The preview app exited before it answered:\n${output}`)
    const ready =
      output.includes(listening) &&
      (await fetch(health).then(
        (answer) => answer.ok,
        () => false,
      )) &&
      running()
    if (ready) break
    if (Date.now() > deadline) {
      child.kill('SIGKILL')
      await exited
      throw new Error(`The preview app did not answer ${health} in ${STARTUP_MS} ms:\n${output}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }

  return {
    async stop() {
      if (running()) child.kill('SIGTERM')
      await exited
      // The file exists only when the guard refused something.
      const refused = existsSync(refusals) ? readFileSync(refusals, 'utf8') : ''
      rmSync(refusals, { force: true })
      if (refused !== '')
        throw new Error(
          `The preview app tried to connect or to resolve a name outside this machine: ${refused}`,
        )
      // Nest closes the app on SIGTERM and raises the signal again; anything else is a failure.
      const { exitCode, signalCode } = child
      if (signalCode !== 'SIGTERM' && exitCode !== 0)
        throw new Error(
          `The preview app stopped with ${signalCode ?? `code ${String(exitCode)}`}:\n${output}`,
        )
    },
  }
}
