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
  RUNNER_TOKENS: `sandbox-1:${RUNNER_HASH}@10.20.0.11`,
  ...overrides,
})

const testRunnerUrl = (url: string) =>
  loadConfig({
    APP_ENV: 'development',
    ORCHESTRATOR_ROLES: 'runner',
    RUNNER_CORE_URL: url,
    RUNNER_TOKEN_FILE: '/etc/raditi/runner-token',
  }).runner?.coreUrl

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

  it('builds the runner role from its own settings only: core, token file, Docker', () => {
    const config = loadConfig({
      APP_ENV: 'development',
      ORCHESTRATOR_ROLES: 'runner',
      RUNNER_CORE_URL: 'http://127.0.0.1:8083',
      RUNNER_TOKEN_FILE: '/etc/raditi/runner-token',
    })
    expect(config).toMatchObject({ roles: ['runner'], core: null, mcp: null })
    expect(config.runner).toEqual({
      appEnv: 'development',
      coreUrl: new URL('http://127.0.0.1:8083'),
      tokenFile: '/etc/raditi/runner-token',
      caFile: null,
      s3Origin: null,
      maxTurns: 1,
      sandbox: { runtime: 'runc', socketPath: '/var/run/docker.sock' },
    })
    expect(loadConfig(devEnv).runner).toBeNull()
  })

  it('refuses a runner without core, its token file or with more than one turn', () => {
    expect(problemsOf({ APP_ENV: 'development', ORCHESTRATOR_ROLES: 'runner' })).toEqual([
      'RUNNER_CORE_URL: required for the runner role',
      'RUNNER_TOKEN_FILE: required for the runner role (the token is never an env value)',
    ])
    expect(
      problemsOf({
        APP_ENV: 'development',
        ORCHESTRATOR_ROLES: 'runner',
        RUNNER_CORE_URL: 'http://runner:secret@127.0.0.1:8083/runner/v1',
        RUNNER_TOKEN_FILE: 'runner-token',
        RUNNER_CORE_CA_FILE: 'ca.pem',
      }),
    ).toEqual([
      'RUNNER_CORE_URL: expected an origin (no path, credentials or query)',
      'RUNNER_TOKEN_FILE: must be an absolute path',
      'RUNNER_CORE_CA_FILE: must be an absolute path',
    ])
    expect(
      problemsOf({
        APP_ENV: 'development',
        ORCHESTRATOR_ROLES: 'runner',
        RUNNER_CORE_URL: 'http://127.0.0.1:8083/?token=secret',
        RUNNER_TOKEN_FILE: '/etc/raditi/runner-token',
      }).join('\n'),
    ).not.toContain('secret')
    expect(
      problemsOf({
        APP_ENV: 'development',
        ORCHESTRATOR_ROLES: 'runner',
        RUNNER_MAX_TURNS: '2',
      })[0],
    ).toBe('RUNNER_MAX_TURNS: one turn per runner until several runners are supported (stage 2)')
  })

  it('drives Docker from core only with the local executor', () => {
    expect(loadConfig(devEnv).core?.sandbox).toEqual({
      runtime: 'runc',
      socketPath: '/var/run/docker.sock',
    })
    const runner = loadConfig({
      ...devEnv,
      TURN_EXECUTOR: 'runner',
      RUNNER_TOKENS: `sandbox-1:${RUNNER_HASH}`,
      SANDBOX_RUNTIME: 'kata',
    })
    expect(runner.core?.sandbox).toBeNull()
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
    expect(
      runner!.runnerApi!.tokens.get('sandbox-1')!.map((hash) => hash.digest.toString('hex')),
    ).toEqual([RUNNER_HASH, 'b'.repeat(64)])
  })

  it('refuses runner settings it cannot serve, naming entries and never their values', () => {
    const runner = { ...devEnv, TURN_EXECUTOR: 'runner' }
    expect(problemsOf(runner)).toEqual([
      'RUNNER_TOKENS: at least one runner token hash is required (id:sha256@ip)',
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
      'RUNNER_TOKENS: entry 1 must be <runner id>:<sha256 hex>[@<IP address>]',
      'RUNNER_TOKENS: entry 3 repeats a hash of runner sandbox-1',
      'RUNNER_TOKENS: runner sandbox-1 has more than 2 token hashes',
      'RUNNER_TOKENS: entry 6 must be <runner id>:<sha256 hex>[@<IP address>]',
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
      sandbox: null,
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
      'RUNNER_TOKENS: at least one runner token hash is required (id:sha256@ip)',
    ])
  })

  it('binds every runner token to its VM private address', () => {
    const tokens = loadConfig(
      prodEnv({
        RUNNER_TOKENS: `sandbox-1:${RUNNER_HASH}@10.20.0.11,sandbox-2:${'b'.repeat(64)}@[fd00::12]`,
      }),
    ).core!.runnerApi!.tokens
    expect(tokens.get('sandbox-1')).toEqual([
      { digest: Buffer.from(RUNNER_HASH, 'hex'), address: '10.20.0.11' },
    ])
    expect(tokens.get('sandbox-2')?.[0]?.address).toBe('fd00::12')
    const problems = problemsOf(
      prodEnv({
        RUNNER_TOKENS: [
          `sandbox-1:${RUNNER_HASH}`,
          `sandbox-2:${'b'.repeat(64)}@8.8.8.8`,
          `sandbox-3:${'c'.repeat(64)}@127.0.0.1`,
          `sandbox-4:${'d'.repeat(64)}@sandbox-4.internal`,
        ].join(','),
      }),
    )
    expect(problems).toEqual([
      'RUNNER_TOKENS: entry 1 needs @<private IP> in production (spec §15)',
      'RUNNER_TOKENS: entry 2 needs @<private IP> in production (spec §15)',
      'RUNNER_TOKENS: entry 3 needs @<private IP> in production (spec §15)',
      'RUNNER_TOKENS: entry 4 must be <runner id>:<sha256 hex>[@<IP address>]',
    ])
    expect(problems.join('\n')).not.toMatch(/8\.8\.8\.8|aaaa/)
  })

  it('signs presigned URLs for runners only over https', () => {
    expect(
      loadConfig(prodEnv({ S3_RUNNER_ENDPOINT: 'https://storage.yandexcloud.net' })).core?.storage
        .presignEndpoint,
    ).toBe('https://storage.yandexcloud.net')
    expect(problemsOf(prodEnv({ S3_RUNNER_ENDPOINT: 'http://10.20.0.5:8333' }))).toEqual([
      'S3_RUNNER_ENDPOINT: must use https in production (runners follow presigned URLs)',
    ])
    // Without a runner address, presigned URLs are signed for S3_ENDPOINT itself.
    expect(problemsOf(prodEnv({ S3_ENDPOINT: 'http://storage.yandexcloud.net' }))).toEqual([
      'S3_ENDPOINT: must use https in production (runners follow presigned URLs)',
    ])
    // Core may reach S3 over a private address when runners get their own https one.
    expect(
      loadConfig(
        prodEnv({
          S3_ENDPOINT: 'http://10.20.0.5:8333',
          S3_RUNNER_ENDPOINT: 'https://storage.yandexcloud.net',
        }),
      ).core?.storage.endpoint,
    ).toBe('http://10.20.0.5:8333')
    // Local S3 stays plain outside production.
    expect(loadConfig(devEnv).core?.storage.endpoint).toMatch(/^http:/)
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

  it('keeps the package rules: https Vault, AppRole and SendSay are mandatory', () => {
    const problems = problemsOf(
      prodEnv({
        VAULT_ADDR: 'http://vault.internal:8200',
        VAULT_ROLE_ID: '',
        VAULT_SECRET_ID: '',
        SENDSAY_API_KEY: '',
      }),
    ).join('\n')

    expect(problems).toMatch(/VAULT_ADDR: must use https in production/)
    expect(problems).toMatch(/VAULT_ROLE_ID/)
    expect(problems).toMatch(/SENDSAY_API_KEY/)
  })

  const runnerEnv = (overrides: Env = {}): Env => ({
    APP_ENV: 'production',
    ORCHESTRATOR_ROLES: 'runner',
    RUNNER_CORE_URL: 'https://core.internal:8083',
    RUNNER_TOKEN_FILE: '/etc/raditi/runner-token',
    RUNNER_CORE_CA_FILE: '/etc/raditi/core-ca.pem',
    RUNNER_S3_ORIGIN: 'https://raditi-sessions.storage.yandexcloud.net',
    SANDBOX_RUNTIME: 'runsc',
    ...overrides,
  })

  it('runs a runner over https under gVisor, with nothing of the platform', () => {
    expect(loadConfig(runnerEnv()).runner).toMatchObject({
      coreUrl: new URL('https://core.internal:8083'),
      caFile: '/etc/raditi/core-ca.pem',
      s3Origin: 'https://raditi-sessions.storage.yandexcloud.net',
      sandbox: { runtime: 'runsc' },
    })
    expect(problemsOf(runnerEnv({ SANDBOX_RUNTIME: 'runc' }))).toEqual([
      expect.stringMatching(/^\[sandbox\] invalid configuration: SANDBOX_RUNTIME: /),
    ])
  })

  it('reaches core over plain http only at a private IP address', () => {
    const plain = { RUNNER_CORE_CA_FILE: undefined }
    for (const url of ['http://10.10.0.10:8083', 'http://[fd00::10]:8083'])
      expect(loadConfig(runnerEnv({ ...plain, RUNNER_CORE_URL: url })).runner?.coreUrl).toEqual(
        new URL(url),
      )
    expect(
      loadConfig(runnerEnv({ ...plain, RUNNER_CORE_URL: 'https://core.raditi.ru:8083' })).runner
        ?.coreUrl,
    ).toEqual(new URL('https://core.raditi.ru:8083'))
    for (const url of [
      // A name: what it resolves to is never checked.
      'http://core.raditi.internal:8083',
      'http://core.raditi.ru:8083',
      'http://8.8.8.8:8083',
      'http://172.32.0.1:8083',
      'http://127.0.0.1:8083',
      'http://169.254.169.254:8083',
      'http://[fe80::1]:8083',
    ])
      expect(problemsOf(runnerEnv({ ...plain, RUNNER_CORE_URL: url }))).toEqual([
        'RUNNER_CORE_URL: plain http only to a private IP address in production (spec §19)',
      ])
    // Outside production a local core is fine.
    expect(testRunnerUrl('http://127.0.0.1:8083')).toEqual(new URL('http://127.0.0.1:8083'))
  })

  it('pins presigned URLs to one https S3 origin, even when core is reached over http', () => {
    const plainCore = { RUNNER_CORE_URL: 'http://10.10.0.10:8083', RUNNER_CORE_CA_FILE: undefined }
    expect(
      loadConfig(runnerEnv({ ...plainCore, RUNNER_S3_ORIGIN: 'https://s3.example.ru:443' })).runner
        ?.s3Origin,
    ).toBe('https://s3.example.ru')
    expect(problemsOf(runnerEnv({ RUNNER_S3_ORIGIN: undefined }))).toEqual([
      'RUNNER_S3_ORIGIN: required for the runner role in production',
    ])
    // The managed S3 is outside the private network: not even a private address goes plain.
    for (const origin of ['http://10.10.0.20:8333', 'http://storage.yandexcloud.net'])
      expect(problemsOf(runnerEnv({ ...plainCore, RUNNER_S3_ORIGIN: origin }))).toEqual([
        'RUNNER_S3_ORIGIN: must use https in production',
      ])
    // Path-style S3 shares its host between buckets: the pin names the sessions bucket.
    for (const pin of [
      'https://storage.yandexcloud.net/raditi-sessions',
      'https://storage.yandexcloud.net/raditi-sessions/',
    ])
      expect(loadConfig(runnerEnv({ RUNNER_S3_ORIGIN: pin })).runner?.s3Origin).toBe(
        'https://storage.yandexcloud.net/raditi-sessions',
      )
    for (const origin of [
      'https://storage.yandexcloud.net/raditi-sessions/sessions',
      'https://storage.yandexcloud.net/Raditi_Sessions',
      'https://key:secret@storage.yandexcloud.net',
      'https://storage.yandexcloud.net/?X-Amz-Signature=secret',
    ]) {
      const problems = problemsOf(runnerEnv({ RUNNER_S3_ORIGIN: origin }))
      expect(problems).toEqual([
        'RUNNER_S3_ORIGIN: expected an origin, with the sessions bucket for path-style S3 (no credentials or query)',
      ])
      expect(problems.join('\n')).not.toContain('secret')
    }
    expect(problemsOf(runnerEnv({ RUNNER_S3_ORIGIN: 'ftp://storage.yandexcloud.net' }))).toEqual([
      'RUNNER_S3_ORIGIN: must be an http(s):// URL',
    ])
    // Outside production the pin is optional and local S3 may be plain.
    const dev = {
      APP_ENV: 'development',
      ORCHESTRATOR_ROLES: 'runner',
      RUNNER_CORE_URL: 'http://127.0.0.1:8083',
      RUNNER_TOKEN_FILE: '/etc/raditi/runner-token',
    }
    expect(loadConfig(dev).runner?.s3Origin).toBeNull()
    expect(
      loadConfig({ ...dev, RUNNER_S3_ORIGIN: 'http://192.168.5.2:8333' }).runner?.s3Origin,
    ).toBe('http://192.168.5.2:8333')
  })

  it('refuses to start a runner given anything but its own settings, naming only the variables', () => {
    const problems = problemsOf(
      runnerEnv({
        DATABASE_URL: 'postgresql://core:secret@db.internal:5432/raditi',
        REDIS_URL: 'rediss://redis.internal:6380',
        VAULT_ADDR: 'https://vault.internal:8200',
        VAULT_SECRET_ID: 'core-secret',
        S3_SECRET_ACCESS_KEY: 'very-secret-s3-key',
        GITEA_TOKEN: 'gitea-secret',
        LITELLM_MASTER_KEY: 'sk-master-secret',
        YANDEX_API_KEY: 'yandex-secret',
        BETTER_AUTH_SECRET: 'auth-secret',
        METRICS_TOKEN: 'metrics-secret',
        NODE_OPTIONS: '--require /tmp/hook.js',
        S3_REGION: ' ',
      }),
    )
    expect(problems).toEqual([
      'BETTER_AUTH_SECRET: must not be set for the runner role in production',
      'DATABASE_URL: must not be set for the runner role in production',
      'GITEA_TOKEN: must not be set for the runner role in production',
      'LITELLM_MASTER_KEY: must not be set for the runner role in production',
      'METRICS_TOKEN: must not be set for the runner role in production',
      'NODE_OPTIONS: must not be set for the runner role in production',
      'REDIS_URL: must not be set for the runner role in production',
      'S3_SECRET_ACCESS_KEY: must not be set for the runner role in production',
      'VAULT_ADDR: must not be set for the runner role in production',
      'VAULT_SECRET_ID: must not be set for the runner role in production',
      'YANDEX_API_KEY: must not be set for the runner role in production',
    ])
    expect(problems.join('\n')).not.toMatch(/secret|hook/)
  })

  it('lets a production runner keep what the system, Docker and the Node image set', () => {
    expect(
      loadConfig(
        runnerEnv({
          NODE_ENV: 'production',
          PATH: '/usr/local/bin:/usr/bin:/bin',
          HOME: '/root',
          HOSTNAME: 'a1b2c3d4e5f6',
          TZ: 'UTC',
          LANG: 'C.UTF-8',
          LC_ALL: 'C.UTF-8',
          NODE_VERSION: '26.10.0',
          RUNNER_MAX_TURNS: '1',
          SANDBOX_DOCKER_SOCKET: '/var/run/docker.sock',
        }),
      ).runner,
    ).not.toBeNull()
    // Outside production a runner shares the developer's .env.
    expect(
      loadConfig({
        APP_ENV: 'development',
        ORCHESTRATOR_ROLES: 'runner',
        RUNNER_CORE_URL: 'http://127.0.0.1:8083',
        RUNNER_TOKEN_FILE: '/etc/raditi/runner-token',
        DATABASE_URL: 'postgresql://raditi:raditi@localhost:5432/raditi',
      }).runner,
    ).not.toBeNull()
  })
})
