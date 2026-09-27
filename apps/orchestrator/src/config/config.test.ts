import type { Env } from '@repo/domain'
import { DEV_METRICS_TOKEN } from '@repo/observability'
import { describe, expect, it } from 'vitest'

import { ConfigError, loadConfig } from './config.ts'

/** The local setup of .env.example. */
const devEnv: Env = {
  APP_ENV: 'development',
  ORCHESTRATOR_PORT: '8081',
  ORCHESTRATOR_ROLES: 'core,mcp',
  MCP_PORT: '8082',
  DATABASE_URL: 'postgresql://raditi:raditi@localhost:5432/raditi',
  REDIS_URL: 'redis://localhost:6379',
  S3_ENDPOINT: 'http://localhost:8333',
  S3_REGION: 'ru-central1',
  S3_ACCESS_KEY_ID: 'raditi',
  S3_SECRET_ACCESS_KEY: 'raditi-dev-secret',
  S3_FORCE_PATH_STYLE: 'true',
  VAULT_ADDR: 'http://localhost:8200',
  VAULT_DEV_ROOT_TOKEN: 'raditi-dev-root',
  VAULT_ROLE_ID: '',
  VAULT_SECRET_ID: '',
  SANDBOX_RUNTIME: 'runc',
  SANDBOX_IMAGE_PREFIX: 'raditi/agent',
  SENDSAY_API_KEY: '',
  METRICS_TOKEN: DEV_METRICS_TOKEN,
}

const PROD_METRICS_TOKEN = 'test-metrics-token-'.padEnd(32, 'x')
const RUNNER_HASH = 'a'.repeat(64)

const prodEnv = (overrides: Env = {}): Env => ({
  APP_ENV: 'production',
  ORCHESTRATOR_ROLES: 'core',
  DATABASE_URL: 'postgresql://core:secret@db.internal:5432/raditi',
  REDIS_URL: 'rediss://redis.internal:6380',
  S3_ENDPOINT: 'https://storage.yandexcloud.net',
  S3_ACCESS_KEY_ID: 'key-id',
  S3_SECRET_ACCESS_KEY: 'very-secret-s3-key',
  VAULT_ADDR: 'https://vault.internal:8200',
  VAULT_ROLE_ID: 'core-role',
  VAULT_SECRET_ID: 'core-secret',
  SANDBOX_RUNTIME: 'runsc',
  SANDBOX_IMAGE_PREFIX: 'gitea.internal:3300/raditi/agent',
  SENDSAY_API_KEY: 'sendsay-key',
  METRICS_TOKEN: PROD_METRICS_TOKEN,
  RUNNER_TOKENS: `sandbox-1:${RUNNER_HASH}`,
  ...overrides,
})

function problemsOf(env: Env): readonly string[] {
  try {
    loadConfig(env)
  } catch (err) {
    if (err instanceof ConfigError) return err.problems
    throw err
  }
  throw new Error('expected a ConfigError')
}

describe('loadConfig — development', () => {
  it('reads the .env.example setup: core and mcp in one process on two ports', () => {
    const config = loadConfig(devEnv)

    expect(config.appEnv).toBe('development')
    expect(config.roles).toEqual(['core', 'mcp'])
    expect(config.core).toMatchObject({
      port: 8081,
      redisUrl: 'redis://localhost:6379',
      metricsToken: DEV_METRICS_TOKEN,
      db: { databaseUrl: 'postgresql://raditi:raditi@localhost:5432/raditi' },
      vault: { addr: 'http://localhost:8200', token: 'raditi-dev-root' },
      sandbox: { runtime: 'runc' },
      agentDrivers: { imagePrefix: 'raditi/agent' },
      mailer: { sendsayApiKey: undefined },
    })
    expect(config.core?.storage.buckets.artifacts).toBe('raditi-artifacts')
    expect(config.mcp).toEqual({
      appEnv: 'development',
      port: 8082,
      db: { databaseUrl: 'postgresql://raditi:raditi@localhost:5432/raditi' },
      vault: { addr: 'http://localhost:8200', token: 'raditi-dev-root' },
    })
  })

  it('defaults to core,mcp, ports 8081/8082 and the dev metrics token', () => {
    const config = loadConfig({
      ...devEnv,
      ORCHESTRATOR_ROLES: undefined,
      ORCHESTRATOR_PORT: '',
      MCP_PORT: undefined,
      METRICS_TOKEN: '',
    })

    expect(config.roles).toEqual(['core', 'mcp'])
    expect(config.core?.port).toBe(8081)
    expect(config.mcp?.port).toBe(8082)
    expect(config.core?.metricsToken).toBe(DEV_METRICS_TOKEN)
  })

  it('requires APP_ENV: a missing or misspelt one never falls back to development', () => {
    const refused = 'APP_ENV: must be one of development, test, production'
    expect(problemsOf({ ...devEnv, APP_ENV: undefined })).toEqual([refused])
    expect(problemsOf({ ...devEnv, APP_ENV: ' ' })).toEqual([refused])
    expect(problemsOf({ ...devEnv, APP_ENV: 'prod' })).toEqual([refused])
    expect(problemsOf({ APP_ENV: undefined, ORCHESTRATOR_ROLES: 'runner' })).toEqual([refused])
  })

  it('parses a role list with spaces and repeats', () => {
    expect(loadConfig({ ...devEnv, ORCHESTRATOR_ROLES: ' mcp , mcp ' }).roles).toEqual(['mcp'])
  })

  it('builds only the selected role', () => {
    const mcpOnly = loadConfig({ ...devEnv, ORCHESTRATOR_ROLES: 'mcp', REDIS_URL: undefined })
    expect(mcpOnly.core).toBeNull()
    expect(mcpOnly.mcp?.port).toBe(8082)

    // S3, sandbox and Redis are not needed by the MCP gateway yet.
    expect(() =>
      loadConfig({
        APP_ENV: 'development',
        ORCHESTRATOR_ROLES: 'mcp',
        DATABASE_URL: devEnv.DATABASE_URL,
        VAULT_ADDR: devEnv.VAULT_ADDR,
      }),
    ).not.toThrow()
  })

  it('accepts the runner role (refused later, at startup)', () => {
    expect(loadConfig({ APP_ENV: 'development', ORCHESTRATOR_ROLES: 'runner' })).toEqual({
      appEnv: 'development',
      roles: ['runner'],
      core: null,
      mcp: null,
    })
  })

  it('runs turns in core by default and on runners with their token hashes', () => {
    expect(loadConfig(devEnv).core).toMatchObject({ turnExecutor: 'local', runnerApi: null })
    const runner = loadConfig({
      ...devEnv,
      TURN_EXECUTOR: 'runner',
      RUNNER_TOKENS: ` sandbox-1:${RUNNER_HASH}, sandbox-1:${'B'.repeat(64)},sandbox-2:${'c'.repeat(64)} `,
    }).core
    expect(runner?.turnExecutor).toBe('runner')
    expect(runner?.runnerApi?.port).toBe(8083)
    expect([...runner!.runnerApi!.tokens.keys()]).toEqual(['sandbox-1', 'sandbox-2'])
    expect(runner!.runnerApi!.tokens.get('sandbox-1')!.map((hash) => hash.toString('hex'))).toEqual(
      [RUNNER_HASH, 'b'.repeat(64)],
    )
  })

  it('refuses runner settings it cannot serve, naming entries and never their values', () => {
    const runner = { ...devEnv, TURN_EXECUTOR: 'runner' }
    expect(problemsOf(runner)).toEqual([
      'RUNNER_TOKENS: at least one runner token hash is required (id:sha256)',
    ])
    const leaked = 'rnr_sandbox-1.' + 'x'.repeat(43)
    const problems = problemsOf({
      ...runner,
      RUNNER_API_PORT: '8082',
      RUNNER_TOKENS: [
        leaked,
        `sandbox-1:${RUNNER_HASH}`,
        `sandbox-1:${RUNNER_HASH}`,
        `sandbox-1:${'b'.repeat(64)}`,
        `sandbox-1:${'c'.repeat(64)}`,
        `Sandbox:${RUNNER_HASH}`,
      ].join(','),
    })
    expect(problems).toEqual([
      'RUNNER_API_PORT: must differ from ORCHESTRATOR_PORT and MCP_PORT',
      'RUNNER_TOKENS: entry 1 must be <runner id>:<sha256 hex>',
      'RUNNER_TOKENS: entry 3 repeats a hash of runner sandbox-1',
      'RUNNER_TOKENS: runner sandbox-1 has more than 2 token hashes',
      'RUNNER_TOKENS: entry 6 must be <runner id>:<sha256 hex>',
    ])
    expect(problems.join('\n')).not.toContain(leaked)
    expect(problemsOf({ ...runner, TURN_EXECUTOR: 'docker' })[0]).toMatch(/^TURN_EXECUTOR/)
  })

  it('rejects unknown roles and an empty list', () => {
    expect(problemsOf({ ...devEnv, ORCHESTRATOR_ROLES: 'core,worker' })).toEqual([
      'ORCHESTRATOR_ROLES: unknown role "worker"; expected core, mcp, runner',
    ])
    expect(problemsOf({ ...devEnv, ORCHESTRATOR_ROLES: ' , ' })).toEqual([
      'ORCHESTRATOR_ROLES: at least one role is required',
    ])
  })

  it('rejects bad ports and the same port for core and mcp', () => {
    expect(problemsOf({ ...devEnv, ORCHESTRATOR_PORT: 'http' })[0]).toMatch(/^ORCHESTRATOR_PORT/)
    expect(problemsOf({ ...devEnv, MCP_PORT: '70000' })[0]).toMatch(/^MCP_PORT/)
    expect(problemsOf({ ...devEnv, MCP_PORT: '8081' })).toEqual([
      'MCP_PORT: must differ from ORCHESTRATOR_PORT (sandboxes reach only the MCP port)',
    ])
  })

  it('requires a redis:// REDIS_URL for the core role', () => {
    expect(problemsOf({ ...devEnv, REDIS_URL: '' })).toEqual([
      'REDIS_URL: required for the core role',
    ])
    expect(problemsOf({ ...devEnv, REDIS_URL: 'http://localhost:6379' })).toEqual([
      'REDIS_URL: must be a redis:// URL',
    ])
  })

  it('lists every broken section at once without leaking values', () => {
    const problems = problemsOf({
      ...devEnv,
      DATABASE_URL: 'mysql://root:hunter2@localhost/raditi',
      S3_ENDPOINT: '',
      SANDBOX_IMAGE_PREFIX: 'Raditi/Agent:latest',
    })

    expect(problems).toHaveLength(3)
    expect(problems[0]).toBe(
      '[db] invalid configuration: DATABASE_URL: must be a postgresql:// connection string',
    )
    expect(problems[1]).toMatch(/^\[storage\] invalid configuration: S3_ENDPOINT: /)
    expect(problems[2]).toMatch(/^\[agent drivers\] invalid configuration: SANDBOX_IMAGE_PREFIX: /)
    expect(problems.join('\n')).not.toMatch(/hunter2|raditi-dev-secret/)
  })
})

describe('loadConfig — production', () => {
  it('starts one role with production settings', () => {
    const config = loadConfig(prodEnv())

    expect(config.roles).toEqual(['core'])
    expect(config.mcp).toBeNull()
    expect(config.core).toMatchObject({
      appEnv: 'production',
      metricsToken: PROD_METRICS_TOKEN,
      vault: { appRole: { roleId: 'core-role', secretId: 'core-secret' } },
      sandbox: { runtime: 'runsc' },
    })
  })

  it('runs turns only on runner VMs', () => {
    expect(loadConfig(prodEnv()).core).toMatchObject({
      turnExecutor: 'runner',
      runnerApi: { port: 8083 },
    })
    expect(problemsOf(prodEnv({ TURN_EXECUTOR: 'local' }))).toEqual([
      'TURN_EXECUTOR: production runs turns only on runner VMs (runner)',
    ])
    expect(problemsOf(prodEnv({ RUNNER_TOKENS: '' }))).toEqual([
      'RUNNER_TOKENS: at least one runner token hash is required (id:sha256)',
    ])
  })

  it('refuses more than one role per process', () => {
    expect(problemsOf(prodEnv({ ORCHESTRATOR_ROLES: 'core,mcp' }))).toContain(
      'ORCHESTRATOR_ROLES: production runs exactly one role per process',
    )
  })

  it('requires the role to be set explicitly', () => {
    expect(problemsOf(prodEnv({ ORCHESTRATOR_ROLES: '' }))).toEqual([
      'ORCHESTRATOR_ROLES: required in production (one role)',
    ])
  })

  it('refuses an empty METRICS_TOKEN and the dev placeholder', () => {
    const refused =
      'METRICS_TOKEN: set a unique token in production (the dev placeholder is refused)'
    expect(problemsOf(prodEnv({ METRICS_TOKEN: '' }))).toEqual([refused])
    expect(problemsOf(prodEnv({ METRICS_TOKEN: undefined }))).toEqual([refused])
    expect(problemsOf(prodEnv({ METRICS_TOKEN: DEV_METRICS_TOKEN }))).toEqual([refused])
  })

  it('requires a metrics token of at least 32 characters, without leaking it', () => {
    const short = 'k'.repeat(31)
    expect(PROD_METRICS_TOKEN).toHaveLength(32)

    const problems = problemsOf(prodEnv({ METRICS_TOKEN: short }))
    expect(problems).toEqual(['METRICS_TOKEN: must be at least 32 characters in production'])
    expect(problems.join('\n')).not.toContain(short)
    // Short tokens stay fine outside production.
    expect(loadConfig({ ...devEnv, METRICS_TOKEN: 'short' }).core?.metricsToken).toBe('short')
  })

  it('does not ask the MCP gateway for a metrics token: it serves no /metrics', () => {
    const config = loadConfig(prodEnv({ ORCHESTRATOR_ROLES: 'mcp', METRICS_TOKEN: '' }))
    expect(config.mcp?.port).toBe(8082)
  })

  it('keeps the package rules: https Vault, AppRole, gVisor and SendSay are mandatory', () => {
    const problems = problemsOf(
      prodEnv({
        VAULT_ADDR: 'http://vault.internal:8200',
        VAULT_ROLE_ID: '',
        VAULT_SECRET_ID: '',
        SANDBOX_RUNTIME: 'runc',
        SENDSAY_API_KEY: '',
      }),
    ).join('\n')

    expect(problems).toMatch(/VAULT_ADDR: must use https in production/)
    expect(problems).toMatch(/VAULT_ROLE_ID/)
    expect(problems).toMatch(/SANDBOX_RUNTIME/)
    expect(problems).toMatch(/SENDSAY_API_KEY/)
  })
})
