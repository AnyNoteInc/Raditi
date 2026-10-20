// Test doubles for the mcp role: its configuration as a test env gives it, and the infra fakes
// every role app shares. Only for *.test.ts files (excluded from the build).
import { loadMcpConfig, type McpConfig } from '../config.ts'

export { fakeInfra, TEST_METRICS_TOKEN, type FakeInfra } from '@repo/service-runtime/testing/fakes'

const testEnv = {
  APP_ENV: 'test',
  DATABASE_URL: 'postgresql://raditi:raditi@localhost:5432/raditi_test',
  VAULT_ADDR: 'http://localhost:8200',
  VAULT_DEV_ROOT_TOKEN: 'raditi-dev-root',
}

export function testMcpConfig(): McpConfig {
  return loadMcpConfig(testEnv)
}
