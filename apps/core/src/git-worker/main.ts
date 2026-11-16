import '@repo/app-bootstrap/load-env'

import { appLogger, SHUTDOWN_SIGNALS } from '@repo/app-bootstrap'
import { isProduction } from '@repo/domain'

import { loadGitWorkerConfig } from './config.ts'
import { startGitWorker } from './server.ts'

// The second entry of the core image (docs/plan/84-projects.md, ПР33): `node dist/git-worker/main.js`.
// No Nest application, no database, Redis or Vault — only the volume of the mirrors.

// Files the worker writes are read by core, which shares its group, and by nobody else.
process.umask(0o007)

let logger = appLogger('development', 'git-worker')
try {
  const config = loadGitWorkerConfig(process.env)
  logger = appLogger(config.appEnv, 'git-worker')
  const server = await startGitWorker({
    root: config.mirrorDir,
    ...(config.caFile === undefined ? {} : { caFile: config.caFile }),
    allowLoopback: config.allowLoopback,
    refusedSubnets: config.refusedSubnets,
    allowFileProtocol: !isProduction(config.appEnv) && process.env.NODE_ENV === 'test',
  })
  logger.log(`listening on ${server.socket}`)
  for (const signal of SHUTDOWN_SIGNALS)
    process.once(signal, () => {
      void server.close().finally(() => process.exit(0))
    })
} catch (err) {
  logger.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
}
