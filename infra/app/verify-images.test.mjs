// The pure rules of verify:images: which workspace packages, npm modules and stands an image may
// not carry, and which operator's commands it keeps.
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'

import {
  APPS,
  forbiddenModulesOf,
  forbiddenPackagesOf,
  missingOperatorScriptsOf,
  OPERATOR_SCRIPTS,
  standFilesOf,
} from './verify-images.mjs'

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
  // The apps with a database carry it.
  assert.deepEqual(forbiddenPackagesOf('llm', ['db', 'service-runtime', 'vault']), [])
  assert.deepEqual(forbiddenPackagesOf('preview', ['db', 'vault']), ['vault'])
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
  // Every command the list names lies next to the stands of its app, and .dockerignore keeps it.
  const ignored = readFileSync(new URL('../../.dockerignore', import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => line !== '' && !line.startsWith('#'))
  for (const app of APPS)
    for (const name of OPERATOR_SCRIPTS[app]) {
      assert.ok(readFileSync(new URL(`../../apps/${app}/scripts/${name}`, import.meta.url), 'utf8'))
      assert.deepEqual(standFilesOf([`/app/apps/${app}/scripts/${name}`]), [])
    }
  for (const pattern of [
    '**/scripts/verify-*.mjs',
    '**/scripts/*.test.mjs',
    'apps/core/scripts/opencode-runner-fixture*.mjs',
  ])
    assert.ok(ignored.includes(pattern), `.dockerignore has no ${pattern}`)
})

test('what is left of the scripts of every app in its image is exactly its operator commands', () => {
  // core is built by verify:edge and verify:release; its operator commands run in its image on the
  // app VM (`docker compose run --entrypoint node core scripts/billing-refund.mjs …`).
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
  for (const [app, names] of Object.entries(kept)) {
    const directory = new URL(`../../apps/${app}/scripts/`, import.meta.url)
    const files = existsSync(directory)
      ? readdirSync(directory).filter((name) => name.endsWith('.mjs'))
      : []
    const stands = new Set(standFilesOf(files.map((name) => `/app/apps/${app}/scripts/${name}`)))
    assert.deepEqual(
      files.filter((name) => !stands.has(`/app/apps/${app}/scripts/${name}`)).sort(),
      [...names].sort(),
      `apps/${app}/scripts`,
    )
  }
})
