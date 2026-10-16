// Test doubles for the infra providers: the Nest apps compile without PostgreSQL, Redis,
// S3 or Vault. Only for *.test.ts files (excluded from the build).
import { getQueueToken } from '@nestjs/bullmq'
import type { TestingModuleBuilder } from '@nestjs/testing'
import { bucketKinds, queueNames, type BucketKind } from '@repo/domain'
import { vi } from 'vitest'

import { loadConfig, type CoreConfig, type McpConfig, type RunnerConfig } from '../config/config.ts'
import { OBJECT_STORAGE, PRISMA, REDIS, SECRET_STORE } from '../infra/tokens.ts'

export const TEST_METRICS_TOKEN = 'test-metrics-token'

const testEnv = {
  APP_ENV: 'test',
  APP_URL: 'http://localhost:3000',
  ORCHESTRATOR_ROLES: 'core,mcp',
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
  const { core } = loadConfig(testEnv)
  if (!core) throw new Error('test env has no core role')
  return core
}

export function testMcpConfig(): McpConfig {
  const { mcp } = loadConfig(testEnv)
  if (!mcp) throw new Error('test env has no mcp role')
  return mcp
}

export function testRunnerConfig(overrides: Record<string, string> = {}): RunnerConfig {
  const { runner } = loadConfig({
    APP_ENV: 'test',
    ORCHESTRATOR_ROLES: 'runner',
    RUNNER_CORE_URL: 'http://127.0.0.1:8083',
    RUNNER_TOKEN_FILE: '/run/raditi/runner-token',
    ...overrides,
  })
  if (!runner) throw new Error('test env has no runner role')
  return runner
}

export interface Dependencies {
  database: boolean
  redis: boolean
  /** Buckets that do not answer. */
  missingBuckets: BucketKind[]
  vault: 'ok' | 'sealed' | 'down'
}

const healthy: Dependencies = { database: true, redis: true, missingBuckets: [], vault: 'ok' }

export function fakeInfra(overrides: Partial<Dependencies> = {}) {
  const deps = { ...healthy, ...overrides }
  const down = () => Promise.reject(new Error('connect ECONNREFUSED'))
  return {
    prisma: {
      $queryRaw: vi.fn(() => (deps.database ? Promise.resolve([{ ok: 1 }]) : down())),
      $disconnect: vi.fn(() => Promise.resolve()),
    },
    redis: {
      status: deps.redis ? 'ready' : 'reconnecting',
      ping: vi.fn(() => (deps.redis ? Promise.resolve('PONG') : down())),
      quit: vi.fn(() => Promise.resolve('OK')),
      disconnect: vi.fn(),
    },
    storage: {
      checkBuckets: vi.fn((kinds: readonly BucketKind[] = bucketKinds) =>
        Promise.resolve(
          Object.fromEntries(
            kinds.map((kind) => [kind, !deps.missingBuckets.includes(kind)]),
          ) as Partial<Record<BucketKind, boolean>>,
        ),
      ),
    },
    secrets: {
      health: vi.fn(() =>
        deps.vault === 'down'
          ? down()
          : Promise.resolve({
              initialized: true,
              sealed: deps.vault === 'sealed',
              standby: false,
              version: '2.6.0',
            }),
      ),
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
