// Test doubles for the infra providers: the Nest apps compile without PostgreSQL, Redis,
// S3 or Vault. Only for *.test.ts files (excluded from the build).
import { getQueueToken } from '@nestjs/bullmq'
import type { TestingModuleBuilder } from '@nestjs/testing'
import { queueNames } from '@repo/domain'
import { OBJECT_STORAGE, PRISMA, SECRET_STORE } from '@repo/service-runtime'

import { loadConfig, type CoreConfig } from '../config/config.ts'
import { REDIS } from '../infra/tokens.ts'
import {
  fakeInfra,
  TEST_METRICS_TOKEN,
  type Dependencies,
  type FakeInfra,
} from '@repo/service-runtime/testing/fakes'

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

export { fakeInfra, TEST_METRICS_TOKEN, type Dependencies, type FakeInfra }
