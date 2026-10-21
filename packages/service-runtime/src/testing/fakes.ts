// Test doubles for the infra providers the role apps with a database share: the Nest apps
// compile without PostgreSQL, S3 or Vault. Only for *.test.ts files (excluded from the builds).
// Redis and the queues are core's alone, and so are their fakes (apps/core/src/testing/fakes.ts).
import { bucketKinds, type BucketKind } from '@repo/domain'
import { vi } from 'vitest'

export const TEST_METRICS_TOKEN = 'test-metrics-token'

export interface Dependencies {
  database: boolean
  /** Buckets that do not answer. */
  missingBuckets: BucketKind[]
  vault: 'ok' | 'sealed' | 'down'
}

const healthy: Dependencies = { database: true, missingBuckets: [], vault: 'ok' }

export function fakeInfra(overrides: Partial<Dependencies> = {}) {
  const deps = { ...healthy, ...overrides }
  const down = () => Promise.reject(new Error('connect ECONNREFUSED'))
  return {
    prisma: {
      $queryRaw: vi.fn(() => (deps.database ? Promise.resolve([{ ok: 1 }]) : down())),
      $disconnect: vi.fn(() => Promise.resolve()),
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
  }
}

export type FakeInfra = ReturnType<typeof fakeInfra>
