/* global console, process */
// The git worker of verify-runner.mjs (docs/plan/84-projects.md, ПР33): the server of the second
// entry of the core image (`dist/git-worker/main.js`) as a process of its own next to the stand's
// core — it outlives a kill -9 of core, as its container does — with the configuration that entry
// reads (`loadGitWorkerConfig`). Only the entry's `load-env` is left out: outside production
// main.js loads the nearest .env above the tree, and the file protocol of the stand's fixture
// repositories needs NODE_ENV=test. Started by verify-runner.mjs only, with its environment.
import { loadGitWorkerConfig } from '../dist/git-worker/config.js'
import { startGitWorker } from '../dist/git-worker/server.js'

if (process.env.NODE_ENV !== 'test') throw new Error('Started by verify-runner.mjs only')
// As main.js: what the worker writes is read by core, which shares its group, and nobody else.
process.umask(0o007)
const config = loadGitWorkerConfig(process.env)
const server = await startGitWorker({
  root: config.mirrorDir,
  ...(config.caFile === undefined ? {} : { caFile: config.caFile }),
  allowLoopback: config.allowLoopback,
  refusedSubnets: config.refusedSubnets,
  // As main.js outside production under NODE_ENV=test: the bare repositories of the fixture.
  allowFileProtocol: config.appEnv !== 'production',
})
console.log(`listening on ${server.socket}`)
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    void server.close().finally(() => process.exit(0))
  })
