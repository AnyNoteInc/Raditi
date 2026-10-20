// The pure rules of verify:images: which workspace packages and npm modules an image may not carry.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { APPS, forbiddenModulesOf, forbiddenPackagesOf } from './verify-images.mjs'

test('every app the stand builds has its own Dockerfile and a list of what it may not carry', () => {
  for (const app of APPS)
    assert.match(
      readFileSync(new URL(`../../apps/${app}/Dockerfile`, import.meta.url), 'utf8'),
      /AS runtime/,
    )
})

test('the runner image may carry the frame of a process, never the data of the platform', () => {
  assert.deepEqual(
    forbiddenPackagesOf('runner', ['app-bootstrap', 'domain', 'runner-engine', 'snapshots']),
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
