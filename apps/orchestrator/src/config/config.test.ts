import { describe, expect, it } from 'vitest'

import { ConfigError, DEV_METRICS_TOKEN, loadConfig, type Env } from './config.ts'

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
  METRICS_TOKEN: 'a-long-random-metrics-token',
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
      sandbox: { runtime: 'runc', imagePrefix: 'raditi/agent' },
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
    const refused = 'APP_ENV: APP_ENV must be one of development, test, production'
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
    expect(problemsOf({ ...devEnv, REDIS_URL: 'http://localhost:6379' })[0]).toMatch(/^REDIS_URL/)
  })

  it('lists every broken section at once without leaking values', () => {
    const problems = problemsOf({
      ...devEnv,
      DATABASE_URL: 'mysql://root:hunter2@localhost/raditi',
      S3_ENDPOINT: '',
      SANDBOX_IMAGE_PREFIX: 'Raditi/Agent:latest',
    })

    expect(problems).toHaveLength(3)
    expect(problems.join('\n')).toMatch(/DATABASE_URL/)
    expect(problems.join('\n')).toMatch(/S3_ENDPOINT/)
    expect(problems.join('\n')).toMatch(/SANDBOX_IMAGE_PREFIX/)
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
      metricsToken: 'a-long-random-metrics-token',
      vault: { appRole: { roleId: 'core-role', secretId: 'core-secret' } },
      sandbox: { runtime: 'runsc' },
    })
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
