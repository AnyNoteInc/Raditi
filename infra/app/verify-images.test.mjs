// The pure rules of verify:images: which workspace packages, npm modules and stands an image may
// not carry, and which operator's commands it keeps.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { matchesGlob } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  APPS,
  forbiddenModulesOf,
  forbiddenPackagesOf,
  missingOperatorScriptsOf,
  OPERATOR_SCRIPTS,
  standFilesOf,
} from './verify-images.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))

/** The patterns of the repository's .dockerignore, the build context of every app image. */
const DOCKER_IGNORE = readFileSync(new URL('../../.dockerignore', import.meta.url), 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line !== '' && !line.startsWith('#'))

/**
 * Whether Docker leaves a path of the repository out of the build context: a pattern decides when
 * it matches the path or one of its parent directories, the last such pattern wins, and `!` takes
 * the path back.
 */
function ignoredByDocker(file) {
  const parts = file.split('/')
  const paths = parts.map((_, index) => parts.slice(0, index + 1).join('/'))
  let ignored = false
  for (const line of DOCKER_IGNORE) {
    const kept = line.startsWith('!')
    const pattern = kept ? line.slice(1) : line
    if (paths.some((path) => matchesGlob(path, pattern))) ignored = !kept
  }
  return ignored
}

/**
 * The files of `<directory>/scripts` the repository tracks, as paths from its root: a local file
 * nobody committed is in no image Docker builds from a checkout, and changes no verdict here.
 */
function scriptsOf(directory) {
  return execFileSync('git', ['ls-files', '-z', '--', `${directory}/scripts/`], {
    cwd: ROOT,
    encoding: 'utf8',
  })
    .split('\0')
    .filter((path) => path !== '' && !path.slice(`${directory}/scripts/`.length).includes('/'))
}

test('every app the stand builds has its own Dockerfile and a list of what it may not carry', () => {
  for (const app of APPS)
    assert.match(
      readFileSync(new URL(`../../apps/${app}/Dockerfile`, import.meta.url), 'utf8'),
      /AS runtime/,
    )
})

test('the runner image may carry the frame of a process, never the data of the platform', () => {
  assert.deepEqual(
    forbiddenPackagesOf('runner', ['app-bootstrap', 'domain', 'local-turns', 'snapshots']),
    [],
  )
  assert.deepEqual(forbiddenPackagesOf('runner', ['app-bootstrap', 'db', 'service-runtime']), [
    'db',
    'service-runtime',
  ])
  // Neither the provider's process nor a sandbox VM reaches the browser worker.
  assert.deepEqual(forbiddenPackagesOf('runner', ['browser-link']), ['browser-link'])
  assert.deepEqual(forbiddenPackagesOf('llm', ['browser-link']), ['browser-link'])
  // The apps with a database carry it.
  assert.deepEqual(forbiddenPackagesOf('llm', ['db', 'service-runtime', 'vault']), [])
  assert.deepEqual(forbiddenPackagesOf('preview', ['db', 'vault']), ['vault'])
})

test('the browser worker carries its adapters and the inbox, never Vault, git or the agent', () => {
  assert.deepEqual(
    forbiddenPackagesOf('browser', [
      'app-bootstrap',
      'browser-link',
      'browser-providers',
      'db',
      'domain',
      'ip-address',
      'observability',
      'sandbox-providers',
      'service-runtime',
      'site-adapters',
      'storage',
    ]),
    [],
  )
  assert.deepEqual(forbiddenPackagesOf('browser', ['vault', 'agent-drivers', 'turn-keys']), [
    'vault',
    'agent-drivers',
    'turn-keys',
  ])
})

test('the installed modules of the runner hold no Prisma, pg, S3 SDK or BullMQ', () => {
  assert.deepEqual(
    forbiddenModulesOf([
      '@nestjs+core@12.1.0_x',
      'ioredis@6.0.0_supports-color@7.2.0',
      '@prisma+client@7.10.0_x',
      'prisma@7.10.0_x',
      'pg@8.23.0',
      '@aws-sdk+client-s3@3.900.0',
      'bullmq@6.3.0',
      'pgpass@1.0.5',
    ]),
    [
      '@prisma+client@7.10.0_x',
      'prisma@7.10.0_x',
      'pg@8.23.0',
      '@aws-sdk+client-s3@3.900.0',
      'bullmq@6.3.0',
    ],
  )
})

test('an image carries no stand, stand test or fixture, and keeps the operator commands', () => {
  assert.deepEqual(
    standFilesOf([
      '/app/apps/llm/scripts/subscription-login.mjs',
      '/app/apps/llm/scripts/verify-llm-worker.mjs',
      '/app/apps/mcp/scripts/verify-content-worker.mjs',
      '/app/apps/core/scripts/billing-refund.mjs',
      '/app/apps/core/scripts/releases-resolve.mjs',
      '/app/apps/core/scripts/verify-agent-supervisor.test.mjs',
      '/app/apps/core/scripts/opencode-runner-fixture.mjs',
      '/app/apps/runner/scripts/runner-token.mjs',
      '/app/packages/agent-drivers/scripts/verify-opencode.mjs',
      '/app/packages/sandbox-providers/runtime/runtime.mjs',
    ]),
    [
      '/app/apps/llm/scripts/verify-llm-worker.mjs',
      '/app/apps/mcp/scripts/verify-content-worker.mjs',
      '/app/apps/core/scripts/verify-agent-supervisor.test.mjs',
      '/app/apps/core/scripts/opencode-runner-fixture.mjs',
      '/app/packages/agent-drivers/scripts/verify-opencode.mjs',
    ],
  )
  assert.deepEqual(missingOperatorScriptsOf('llm', ['subscription-login.mjs']), [
    'subscription-retire.mjs',
    'subscription-token.mjs',
  ])
  assert.deepEqual(missingOperatorScriptsOf('mcp', []), [])
  assert.deepEqual(missingOperatorScriptsOf('browser', []), [])
})

test('the .dockerignore matcher of these tests reads the file as Docker does', () => {
  assert.equal(ignoredByDocker('apps/core/src/main.ts'), false)
  // A pattern that matches a parent directory leaves out everything under it.
  assert.equal(ignoredByDocker('apps/core/dist/main.js'), true)
  assert.equal(ignoredByDocker('infra/app/verify-images.mjs'), true)
  // The last pattern that matches decides, and `!` takes the path back.
  assert.equal(ignoredByDocker('infra/sandbox/watchdog.mjs'), false)
  assert.equal(ignoredByDocker('apps/web/.env.local'), true)
  assert.equal(ignoredByDocker('.env.example'), false)
})

test('.dockerignore leaves out exactly the stands, never an operator command of an app', () => {
  // core is built by verify:edge and verify:release, not by verify:images; its operator commands
  // run in its image on the app VM
  // (`docker compose run --entrypoint node core scripts/billing-refund.mjs …`).
  const kept = {
    ...OPERATOR_SCRIPTS,
    core: [
      'billing-rates.mjs',
      'billing-refund.mjs',
      'billing-refunds-needed.mjs',
      'billing-settle-payment.mjs',
      'billing-stop-renewal.mjs',
      'releases-resolve.mjs',
    ],
  }
  // The stands of the packages the images carry go too (the runner image holds agent-drivers and
  // sandbox-providers); the image check of verify:images knows a stand by STAND_FILE alone.
  const packages = readdirSync(new URL('../../packages/', import.meta.url)).map(
    (name) => `packages/${name}`,
  )
  for (const directory of [...Object.keys(kept).map((app) => `apps/${app}`), ...packages]) {
    const files = scriptsOf(directory)
    assert.deepEqual(files.filter(ignoredByDocker), standFilesOf(files), `${directory}/scripts`)
  }
  for (const [app, names] of Object.entries(kept))
    assert.deepEqual(
      scriptsOf(`apps/${app}`)
        .filter((file) => !ignoredByDocker(file))
        .sort(),
      names.map((name) => `apps/${app}/scripts/${name}`).sort(),
      `apps/${app}/scripts`,
    )
})
