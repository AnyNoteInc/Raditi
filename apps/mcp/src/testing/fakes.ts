// Test doubles for the mcp role: its configuration as a test env gives it, and the infra fakes
// every role app shares. Only for *.test.ts files (excluded from the build).
import { loadMcpConfig, type McpConfig } from '../config/config.ts'

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

/**
 * A tool of another family than the documents (docs/plan/69-pages.md, Ст21): `doc_*` is offered to
 * every turn, so a test of another family's list leaves them out; the documents test their own.
 */
export const notDocTool = (name: string): boolean => !name.startsWith('doc_')
