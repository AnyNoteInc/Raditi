import { readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'

import type { Env } from '@repo/domain'
import { DEV_METRICS_TOKEN } from '@repo/observability'
import { describe, expect, it } from 'vitest'

import { ConfigError, loadLlmConfig } from './config.ts'

/** .env.example exactly as `cp .env.example .env` gives it to a new developer. */
const exampleEnv: Env = parseEnv(
  readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8'),
)

const PROD_METRICS_TOKEN = 'test-metrics-token-'.padEnd(32, 'x')

/** The subscription gateway as infra/app runs it: no core beside it to check the token. */
const llmEnv = (overrides: Env = {}): Env => ({
  APP_ENV: 'production',
  DATABASE_URL: 'postgresql://raditi:secret@db.internal:5432/raditi',
  VAULT_ADDR: 'https://vault.internal:8200',
  VAULT_ROLE_ID: 'llm-role',
  VAULT_SECRET_ID: 'llm-secret',
  LLM_GATEWAY_CLIENTS: '10.20.0.0/24',
  LLM_GATEWAY_HOSTS: '10.20.0.4:8084',
  LLM_EGRESS_PROXY_URL: 'https://192.0.2.1',
  LLM_EGRESS_CA_FILE: '/run/raditi/llm/ca.pem',
  LLM_EGRESS_CLIENT_CERT_FILE: '/run/raditi/llm/client.pem',
  LLM_EGRESS_CLIENT_KEY_FILE: '/run/raditi/llm/key.pem',
  METRICS_TOKEN: PROD_METRICS_TOKEN,
  ...overrides,
})

function problemsOf(env: Env): readonly string[] {
  try {
    loadLlmConfig(env)
  } catch (err) {
    if (err instanceof ConfigError) return err.problems
    throw err
  }
  throw new Error('expected a ConfigError')
}

describe('loadLlmConfig — development', () => {
  it('loads with database and Vault, without any other settings', () => {
    const config = loadLlmConfig({
      APP_ENV: 'test',
      DATABASE_URL: 'postgresql://raditi:raditi@localhost:5432/raditi',
      VAULT_ADDR: 'http://localhost:8200',
    })
    expect(config).toMatchObject({
      port: 8084,
      // No egress node in dev: the role connects itself, where an adapter allows it.
      egress: { proxyUrl: null },
      maxRequestsPerKey: 2,
      metricsToken: DEV_METRICS_TOKEN,
    })
  })

  it('reads the .env.example setup: the dev address, the dev token and Docker Desktop names', () => {
    const config = loadLlmConfig(exampleEnv)
    expect(config).toMatchObject({
      appEnv: 'development',
      port: 8084,
      egress: { proxyUrl: null },
      listenHost: '127.0.0.1',
      metricsToken: DEV_METRICS_TOKEN,
    })
    // sandbox-gw sends its upstream's Host: SANDBOX_LLM_UPSTREAM=http://host.docker.internal:8084.
    expect(config.hosts).toContain('host.docker.internal:8084')
  })

  it('neither requires nor reads the settings of the other roles', () => {
    const broken = {
      YOOKASSA_SHOP_ID: 'not digits',
      YOOKASSA_API_URL: 'not a url',
      YOOKASSA_WEBHOOK_ALLOWLIST: 'not an address',
      APP_URL: 'not a url',
      BILLING_TICK_SECONDS: 'unused',
      REDIS_URL: 'not a url',
      CORE_PORT: 'unused',
      MCP_PORT: 'unused',
    }
    expect(loadLlmConfig({ ...exampleEnv, ...broken })).toMatchObject({ port: 8084 })
  })
})

describe('loadLlmConfig — production', () => {
  it('starts with production settings', () => {
    const config = loadLlmConfig(llmEnv())
    expect(config).toMatchObject({
      appEnv: 'production',
      listenHost: '0.0.0.0',
      metricsToken: PROD_METRICS_TOKEN,
      db: { databaseUrl: 'postgresql://raditi:secret@db.internal:5432/raditi' },
      vault: { addr: 'https://vault.internal:8200', appRole: { roleId: 'llm-role' } },
    })
    expect(config.vault.token).toBeUndefined()
  })

  it('needs no shop settings and no address of the app, and reads none', () => {
    const fake = {
      YOOKASSA_SHOP_ID: '123456',
      YOOKASSA_SECRET_KEY: 'live_shop-secret-key',
      YOOKASSA_API_URL: 'http://fake.example',
      APP_URL: '',
    }
    expect(loadLlmConfig(llmEnv(fake))).toMatchObject({ appEnv: 'production' })
  })

  it('refuses an empty, dev or short METRICS_TOKEN, without leaking it', () => {
    // The token opens /metrics and the pool probe endpoint core calls (POST /internal/…).
    const refused =
      'METRICS_TOKEN: set a unique token in production (the dev placeholder is refused)'
    expect(problemsOf(llmEnv({ METRICS_TOKEN: '' }))).toEqual([refused])
    expect(problemsOf(llmEnv({ METRICS_TOKEN: undefined }))).toEqual([refused])
    expect(problemsOf(llmEnv({ METRICS_TOKEN: DEV_METRICS_TOKEN }))).toEqual([refused])
    const short = 'k'.repeat(31)
    const problems = problemsOf(llmEnv({ METRICS_TOKEN: short }))
    expect(problems).toEqual(['METRICS_TOKEN: must be at least 32 characters in production'])
    expect(problems.join('\n')).not.toContain(short)
  })

  it('refuses a METRICS_TOKEN with whitespace in any environment: no Bearer header carries it', () => {
    const refused = 'METRICS_TOKEN: must not contain whitespace (it is sent as a Bearer token)'
    for (const env of [
      llmEnv({ METRICS_TOKEN: ` ${PROD_METRICS_TOKEN}` }),
      { ...exampleEnv, METRICS_TOKEN: 'dev-token\t' },
    ]) {
      const problems = problemsOf(env)
      expect(problems).toEqual([refused])
      expect(problems.join('\n')).not.toMatch(/dev-token|xxxx/)
    }
  })

  it('keeps the Vault rules: https, AppRole, never the dev root token', () => {
    const problems = problemsOf(
      llmEnv({
        VAULT_ADDR: 'http://vault.internal:8200',
        VAULT_ROLE_ID: '',
        VAULT_SECRET_ID: '',
        VAULT_DEV_ROOT_TOKEN: 'raditi-dev-root',
      }),
    ).join('\n')
    expect(problems).toMatch(/VAULT_ADDR: must use https in production/)
    expect(problems).toMatch(/VAULT_DEV_ROOT_TOKEN: the dev root token is not allowed/)
    expect(problems).toMatch(/VAULT_ROLE_ID: services log in by AppRole in production/)
    expect(problems).not.toContain('raditi-dev-root')
  })

  it('requires APP_ENV: a missing or misspelt one never falls back to development', () => {
    const refused = 'APP_ENV: must be one of development, test, production'
    expect(problemsOf(llmEnv({ APP_ENV: undefined }))).toEqual([refused])
    expect(problemsOf(llmEnv({ APP_ENV: 'prod' }))).toEqual([refused])
  })

  it('names its own subject in the error', () => {
    expect(() => loadLlmConfig(llmEnv({ METRICS_TOKEN: '' }))).toThrow(
      /^Invalid llm configuration:/,
    )
  })
})
