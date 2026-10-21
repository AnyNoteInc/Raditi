// Test doubles for the infra providers: the Nest apps compile without PostgreSQL, Redis,
// S3 or Vault. Only for *.test.ts files (excluded from the build).
import { getQueueToken } from '@nestjs/bullmq'
import type { TestingModuleBuilder } from '@nestjs/testing'
import { bucketKinds, queueNames, type BucketKind } from '@repo/domain'
import { PRISMA, SECRET_STORE } from '@repo/service-runtime'
import {
  fakeInfra as fakeSharedInfra,
  TEST_METRICS_TOKEN,
  type Dependencies as SharedDependencies,
} from '@repo/service-runtime/testing/fakes'
import { vi } from 'vitest'

import { loadConfig, type CoreConfig } from '../config/config.ts'
import { OBJECT_STORAGE, REDIS } from '../infra/tokens.ts'

const testEnv = {
  APP_ENV: 'test',
  APP_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://raditi:raditi@localhost:5432/raditi_test',
  REDIS_URL: 'redis://localhost:6379',
  S3_ENDPOINT: 'http://localhost:8333',
  S3_ACCESS_KEY_ID: 'raditi',
  S3_SECRET_ACCESS_KEY: 'raditi-dev-secret',
  VAULT_ADDR: 'http://localhost:8200',
  VAULT_DEV_ROOT_TOKEN: 'raditi-dev-root',
  SANDBOX_IMAGE: `raditi/sbx-wordpress@sha256:${'a'.repeat(64)}`,
  METRICS_TOKEN: TEST_METRICS_TOKEN,
}

export function testCoreConfig(): CoreConfig {
  return loadConfig(testEnv)
}

export interface Dependencies extends SharedDependencies {
  redis: boolean
  /** Buckets that do not answer. */
  missingBuckets: BucketKind[]
}

/** The shared infra fakes of @repo/service-runtime, with core's Redis, BullMQ queues and S3. */
export function fakeInfra(overrides: Partial<Dependencies> = {}) {
  const { redis = true, missingBuckets = [], ...shared } = overrides
  const down = () => Promise.reject(new Error('connect ECONNREFUSED'))
  return {
    ...fakeSharedInfra(shared),
    storage: {
      checkBuckets: vi.fn((kinds: readonly BucketKind[] = bucketKinds) =>
        Promise.resolve(
          Object.fromEntries(
            kinds.map((kind) => [kind, !missingBuckets.includes(kind)]),
          ) as Partial<Record<BucketKind, boolean>>,
        ),
      ),
    },
    redis: {
      status: redis ? 'ready' : 'reconnecting',
      ping: vi.fn(() => (redis ? Promise.resolve('PONG') : down())),
      quit: vi.fn(() => Promise.resolve('OK')),
      disconnect: vi.fn(),
    },
    queue: {
      add: vi.fn(() => Promise.resolve({ id: 'job' })),
      on: vi.fn(),
      close: vi.fn(() => Promise.resolve()),
      /** Forced close of a queue's connection (Redis unreachable on shutdown). */
      backendClose: vi.fn((_force?: boolean) => Promise.resolve()),
    },
  }
}

export type FakeInfra = ReturnType<typeof fakeInfra>

/** Replaces every provider of CoreModule that would open a connection. */
export function overrideCoreInfra(builder: TestingModuleBuilder, infra: FakeInfra) {
  let result = builder
    .overrideProvider(PRISMA)
    .useValue(infra.prisma)
    .overrideProvider(REDIS)
    .useValue(infra.redis)
    .overrideProvider(OBJECT_STORAGE)
    .useValue(infra.storage)
    .overrideProvider(SECRET_STORE)
    .useValue(infra.secrets)
  for (const name of queueNames) {
    const { backendClose, ...queue } = infra.queue
    result = result
      .overrideProvider(getQueueToken(name))
      .useValue({ ...queue, name, getBackend: () => ({ close: backendClose }) })
  }
  return result
}

export { TEST_METRICS_TOKEN }
