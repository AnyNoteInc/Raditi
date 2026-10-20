// Test doubles for the infra providers: the Nest apps compile without PostgreSQL, Redis, S3 or
// Vault. Only for *.test.ts files (excluded from the builds).
import { bucketKinds, type BucketKind } from '@repo/domain'
import { vi } from 'vitest'

export const TEST_METRICS_TOKEN = 'test-metrics-token'

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
