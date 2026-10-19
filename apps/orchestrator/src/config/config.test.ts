import { readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'

import type { Env } from '@repo/domain'
import { DEV_METRICS_TOKEN } from '@repo/observability'
import { describe, expect, it } from 'vitest'

import { mcpHeadersAllowed } from '../mcp/mcp-policy.ts'
import { ConfigError, DEV_PREVIEW_SESSION_SECRET, loadConfig } from './config.ts'
import { runnerCredentialAddress } from './runner-tokens.ts'

/** .env.example exactly as `cp .env.example .env` gives it to a new developer. */
const exampleEnv: Env = parseEnv(
  readFileSync(new URL('../../../../.env.example', import.meta.url), 'utf8'),
)

/** The local setup of .env.example. */
const devEnv: Env = {
  APP_ENV: 'development',
  APP_URL: 'http://localhost:3000',
  ORCHESTRATOR_PORT: '8081',
  ORCHESTRATOR_ROLES: 'core,mcp,llm',
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
  SANDBOX_IMAGE: `raditi/sbx-wordpress@sha256:${'a'.repeat(64)}`,
  SENDSAY_API_KEY: '',
  METRICS_TOKEN: DEV_METRICS_TOKEN,
}

const PROD_METRICS_TOKEN = 'test-metrics-token-'.padEnd(32, 'x')
const RUNNER_HASH = 'a'.repeat(64)

const prodEnv = (overrides: Env = {}): Env => ({
  APP_ENV: 'production',
  APP_URL: 'https://raditi.ru',
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
  SANDBOX_IMAGE: `gitea.internal:3300/raditi/sbx-wordpress@sha256:${'a'.repeat(64)}`,
  SENDSAY_API_KEY: 'sendsay-key',
  METRICS_TOKEN: PROD_METRICS_TOKEN,
  RUNNER_TOKENS: `sandbox-1:${RUNNER_HASH}@10.20.0.11`,
  ...overrides,
})

/** The subscription gateway alone, as infra/app runs it: no core beside it to check the token. */
const llmEnv = (overrides: Env = {}): Env => ({
  APP_ENV: 'production',
  ORCHESTRATOR_ROLES: 'llm',
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
  it('defaults the private pool control endpoint and conservative turn quota', () => {
    expect(loadConfig(devEnv).core).toMatchObject({
      llmControlUrl: 'http://127.0.0.1:8084',
      minTurnHeadroomPct: 5,
    })
    expect(
      loadConfig({
        ...devEnv,
        LLM_CONTROL_URL: 'http://localhost:9876',
        LLM_POOL_MIN_TURN_HEADROOM_PCT: '7.5',
      }).core,
    ).toMatchObject({ llmControlUrl: 'http://127.0.0.1:9876', minTurnHeadroomPct: 7.5 })
    expect(
      loadConfig({
        ...devEnv,
        ORCHESTRATOR_ROLES: 'mcp',
        LLM_CONTROL_URL: 'unused',
        LLM_POOL_MIN_TURN_HEADROOM_PCT: 'unused',
      }).mcp,
    ).not.toBeNull()
  })

  it('loads llm alone with database and Vault, without core dependencies', () => {
    const config = loadConfig({
      APP_ENV: 'test',
      ORCHESTRATOR_ROLES: 'llm',
      DATABASE_URL: devEnv.DATABASE_URL,
      VAULT_ADDR: devEnv.VAULT_ADDR,
    })
    expect(config).toMatchObject({
      roles: ['llm'],
      core: null,
      mcp: null,
      runner: null,
      llm: {
        port: 8084,
        // No egress node in dev: the role connects itself, where an adapter allows it.
        egress: { proxyUrl: null },
        maxRequestsPerKey: 2,
        metricsToken: DEV_METRICS_TOKEN,
      },
    })
    expect(
      loadConfig({ ...devEnv, ORCHESTRATOR_ROLES: 'mcp', LLM_GATEWAY_PORT: 'unused' }).llm,
    ).toBeNull()
  })

  it('refuses llm port collisions before opening a listener', () => {
    for (const value of ['8081', '8082'])
      expect(problemsOf({ ...devEnv, LLM_GATEWAY_PORT: value })).toContain(
        'LLM_GATEWAY_PORT: must differ from the other role ports',
      )
  })
  it('reads the .env.example setup: three HTTP roles on separate ports', () => {
    const config = loadConfig(devEnv)

    expect(config.appEnv).toBe('development')
    expect(config.roles).toEqual(['core', 'mcp', 'llm'])
    expect(config.core).toMatchObject({
      port: 8081,
      redisUrl: 'redis://localhost:6379',
      metricsToken: DEV_METRICS_TOKEN,
      db: { databaseUrl: 'postgresql://raditi:raditi@localhost:5432/raditi' },
      vault: { addr: 'http://localhost:8200', token: 'raditi-dev-root' },
      sandbox: { runtime: 'runc' },
      agentDrivers: { image: `raditi/sbx-wordpress@sha256:${'a'.repeat(64)}` },
      mailer: { sendsayApiKey: undefined },
    })
    expect(config.core?.storage.buckets.artifacts).toBe('raditi-artifacts')
    expect(config.mcp).toEqual({
      appEnv: 'development',
      port: 8082,
      allowedHosts: ['localhost', '127.0.0.1', '[::1]', 'host.docker.internal'],
      db: { databaseUrl: 'postgresql://raditi:raditi@localhost:5432/raditi' },
      vault: { addr: 'http://localhost:8200', token: 'raditi-dev-root' },
      // Published-content tools stay off until MCP_CONTENT_PROFILE turns them on.
      contentProfile: 'off',
      // So does the agent's browser on a preview (MCP_BROWSER_PROFILE, plan 53, Р21).
      browserProfile: 'off',
      storage: null,
      previewUpstreamHost: '127.0.0.1',
      // The role is read here alone: no PREVIEW_BASE_DOMAIN, no previews.
      preview: null,
    })
    expect(loadConfig(exampleEnv).mcp).toMatchObject({ contentProfile: 'off', storage: null })
  })

  describe('the content profile of the mcp role', () => {
    const mcpEnv = (overrides: Env = {}): Env => ({
      APP_ENV: 'development',
      ORCHESTRATOR_ROLES: 'mcp',
      DATABASE_URL: devEnv.DATABASE_URL,
      VAULT_ADDR: devEnv.VAULT_ADDR,
      ...overrides,
    })
    const s3 = {
      S3_ENDPOINT: 'http://localhost:8333',
      S3_ACCESS_KEY_ID: 'raditi',
      S3_SECRET_ACCESS_KEY: 'raditi-dev-secret',
      S3_FORCE_PATH_STYLE: 'true',
    }

    it('is off by default and then needs no S3', () => {
      for (const value of [undefined, '', 'off'])
        expect(loadConfig(mcpEnv({ MCP_CONTENT_PROFILE: value })).mcp).toMatchObject({
          contentProfile: 'off',
          storage: null,
        })
      // Off, the S3 settings of the shared .env are not even read.
      expect(
        loadConfig(mcpEnv({ MCP_CONTENT_PROFILE: 'off', S3_ENDPOINT: 'not a url' })).mcp?.storage,
      ).toBeNull()
    })

    it('reads the S3 connection and the artifacts bucket alone for the local profile', () => {
      const config = loadConfig(
        mcpEnv({
          ...s3,
          MCP_CONTENT_PROFILE: 'local',
          PREVIEW_BASE_DOMAIN: 'localhost',
          S3_BUCKET_ARTIFACTS: 'raditi-test-artifacts',
          // Buckets and addresses of the other roles: the mcp role neither reads nor checks them.
          S3_BUCKET_SESSIONS: 'NOT A BUCKET',
          S3_BUCKET_BACKUPS: 'NOT A BUCKET',
          S3_RUNNER_ENDPOINT: 'not a url',
        }),
      )
      expect(config.mcp).toMatchObject({ contentProfile: 'local' })
      expect(config.mcp?.storage).toEqual({
        endpoint: 'http://localhost:8333',
        region: 'ru-central1',
        accessKeyId: 'raditi',
        secretAccessKey: 'raditi-dev-secret',
        forcePathStyle: true,
        buckets: { artifacts: 'raditi-test-artifacts' },
      })
      expect(
        loadConfig(mcpEnv({ ...s3, MCP_CONTENT_PROFILE: 'local-site' })).mcp?.storage?.buckets,
      ).toEqual({ artifacts: 'raditi-artifacts' })
    })

    it('says where the content goes: into previews, or the site on the stands without them', () => {
      const previews = { PREVIEW_BASE_DOMAIN: 'localhost', PREVIEW_PUBLIC_PORT: '8090' }
      expect(
        loadConfig(mcpEnv({ ...s3, ...previews, MCP_CONTENT_PROFILE: 'local' })).mcp,
      ).toMatchObject({ contentProfile: 'local', preview: { baseDomain: 'localhost' } })
      expect(loadConfig(mcpEnv({ ...s3, MCP_CONTENT_PROFILE: 'local-site' })).mcp).toMatchObject({
        contentProfile: 'local-site',
        preview: null,
      })
      // Without previews `local` has nowhere to write; beside them the site path is refused —
      // nothing turns the agent back onto the site by an empty variable (Р3).
      expect(problemsOf(mcpEnv({ ...s3, MCP_CONTENT_PROFILE: 'local' }))).toEqual([
        'MCP_CONTENT_PROFILE: local writes into previews and needs PREVIEW_BASE_DOMAIN',
      ])
      expect(problemsOf(mcpEnv({ ...s3, ...previews, MCP_CONTENT_PROFILE: 'local-site' }))).toEqual(
        [
          'MCP_CONTENT_PROFILE: local-site writes the connected site itself and is refused where previews are configured (PREVIEW_BASE_DOMAIN)',
        ],
      )
    })

    it('requires the S3 settings with the local profile and never prints their values', () => {
      const problems = problemsOf(
        mcpEnv({ MCP_CONTENT_PROFILE: 'local-site', S3_SECRET_ACCESS_KEY: 'very-secret-s3-key' }),
      )
      expect(problems).toHaveLength(1)
      expect(problems[0]).toMatch(/S3_ENDPOINT/)
      expect(problems[0]).toMatch(/S3_ACCESS_KEY_ID/)
      expect(problems.join('\n')).not.toContain('very-secret-s3-key')
      expect(
        problemsOf(
          mcpEnv({ ...s3, MCP_CONTENT_PROFILE: 'local-site', S3_BUCKET_ARTIFACTS: 'BAD' }),
        )[0],
      ).toMatch(/S3_BUCKET_ARTIFACTS/)
    })

    it('knows no other profile', () => {
      for (const value of ['on', 'true', 'production', 'LOCAL', 'local,off'])
        expect(problemsOf(mcpEnv({ ...s3, MCP_CONTENT_PROFILE: value }))).toEqual([
          'MCP_CONTENT_PROFILE: must be one of off, local, local-site',
        ])
    })

    it('is read only for the mcp role', () => {
      const config = loadConfig({
        ...devEnv,
        ORCHESTRATOR_ROLES: 'core',
        MCP_CONTENT_PROFILE: 'unused',
      })
      expect(config.mcp).toBeNull()
    })

    it('has a browser profile of its own that needs the same S3 settings (plan 53, Р21)', () => {
      expect(loadConfig(mcpEnv()).mcp).toMatchObject({ browserProfile: 'off', storage: null })
      const config = loadConfig(
        mcpEnv({
          ...s3,
          MCP_BROWSER_PROFILE: 'local',
          PREVIEW_BASE_DOMAIN: 'localhost',
          PREVIEW_PUBLIC_PORT: '8090',
        }),
      )
      expect(config.mcp).toMatchObject({
        contentProfile: 'off',
        browserProfile: 'local',
        storage: { buckets: { artifacts: 'raditi-artifacts' } },
        preview: { baseDomain: 'localhost', scheme: 'http', publicPort: 8090 },
      })
      expect(problemsOf(mcpEnv({ MCP_BROWSER_PROFILE: 'local' }))[0]).toMatch(/S3_ENDPOINT/)
      for (const value of ['on', 'LOCAL', 'playwright'])
        expect(problemsOf(mcpEnv({ ...s3, MCP_BROWSER_PROFILE: value }))).toEqual([
          'MCP_BROWSER_PROFILE: must be one of off, local',
        ])
    })

    it('runs beside core and llm in the local process with the shared S3 settings', () => {
      const config = loadConfig({ ...devEnv, MCP_CONTENT_PROFILE: 'local-site' })
      expect(config.mcp?.storage).toEqual({
        endpoint: 'http://localhost:8333',
        region: 'ru-central1',
        accessKeyId: 'raditi',
        secretAccessKey: 'raditi-dev-secret',
        forcePathStyle: true,
        buckets: { artifacts: 'raditi-artifacts' },
      })
      expect(config.core?.storage.buckets.sessions).toBe('raditi-sessions')
    })
  })

  it('defaults to core,mcp,llm and the dev metrics token', () => {
    const config = loadConfig({
      ...devEnv,
      ORCHESTRATOR_ROLES: undefined,
      ORCHESTRATOR_PORT: '',
      MCP_PORT: undefined,
      METRICS_TOKEN: '',
    })

    expect(config.roles).toEqual(['core', 'mcp', 'llm'])
    expect(config.core?.port).toBe(8081)
    expect(config.mcp?.port).toBe(8082)
    expect(config.llm).toMatchObject({
      port: 8084,
      egress: { proxyUrl: null },
      listenHost: '127.0.0.1',
    })
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

  it('ignores settings of inactive roles in the shared local environment', () => {
    const unrelated = {
      ORCHESTRATOR_PORT: 'unused',
      TURN_EXECUTOR: 'unused',
      REDIS_URL: 'unused',
      RUNNER_API_PORT: 'unused',
      RUNNER_TOKENS: 'unused',
      RUNNER_CORE_URL: 'unused',
      RUNNER_S3_ORIGIN: 'unused',
      RUNNER_MAX_TURNS: '4',
    }
    expect(loadConfig({ ...devEnv, ...unrelated, ORCHESTRATOR_ROLES: 'mcp' }).mcp?.port).toBe(8082)
    expect(
      loadConfig({
        ...devEnv,
        ORCHESTRATOR_ROLES: 'core',
        MCP_PORT: 'unused',
        RUNNER_API_PORT: 'unused',
        RUNNER_CORE_URL: 'unused',
        RUNNER_S3_ORIGIN: 'unused',
        RUNNER_MAX_TURNS: '4',
      }).core?.port,
    ).toBe(8081)
    expect(
      loadConfig({
        APP_ENV: 'development',
        ORCHESTRATOR_ROLES: 'runner',
        ORCHESTRATOR_PORT: 'unused',
        MCP_PORT: 'unused',
        REDIS_URL: 'unused',
        RUNNER_API_PORT: 'unused',
        TURN_EXECUTOR: 'unused',
        RUNNER_CORE_URL: 'http://127.0.0.1:8083',
        RUNNER_TOKEN_FILE: '/tmp/runner-token',
      }).runner?.coreUrl,
    ).toEqual(new URL('http://127.0.0.1:8083'))
  })

  it('still rejects invalid settings when their role or runner API is active', () => {
    expect(problemsOf({ ...devEnv, ORCHESTRATOR_ROLES: 'mcp', MCP_PORT: 'unused' })[0]).toMatch(
      /^MCP_PORT:/,
    )
    expect(
      problemsOf({ ...devEnv, TURN_EXECUTOR: 'runner', RUNNER_API_PORT: 'unused' })[0],
    ).toMatch(/^RUNNER_API_PORT:/)
    expect(
      problemsOf({
        APP_ENV: 'development',
        ORCHESTRATOR_ROLES: 'runner',
        RUNNER_CORE_URL: 'unused',
        RUNNER_MAX_TURNS: '4',
      }),
    ).toEqual([
      'RUNNER_CORE_URL: must be an http(s):// URL',
      'RUNNER_MAX_TURNS: one turn per runner until several runners are supported (stage 2)',
    ])
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
      RUNNER_TOKENS: `sandbox-1:${RUNNER_HASH}@127.0.0.1`,
      SANDBOX_RUNTIME: 'kata',
    })
    expect(runner.core?.sandbox).toBeNull()
  })

  it('runs turns in core by default and on runners with their token hashes', () => {
    expect(loadConfig(devEnv).core).toMatchObject({ turnExecutor: 'local', runnerApi: null })
    const runner = loadConfig({
      ...devEnv,
      TURN_EXECUTOR: 'runner',
      RUNNER_TOKENS: ` sandbox-1:${RUNNER_HASH}@127.0.0.1, sandbox-1:${'B'.repeat(64)}@127.0.0.1,sandbox-2:${'c'.repeat(64)}@[::1] `,
    }).core
    expect(runner?.turnExecutor).toBe('runner')
    expect(runner?.runnerApi?.port).toBe(8083)
    expect([...runner!.runnerApi!.tokens.keys()]).toEqual(['sandbox-1', 'sandbox-2'])
    expect(
      runner!.runnerApi!.tokens.get('sandbox-1')!.map((hash) => hash.digest.toString('hex')),
    ).toEqual([RUNNER_HASH, 'b'.repeat(64)])
  })

  it('binds every runner to one address at start: its turn keys are issued for it', () => {
    const runner = { ...devEnv, TURN_EXECUTOR: 'runner' }
    // Outside production a runner on this machine reaches core from loopback.
    const tokens = loadConfig({ ...runner, RUNNER_TOKENS: `sandbox-1:${RUNNER_HASH}@127.0.0.1` })
      .core!.runnerApi!.tokens
    expect(runnerCredentialAddress(tokens, 'sandbox-1')).toBe('127.0.0.1')
    const unbound =
      'RUNNER_TOKENS: runner sandbox-1 needs one @<IP address> on every hash (its turn keys are bound to it)'
    for (const RUNNER_TOKENS of [
      `sandbox-1:${RUNNER_HASH}`,
      `sandbox-1:${RUNNER_HASH}@127.0.0.1,sandbox-1:${'b'.repeat(64)}`,
      `sandbox-1:${RUNNER_HASH}@127.0.0.1,sandbox-1:${'b'.repeat(64)}@10.0.0.2`,
    ]) {
      const problems = problemsOf({ ...runner, RUNNER_TOKENS })
      expect(problems).toEqual([unbound])
      expect(problems.join('\n')).not.toMatch(/aaaa|bbbb|10\.0\.0\.2/)
    }
    // A rotation in production: both hashes of a VM name its one private address.
    expect(
      problemsOf(
        prodEnv({
          RUNNER_TOKENS: `sandbox-1:${RUNNER_HASH}@10.20.0.11,sandbox-1:${'b'.repeat(64)}@10.20.0.12`,
        }),
      ),
    ).toEqual([unbound])
    // The local executor serves no runner API: its tokens are not read.
    expect(
      loadConfig({ ...devEnv, RUNNER_TOKENS: `sandbox-1:${RUNNER_HASH}` }).core?.runnerApi,
    ).toBe(null)
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
        `sandbox-1:${RUNNER_HASH}@127.0.0.1`,
        `sandbox-1:${RUNNER_HASH}@127.0.0.1`,
        `sandbox-1:${'b'.repeat(64)}@127.0.0.1`,
        `sandbox-1:${'c'.repeat(64)}@127.0.0.1`,
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
      'ORCHESTRATOR_ROLES: unknown role "worker"; expected core, mcp, runner, llm, preview',
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

  it('starts the roles of `pnpm dev` and `pnpm e2e` from a fresh copy of .env.example', () => {
    expect(loadConfig(exampleEnv)).toMatchObject({
      roles: ['core', 'mcp', 'llm', 'preview'],
      core: {
        turnExecutor: 'local',
        agentDrivers: { image: exampleEnv.SANDBOX_IMAGE },
        previews: {
          address: { baseDomain: 'localhost', scheme: 'http', publicPort: 8090 },
          executor: 'local',
          runtime: 'runc',
          upstreamHost: '127.0.0.1',
        },
        releaseApi: { host: '127.0.0.1', port: 8085, startTimeoutMinutes: 10 },
      },
      preview: {
        port: 8090,
        address: { baseDomain: 'localhost', scheme: 'http', publicPort: 8090 },
        sessionSecret: DEV_PREVIEW_SESSION_SECRET,
      },
    })
    // apps/e2e/playwright.config.ts on top of the same file.
    const e2e = loadConfig({
      ...exampleEnv,
      APP_ENV: 'test',
      ORCHESTRATOR_ROLES: 'core,mcp',
      ORCHESTRATOR_PORT: '8181',
      MCP_PORT: '8182',
      TURN_EXECUTOR: 'local',
    })
    expect(e2e).toMatchObject({ roles: ['core', 'mcp'], core: { port: 8181 }, mcp: { port: 8182 } })
  })

  it('lets a local sandbox-gw reach MCP and llm at the host Docker Desktop names them by', () => {
    // sandbox-gw sends its upstream's Host: SANDBOX_MCP_UPSTREAM=http://host.docker.internal:8082.
    const config = loadConfig(exampleEnv)
    expect(config.llm?.hosts).toContain('host.docker.internal:8084')
    expect(
      mcpHeadersAllowed(
        { host: 'host.docker.internal:8082' },
        { allowedHosts: config.mcp!.allowedHosts, allowLocalOrigin: true },
      ),
    ).toBe(true)
  })

  it('starts core outside production without SANDBOX_IMAGE: nothing reads the image before P12', () => {
    // A .env from before P4, or none at all: the image stands for the .env.example placeholder.
    const { SANDBOX_IMAGE: placeholder, ...older } = exampleEnv
    expect(placeholder).toMatch(/@sha256:0{64}$/)
    for (const env of [
      older,
      { ...older, APP_ENV: 'test', SANDBOX_IMAGE: ' ' },
      {
        ...devEnv,
        SANDBOX_IMAGE: undefined,
        TURN_EXECUTOR: 'runner',
        RUNNER_TOKENS: `sandbox-1:${RUNNER_HASH}@127.0.0.1`,
      },
    ])
      expect(loadConfig(env).core?.agentDrivers).toEqual({ image: placeholder })
    // A value that is set is still checked.
    expect(problemsOf({ ...older, SANDBOX_IMAGE: 'raditi/sbx-wordpress:latest' })).toEqual([
      expect.stringMatching(/^\[agent drivers\] invalid configuration: SANDBOX_IMAGE: /),
    ])
  })

  it('lists every broken section at once without leaking values', () => {
    const problems = problemsOf({
      ...devEnv,
      DATABASE_URL: 'mysql://root:hunter2@localhost/raditi',
      S3_ENDPOINT: '',
      SANDBOX_IMAGE: 'Raditi/Agent:latest',
    })

    expect(problems).toHaveLength(3)
    expect(problems[0]).toBe(
      '[db] invalid configuration: DATABASE_URL: must be a postgresql:// connection string',
    )
    expect(problems[1]).toMatch(/^\[storage\] invalid configuration: S3_ENDPOINT: /)
    expect(problems[2]).toMatch(/^\[agent drivers\] invalid configuration: SANDBOX_IMAGE: /)
    expect(problems.join('\n')).not.toMatch(/hunter2|raditi-dev-secret/)
  })

  describe('git for site repositories (spec §10)', () => {
    const gitEnv = (overrides: Env = {}): Env => ({
      ...devEnv,
      GITEA_URL: 'https://gitea.raditi.test:3443',
      GITEA_TOKEN: 'synthetic-bot-token',
      ...overrides,
    })

    it('configures git from an https Gitea, its bot token and an optional CA file', () => {
      expect(loadConfig(gitEnv()).core?.git).toEqual({
        kind: 'gitea',
        baseUrl: 'https://gitea.raditi.test:3443',
        token: 'synthetic-bot-token',
        caFile: null,
      })
      expect(
        loadConfig(
          gitEnv({
            GITEA_URL: 'https://host.raditi.test/gitea/',
            GIT_CA_FILE: '/run/raditi/gitea-ca.pem',
          }),
        ).core?.git,
      ).toEqual({
        kind: 'gitea',
        baseUrl: 'https://host.raditi.test/gitea',
        token: 'synthetic-bot-token',
        caFile: '/run/raditi/gitea-ca.pem',
      })
    })

    it('takes the directory of the repository mirrors when it is set (plan 53, Р10)', () => {
      expect(loadConfig(gitEnv({ GIT_MIRROR_DIR: '/work/mirrors' })).core?.git).toMatchObject({
        mirrorDir: '/work/mirrors',
      })
      expect(loadConfig(gitEnv({ GIT_MIRROR_DIR: '' })).core?.git).not.toHaveProperty('mirrorDir')
    })

    it('leaves git unconfigured, and core starting, with the plain-http Gitea of .env.example', () => {
      expect(exampleEnv.GITEA_URL).toBe('http://localhost:3300')
      expect(loadConfig(exampleEnv).core?.git).toBeNull()
      // A token does not make plain http a git transport (spec §19).
      expect(loadConfig(gitEnv({ GITEA_URL: 'http://localhost:3300' })).core?.git).toBeNull()
      expect(loadConfig(devEnv).core?.git).toBeNull()
    })

    it('names what is wrong with a half-configured git, never the values', () => {
      expect(problemsOf(gitEnv({ GITEA_TOKEN: '' }))).toEqual([
        'GITEA_TOKEN: required with an https GITEA_URL',
      ])
      expect(problemsOf(gitEnv({ GITEA_TOKEN: 'two words' }))).toEqual([
        'GITEA_TOKEN: must be printable ASCII without whitespace',
      ])
      expect(problemsOf(gitEnv({ GIT_CA_FILE: 'gitea-ca.pem' }))).toEqual([
        'GIT_CA_FILE: must be an absolute path',
      ])
      expect(problemsOf(gitEnv({ GIT_MIRROR_DIR: 'mirrors' }))).toEqual([
        'GIT_MIRROR_DIR: must be an absolute path',
      ])
      for (const url of [
        'https://bot:password@gitea.raditi.test',
        'https://gitea.raditi.test/?token=1',
        'https://gitea.raditi.test/#x',
      ])
        expect(problemsOf(gitEnv({ GITEA_URL: url }))).toEqual([
          'GITEA_URL: expected an address without credentials, query or fragment',
        ])
      expect(problemsOf(gitEnv({ GITEA_URL: 'ssh://gitea.raditi.test' }))).toEqual([
        'GITEA_URL: must be an http(s):// URL',
      ])
    })

    it('reads the git settings only for the core role', () => {
      const config = loadConfig({
        ...gitEnv({ GITEA_URL: 'not a url', GIT_CA_FILE: 'relative' }),
        ORCHESTRATOR_ROLES: 'mcp',
      })
      expect(config.core).toBeNull()
    })

    const creatorToken = 'synthetic-provisioner-token'

    it('leaves the token that creates site repositories null until it is set', () => {
      expect(exampleEnv.GITEA_PROVISIONER_TOKEN).toBe('')
      expect(loadConfig(exampleEnv).core?.siteRepositoryProvisionerToken).toBeNull()
      expect(loadConfig(devEnv).core?.siteRepositoryProvisionerToken).toBeNull()
      // The bot's token never stands in for it.
      expect(loadConfig(gitEnv()).core?.siteRepositoryProvisionerToken).toBeNull()
      expect(
        loadConfig(gitEnv({ GITEA_PROVISIONER_TOKEN: ' ' })).core?.siteRepositoryProvisionerToken,
      ).toBeNull()
    })

    it('takes the creator token beside git with an https Gitea, and git stays as it was', () => {
      const core = loadConfig(gitEnv({ GITEA_PROVISIONER_TOKEN: creatorToken })).core
      expect(core?.siteRepositoryProvisionerToken).toBe(creatorToken)
      expect(core?.git).toEqual({
        kind: 'gitea',
        baseUrl: 'https://gitea.raditi.test:3443',
        token: 'synthetic-bot-token',
        caFile: null,
      })
      expect(
        loadConfig(
          prodEnv({
            GITEA_URL: 'https://gitea.raditi.internal',
            GITEA_TOKEN: 'synthetic-token',
            GITEA_PROVISIONER_TOKEN: creatorToken,
          }),
        ).core?.siteRepositoryProvisionerToken,
      ).toBe(creatorToken)
    })

    it('has no creator token where git is not configured: there is no Gitea to create in', () => {
      for (const env of [
        gitEnv({ GITEA_URL: 'http://localhost:3300', GITEA_PROVISIONER_TOKEN: creatorToken }),
        { ...devEnv, GITEA_PROVISIONER_TOKEN: creatorToken },
        prodEnv({ GITEA_PROVISIONER_TOKEN: creatorToken }),
      ]) {
        const core = loadConfig(env).core
        expect(core?.git).toBeNull()
        expect(core?.siteRepositoryProvisionerToken).toBeNull()
      }
    })

    it('refuses a creator token no Authorization header carries, never printing it', () => {
      const refused = ['GITEA_PROVISIONER_TOKEN: must be printable ASCII without whitespace']
      for (const token of ['two words', `${creatorToken}\n`, `\t${creatorToken}`, 'токен'])
        expect(problemsOf(gitEnv({ GITEA_PROVISIONER_TOKEN: token }))).toEqual(refused)
      // Reported with the plain-http Gitea as well, where the token is not used yet.
      expect(problemsOf({ ...devEnv, GITEA_PROVISIONER_TOKEN: 'two words' })).toEqual(refused)
      // A missing bot token is not replaced by the creator's.
      expect(
        problemsOf(gitEnv({ GITEA_TOKEN: '', GITEA_PROVISIONER_TOKEN: creatorToken })),
      ).toEqual(['GITEA_TOKEN: required with an https GITEA_URL'])
    })

    it('reads the creator token only for the core role, and never on a runner VM', () => {
      const config = loadConfig({
        ...gitEnv({ GITEA_PROVISIONER_TOKEN: 'two words' }),
        ORCHESTRATOR_ROLES: 'mcp',
      })
      expect(config.core).toBeNull()
      expect(config.mcp).not.toBeNull()
      const problems = problemsOf({
        APP_ENV: 'production',
        ORCHESTRATOR_ROLES: 'runner',
        RUNNER_CORE_URL: 'https://core.internal:8083',
        RUNNER_TOKEN_FILE: '/etc/raditi/runner-token',
        RUNNER_S3_ORIGIN: 'https://raditi-sessions.storage.yandexcloud.net',
        SANDBOX_RUNTIME: 'runsc',
        GITEA_PROVISIONER_TOKEN: creatorToken,
      })
      expect(problems).toEqual([
        'GITEA_PROVISIONER_TOKEN: must not be set for the runner role in production',
      ])
      expect(problems.join('\n')).not.toContain(creatorToken)
    })
  })

  describe('the ЮKassa shop for renewal charges', () => {
    const shop = { YOOKASSA_SHOP_ID: '123456', YOOKASSA_SECRET_KEY: 'test_shop-secret-key' }

    it('leaves payments off, and core starting, without the shop credentials', () => {
      expect(exampleEnv.YOOKASSA_SHOP_ID).toBe('')
      expect(exampleEnv.YOOKASSA_SECRET_KEY).toBe('')
      expect(exampleEnv.YOOKASSA_API_URL).toBe('')
      expect(exampleEnv.YOOKASSA_WEBHOOK_ALLOWLIST).toBe('')
      expect(exampleEnv.YOOKASSA_AUTOPAYMENTS).toBe('')
      expect(loadConfig(exampleEnv).core?.yookassa).toBeNull()
      expect(loadConfig(devEnv).core?.yookassa).toBeNull()
    })

    it('reads the shop, the address of a local fake and its notification senders', () => {
      expect(loadConfig({ ...devEnv, ...shop }).core?.yookassa).toEqual({
        shopId: '123456',
        secretKey: 'test_shop-secret-key',
        // Unset outside production: a local fake saves payment methods.
        autopayments: true,
      })
      expect(
        loadConfig({
          ...devEnv,
          ...shop,
          YOOKASSA_API_URL: 'http://127.0.0.1:4010/v3/',
          YOOKASSA_WEBHOOK_ALLOWLIST: '127.0.0.1, ::1',
        }).core?.yookassa,
      ).toEqual({
        shopId: '123456',
        secretKey: 'test_shop-secret-key',
        baseUrl: 'http://127.0.0.1:4010/v3',
        webhookAllowlist: ['127.0.0.1', '::1'],
        autopayments: true,
      })
    })

    it('reads the switch of autopayments with the shop', () => {
      // The renewal passes do not act on it: a method saved before is charged all the same.
      // core reads it with the rest of the shop, so that web and core are given one setting.
      for (const [YOOKASSA_AUTOPAYMENTS, autopayments] of [
        ['on', true],
        ['off', false],
      ] as const) {
        expect(
          loadConfig({ ...devEnv, ...shop, YOOKASSA_AUTOPAYMENTS }).core?.yookassa,
        ).toMatchObject({ autopayments })
      }
      expect(problemsOf({ ...devEnv, ...shop, YOOKASSA_AUTOPAYMENTS: 'yes' })).toEqual([
        '[yookassa] invalid configuration: YOOKASSA_AUTOPAYMENTS: must be on or off',
      ])
    })

    it('names what is wrong with a half-configured shop, never the values', () => {
      expect(problemsOf({ ...devEnv, YOOKASSA_SECRET_KEY: shop.YOOKASSA_SECRET_KEY })).toEqual([
        '[yookassa] invalid configuration: YOOKASSA_SHOP_ID: YOOKASSA_SHOP_ID and YOOKASSA_SECRET_KEY must be set together',
      ])
      expect(problemsOf({ ...devEnv, YOOKASSA_SHOP_ID: shop.YOOKASSA_SHOP_ID })).toEqual([
        '[yookassa] invalid configuration: YOOKASSA_SECRET_KEY: YOOKASSA_SHOP_ID and YOOKASSA_SECRET_KEY must be set together',
      ])
      const problems = problemsOf({
        ...devEnv,
        ...shop,
        YOOKASSA_API_URL: 'http://shop:hunter2@127.0.0.1:4010/v3',
        YOOKASSA_WEBHOOK_ALLOWLIST: 'localhost',
      })
      expect(problems).toEqual([
        '[yookassa] invalid configuration: ' +
          'YOOKASSA_WEBHOOK_ALLOWLIST: must be IP addresses or CIDR ranges separated by commas; ' +
          'YOOKASSA_API_URL: expected an address without credentials, query or fragment',
      ])
      expect(problems.join('\n')).not.toMatch(/hunter2|test_shop-secret-key/)
    })

    it('neither requires nor reads the shop settings in the other roles', () => {
      const broken = {
        YOOKASSA_SHOP_ID: 'not digits',
        YOOKASSA_API_URL: 'not a url',
        YOOKASSA_WEBHOOK_ALLOWLIST: 'not an address',
      }
      for (const role of ['mcp', 'llm'] as const) {
        const config = loadConfig({ ...devEnv, ...broken, ORCHESTRATOR_ROLES: role })
        expect(config.core).toBeNull()
        expect(config[role]).not.toBeNull()
      }
      expect(
        loadConfig({
          APP_ENV: 'development',
          ORCHESTRATOR_ROLES: 'runner',
          RUNNER_CORE_URL: 'http://127.0.0.1:8083',
          RUNNER_TOKEN_FILE: '/tmp/runner-token',
          ...broken,
        }).core,
      ).toBeNull()
      // The same settings stop core.
      expect(problemsOf({ ...devEnv, ...broken, ORCHESTRATOR_ROLES: 'core' })[0]).toMatch(
        /^\[yookassa\] invalid configuration: /,
      )
    })
  })

  describe('renewal of tariffs', () => {
    it('reads .env.example as it is: a notice three days before, seven days of grace, a pass every five minutes', () => {
      expect(exampleEnv.BILLING_RENEWAL_NOTICE_DAYS).toBe('3')
      expect(exampleEnv.BILLING_PAST_DUE_DAYS).toBe('7')
      expect(exampleEnv.BILLING_TICK_SECONDS).toBe('300')
      const billing = {
        appUrl: 'http://localhost:3000',
        renewalNoticeDays: 3,
        pastDueDays: 7,
        tickSeconds: 300,
      }
      expect(loadConfig(exampleEnv).core?.billing).toEqual(billing)
      // The same without the three variables, and with blank ones.
      expect(loadConfig(devEnv).core?.billing).toEqual(billing)
      expect(
        loadConfig({
          ...devEnv,
          BILLING_RENEWAL_NOTICE_DAYS: '',
          BILLING_PAST_DUE_DAYS: ' ',
          BILLING_TICK_SECONDS: '',
        }).core?.billing,
      ).toEqual(billing)
    })

    it('takes its own values, as the verification stand sets them', () => {
      expect(
        loadConfig({
          ...devEnv,
          APP_URL: 'http://127.0.0.1:3110/',
          BILLING_RENEWAL_NOTICE_DAYS: '5',
          BILLING_PAST_DUE_DAYS: '14',
          BILLING_TICK_SECONDS: '2',
        }).core?.billing,
      ).toEqual({
        // No trailing slash: links are built by appending a path.
        appUrl: 'http://127.0.0.1:3110',
        renewalNoticeDays: 5,
        pastDueDays: 14,
        tickSeconds: 2,
      })
    })

    it.each([
      ['BILLING_RENEWAL_NOTICE_DAYS', ['0', '28', '2.5', 'three', '-1']],
      ['BILLING_PAST_DUE_DAYS', ['0', '91', '1.5', 'week']],
      ['BILLING_TICK_SECONDS', ['0', '3601', '0.5', '5m']],
    ])('refuses %s out of its range, naming the variable and not the value', (name, values) => {
      for (const value of values) {
        const problems = problemsOf({ ...devEnv, [name]: value })
        expect(problems).toHaveLength(1)
        expect(problems[0]).toMatch(new RegExp(`^${name}: `))
        expect(problems[0]).not.toContain(`: ${value}`)
      }
    })

    it('needs APP_URL for the letters of core, and an address that opens in a browser', () => {
      const { APP_URL: _appUrl, ...withoutAppUrl } = devEnv
      expect(problemsOf(withoutAppUrl)).toEqual([
        'APP_URL: required for the core role (billing letters link to the app)',
      ])
      expect(problemsOf({ ...devEnv, APP_URL: '' })).toEqual([
        'APP_URL: required for the core role (billing letters link to the app)',
      ])
      for (const address of ['raditi.ru', 'ftp://raditi.ru', 'javascript:alert(1)']) {
        expect(problemsOf({ ...devEnv, APP_URL: address })).toEqual([
          'APP_URL: must be an http(s) URL',
        ])
      }
    })

    it('is nothing the other roles read or require', () => {
      const unused = {
        APP_URL: 'not a url',
        BILLING_RENEWAL_NOTICE_DAYS: 'unused',
        BILLING_PAST_DUE_DAYS: 'unused',
        BILLING_TICK_SECONDS: 'unused',
      }
      const { APP_URL: _appUrl, ...withoutAppUrl } = devEnv
      for (const roles of ['mcp', 'llm', 'mcp,llm']) {
        expect(loadConfig({ ...withoutAppUrl, ORCHESTRATOR_ROLES: roles }).core).toBeNull()
        expect(loadConfig({ ...devEnv, ...unused, ORCHESTRATOR_ROLES: roles }).core).toBeNull()
      }
      expect(
        loadConfig({
          APP_ENV: 'development',
          ORCHESTRATOR_ROLES: 'runner',
          RUNNER_CORE_URL: 'http://127.0.0.1:8083',
          RUNNER_TOKEN_FILE: '/tmp/runner-token',
          ...unused,
        }).runner,
      ).not.toBeNull()
    })
  })
})

describe('loadConfig — production', () => {
  it('leaves the control endpoint absent until an operator configures its private origin', () => {
    expect(loadConfig(prodEnv()).core?.llmControlUrl).toBeUndefined()
    expect(
      loadConfig(prodEnv({ LLM_CONTROL_URL: 'http://10.20.0.4:8084' })).core?.llmControlUrl,
    ).toBe('http://10.20.0.4:8084')
    for (const origin of [
      'https://public.example',
      'http://8.8.8.8',
      'http://10.20.0.4/path',
      'http://secret:private@10.20.0.4',
      'http://10.20.0.4?secret=private',
    ]) {
      const problems = problemsOf(prodEnv({ LLM_CONTROL_URL: origin }))
      expect(problems).toContain(
        'LLM_CONTROL_URL: must be an http(s) origin at a private IP or loopback address',
      )
      expect(problems.join(' ')).not.toContain('secret')
    }
    for (const value of ['0', '-1', '101', 'NaN'])
      expect(
        problemsOf(prodEnv({ LLM_POOL_MIN_TURN_HEADROOM_PCT: value })).some((problem) =>
          problem.startsWith('LLM_POOL_MIN_TURN_HEADROOM_PCT:'),
        ),
      ).toBe(true)
  })

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

  it('takes a ЮKassa shop or none, and never the settings of a local fake', () => {
    const credentials = { YOOKASSA_SHOP_ID: '123456', YOOKASSA_SECRET_KEY: 'live_shop-secret-key' }
    const shop = { ...credentials, YOOKASSA_AUTOPAYMENTS: 'on' }
    expect(loadConfig(prodEnv()).core?.yookassa).toBeNull()
    expect(loadConfig(prodEnv(shop)).core?.yookassa).toEqual({
      shopId: '123456',
      secretKey: 'live_shop-secret-key',
      autopayments: true,
    })
    expect(
      loadConfig(prodEnv({ ...credentials, YOOKASSA_AUTOPAYMENTS: 'off' })).core?.yookassa,
    ).toMatchObject({ autopayments: false })
    // A shop in production says whether ЮKassa has approved its autopayments: never guessed.
    const unsaid = problemsOf(prodEnv(credentials))
    expect(unsaid).toEqual([
      '[yookassa] invalid configuration: YOOKASSA_AUTOPAYMENTS: must be set to on or off in production ' +
        '(YooKassa answers 403 to save_payment_method until its manager approves autopayments for the shop)',
    ])
    expect(unsaid.join('\n')).not.toContain('live_shop-secret-key')
    const fake = {
      YOOKASSA_API_URL: 'https://fake.internal/v3',
      YOOKASSA_WEBHOOK_ALLOWLIST: '10.20.0.5',
    }
    for (const configured of [shop, {}]) {
      const problems = problemsOf(prodEnv({ ...configured, ...fake }))
      expect(problems).toEqual([
        '[yookassa] invalid configuration: ' +
          'YOOKASSA_API_URL: not allowed in production (the real API address is built in); ' +
          'YOOKASSA_WEBHOOK_ALLOWLIST: not allowed in production (notifications come from the published ranges only)',
      ])
      expect(problems.join('\n')).not.toContain('live_shop-secret-key')
    }
    expect(problemsOf(prodEnv({ YOOKASSA_SHOP_ID: shop.YOOKASSA_SHOP_ID }))).toEqual([
      '[yookassa] invalid configuration: YOOKASSA_SECRET_KEY: YOOKASSA_SHOP_ID and YOOKASSA_SECRET_KEY must be set together',
    ])
    // The subscription gateway and the MCP gateway hold no shop settings and read none.
    expect(loadConfig(llmEnv(fake)).llm).not.toBeNull()
    expect(
      loadConfig(prodEnv({ ...fake, ORCHESTRATOR_ROLES: 'mcp', MCP_ALLOWED_HOSTS: 'mcp' })).mcp,
    ).not.toBeNull()
  })

  it('links billing letters to the https address of the app only', () => {
    expect(loadConfig(prodEnv()).core?.billing).toEqual({
      appUrl: 'https://raditi.ru',
      renewalNoticeDays: 3,
      pastDueDays: 7,
      tickSeconds: 300,
    })
    expect(problemsOf(prodEnv({ APP_URL: 'http://raditi.ru' }))).toEqual([
      'APP_URL: must use https in production',
    ])
    expect(problemsOf(prodEnv({ APP_URL: '' }))).toEqual([
      'APP_URL: required for the core role (billing letters link to the app)',
    ])
    // The gateways open no letter and need no address of the app.
    expect(loadConfig(llmEnv()).llm).not.toBeNull()
    expect(
      loadConfig(prodEnv({ APP_URL: '', ORCHESTRATOR_ROLES: 'mcp', MCP_ALLOWED_HOSTS: 'mcp' })).mcp,
    ).not.toBeNull()
  })

  it('requires the digest of the built stack image in production', () => {
    expect(problemsOf(prodEnv({ SANDBOX_IMAGE: undefined }))).toEqual([
      expect.stringMatching(/^\[agent drivers\] invalid configuration: SANDBOX_IMAGE: /),
    ])
    // What infra/app/env.example and .env.example carry until an image is built.
    expect(problemsOf(prodEnv({ SANDBOX_IMAGE: exampleEnv.SANDBOX_IMAGE }))).toEqual([
      '[agent drivers] invalid configuration: SANDBOX_IMAGE: the all-zero digest is the env.example placeholder: set the digest of the built stack image',
    ])
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

  it('refuses a METRICS_TOKEN with whitespace in any environment: no Bearer header carries it', () => {
    const refused = 'METRICS_TOKEN: must not contain whitespace (it is sent as a Bearer token)'
    const spaced = 'my long metrics token with spaces 1234567890'
    for (const env of [
      prodEnv({ METRICS_TOKEN: spaced }),
      prodEnv({ METRICS_TOKEN: `${PROD_METRICS_TOKEN}\n` }),
      llmEnv({ METRICS_TOKEN: ` ${PROD_METRICS_TOKEN}` }),
      { ...devEnv, METRICS_TOKEN: 'dev token' },
      { ...devEnv, ORCHESTRATOR_ROLES: 'llm', METRICS_TOKEN: 'dev-token\t' },
    ]) {
      const problems = problemsOf(env)
      expect(problems).toEqual([refused])
      expect(problems.join('\n')).not.toMatch(/spaces|dev token|xxxx/)
    }
  })

  it('gives core and llm of one process the same token', () => {
    const config = loadConfig({ ...devEnv, METRICS_TOKEN: 'local-token' })
    expect(config.core?.metricsToken).toBe('local-token')
    expect(config.llm?.metricsToken).toBe('local-token')
  })

  it('does not ask the MCP gateway for a metrics token: it serves no /metrics', () => {
    const config = loadConfig(
      prodEnv({ ORCHESTRATOR_ROLES: 'mcp', MCP_ALLOWED_HOSTS: 'mcp', METRICS_TOKEN: '' }),
    )
    expect(config.mcp?.port).toBe(8082)
  })

  it('refuses every content profile but off for the mcp role in production', () => {
    const mcp = (overrides: Env = {}) =>
      prodEnv({ ORCHESTRATOR_ROLES: 'mcp', MCP_ALLOWED_HOSTS: 'mcp', ...overrides })
    for (const value of [undefined, '', 'off'])
      expect(loadConfig(mcp({ MCP_CONTENT_PROFILE: value })).mcp).toMatchObject({
        contentProfile: 'off',
        storage: null,
      })
    // With every S3 setting in place: the refusal is the profile itself, not a missing value.
    for (const value of ['local', 'local-site'])
      expect(problemsOf(mcp({ MCP_CONTENT_PROFILE: value }))).toEqual([
        'MCP_CONTENT_PROFILE: only off is allowed in production (published content is not open there)',
      ])
    expect(
      problemsOf(mcp({ MCP_CONTENT_PROFILE: 'local', S3_ENDPOINT: '', S3_ACCESS_KEY_ID: '' })),
    ).toEqual([
      'MCP_CONTENT_PROFILE: only off is allowed in production (published content is not open there)',
    ])
    // The agent's browser on a preview (plan 53, Р21) is not open there either.
    expect(loadConfig(mcp({ MCP_BROWSER_PROFILE: 'off' })).mcp).toMatchObject({
      browserProfile: 'off',
      storage: null,
    })
    expect(problemsOf(mcp({ MCP_BROWSER_PROFILE: 'local' }))).toEqual([
      'MCP_BROWSER_PROFILE: only off is allowed in production (the agent browser is not open there)',
    ])
  })

  it('starts the subscription gateway alone with production settings', () => {
    const config = loadConfig(llmEnv())
    expect(config).toMatchObject({ roles: ['llm'], core: null, mcp: null, runner: null })
    expect(config.llm).toMatchObject({
      appEnv: 'production',
      listenHost: '0.0.0.0',
      metricsToken: PROD_METRICS_TOKEN,
      db: { databaseUrl: 'postgresql://raditi:secret@db.internal:5432/raditi' },
      vault: { addr: 'https://vault.internal:8200', appRole: { roleId: 'llm-role' } },
    })
    expect(config.llm?.vault.token).toBeUndefined()
  })

  it('refuses the gateway alone an empty, dev or short METRICS_TOKEN, without leaking it', () => {
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

  it('keeps the Vault rules for the gateway alone: https, AppRole, never the dev root token', () => {
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
        LLM_API_KEY: 'sk-provider-secret',
        ZAI_API_KEY: 'plan-secret',
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
      'LLM_API_KEY: must not be set for the runner role in production',
      'METRICS_TOKEN: must not be set for the runner role in production',
      'NODE_OPTIONS: must not be set for the runner role in production',
      'REDIS_URL: must not be set for the runner role in production',
      'S3_SECRET_ACCESS_KEY: must not be set for the runner role in production',
      'VAULT_ADDR: must not be set for the runner role in production',
      'VAULT_SECRET_ID: must not be set for the runner role in production',
      'ZAI_API_KEY: must not be set for the runner role in production',
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

  it('refuses a plain-http Gitea in production and takes an https one', () => {
    expect(
      problemsOf(prodEnv({ GITEA_URL: 'http://10.20.0.6:3000', GITEA_TOKEN: 'synthetic-token' })),
    ).toEqual(['GITEA_URL: must use https in production (spec §19)'])
    expect(problemsOf(prodEnv({ GITEA_URL: 'https://gitea.raditi.internal' }))).toEqual([
      'GITEA_TOKEN: required with an https GITEA_URL',
    ])
    expect(
      loadConfig(
        prodEnv({
          GITEA_URL: 'https://gitea.raditi.internal',
          GITEA_TOKEN: 'synthetic-token',
          GIT_CA_FILE: '/run/raditi/gitea-ca.pem',
        }),
      ).core?.git,
    ).toEqual({
      kind: 'gitea',
      baseUrl: 'https://gitea.raditi.internal',
      token: 'synthetic-token',
      caFile: '/run/raditi/gitea-ca.pem',
    })
    // Until the turn handler is wired (P12) a core without git still starts.
    expect(loadConfig(prodEnv()).core?.git).toBeNull()
  })
})

describe('loadConfig — previews and releases', () => {
  const digest = `@sha256:${'a'.repeat(64)}`
  const previewDev = (overrides: Env = {}): Env => ({
    ...devEnv,
    ORCHESTRATOR_ROLES: 'core,mcp,preview',
    PREVIEW_BASE_DOMAIN: 'localhost',
    PREVIEW_PUBLIC_PORT: '8090',
    ...overrides,
  })
  const previewProd = (overrides: Env = {}): Env =>
    prodEnv({
      PREVIEW_BASE_DOMAIN: 'preview.raditi-sites.ru',
      RELEASE_API_HOST: '10.20.0.4',
      RELEASE_API_PUBLIC_URL: 'http://10.20.0.4:8085',
      ...overrides,
    })
  const gatewayProd = (overrides: Env = {}): Env => ({
    APP_ENV: 'production',
    APP_URL: 'https://raditi.ru',
    ORCHESTRATOR_ROLES: 'preview',
    DATABASE_URL: 'postgresql://raditi:secret@db.internal:5432/raditi',
    PREVIEW_BASE_DOMAIN: 'preview.raditi-sites.ru',
    PREVIEW_SESSION_SECRET: 's'.repeat(32),
    ...overrides,
  })

  it('builds no preview without a base domain and starts core as before', () => {
    expect(loadConfig(devEnv).core).toMatchObject({ previews: null })
    expect(loadConfig(prodEnv()).core).toMatchObject({ previews: null, releaseApi: null })
  })

  it('reads previews of core with local defaults and pinned images', () => {
    const config = loadConfig(
      previewDev({
        PREVIEW_WEB_IMAGES: `8.3=registry.raditi.ru/preview-php${digest}`,
        PREVIEW_DB_IMAGE: `mariadb${digest}`,
        PREVIEW_TTL_HOURS: '24',
      }),
    )
    expect(config.core?.previews).toEqual({
      address: { baseDomain: 'localhost', scheme: 'http', publicPort: 8090 },
      ttlHours: 24,
      executor: 'local',
      runtime: 'runc',
      webImages: { '8.3': `registry.raditi.ru/preview-php${digest}` },
      images: { db: `mariadb${digest}`, cli: null, forwarder: null, browser: null, egress: null },
      upstreamHost: '127.0.0.1',
      gatewayPort: 8090,
      egressRefusedSubnets: [],
      docker: { socketPath: '/var/run/docker.sock', firewallImage: null },
    })
    expect(config.mcp?.previewUpstreamHost).toBe('127.0.0.1')
  })

  it("gives previews the platform's subnets the sandbox gateway refuses too (R10)", () => {
    // On runner VMs, as production runs turns: core's own sandbox gateway is not configured.
    expect(
      loadConfig(
        previewProd({ SANDBOX_EGRESS_REFUSED_SUBNETS: '84.201.128.0/18, 2a02:6b8:c00::/40' }),
      ).core?.previews?.egressRefusedSubnets,
    ).toEqual(['84.201.128.0/18', '2a02:6b8:c00::/40'])
    expect(loadConfig(previewProd()).core?.previews?.egressRefusedSubnets).toEqual([])
    expect(problemsOf(previewProd({ SANDBOX_EGRESS_REFUSED_SUBNETS: '84.201.128.0' }))[0]).toMatch(
      /^SANDBOX_EGRESS_REFUSED_SUBNETS\b.*CIDR/,
    )
  })

  it('gives core its Docker for local previews and none for runner VMs (R5c)', () => {
    const local = loadConfig(
      previewDev({ SANDBOX_DOCKER_SOCKET: '/run/docker.sock', PREVIEW_GATEWAY_PORT: '18090' }),
    )
    expect(local.core?.previews).toMatchObject({
      gatewayPort: 18090,
      docker: { socketPath: '/run/docker.sock', firewallImage: null },
    })
    expect(loadConfig(previewDev({ PREVIEW_EXECUTOR: 'runner' })).core?.previews?.docker).toBeNull()
  })

  it('refuses images without a digest and an upstream that is not an address', () => {
    expect(problemsOf(previewDev({ PREVIEW_CLI_IMAGE: 'wordpress:cli' }))[0]).toMatch(
      /^PREVIEW_CLI_IMAGE: /,
    )
    expect(problemsOf(previewDev({ PREVIEW_WEB_IMAGES: '8.3=php:8.3' }))).toEqual([
      'PREVIEW_WEB_IMAGES: the image of 8.3 must be pinned by digest',
    ])
    expect(problemsOf(previewDev({ PREVIEW_UPSTREAM_HOST: 'localhost' }))).toEqual([
      'PREVIEW_UPSTREAM_HOST: must be an IP address',
    ])
  })

  it('starts the gateway with its port, address, the dev secret and the database', () => {
    const config = loadConfig(previewDev())
    expect(config.preview).toEqual({
      appEnv: 'development',
      port: 8090,
      address: { baseDomain: 'localhost', scheme: 'http', publicPort: 8090 },
      sessionSecret: DEV_PREVIEW_SESSION_SECRET,
      appUrl: 'http://localhost:3000',
      db: { databaseUrl: 'postgresql://raditi:raditi@localhost:5432/raditi' },
      // This machine and Docker's bridges (preview-relays.ts).
      browserRelays: [
        { address: '127.0.0.1', prefix: 32, family: 'ipv4' },
        { address: '::1', prefix: 128, family: 'ipv6' },
        { address: '172.16.0.0', prefix: 12, family: 'ipv4' },
      ],
      host: '127.0.0.1',
    })
    expect(problemsOf(previewDev({ PREVIEW_BASE_DOMAIN: '' }))).toEqual([
      'PREVIEW_BASE_DOMAIN: required for the preview role',
    ])
    expect(problemsOf(previewDev({ PREVIEW_GATEWAY_PORT: '8082' }))).toEqual([
      'PREVIEW_GATEWAY_PORT: must differ from the other role ports',
    ])
    expect(problemsOf(previewDev({ PREVIEW_SESSION_SECRET: 'short' }))).toEqual([
      'PREVIEW_SESSION_SECRET: must be at least 32 bytes',
    ])
  })

  it('listens where PREVIEW_GATEWAY_HOST says: loopback in dev, every address in production', () => {
    // A Linux stand: the relay of the agent's browser reaches the host on the bridge's gateway.
    expect(loadConfig(previewDev({ PREVIEW_GATEWAY_HOST: '172.17.0.1' })).preview?.host).toBe(
      '172.17.0.1',
    )
    expect(loadConfig(gatewayProd()).preview?.host).toBeUndefined()
    expect(problemsOf(previewDev({ PREVIEW_GATEWAY_HOST: 'localhost' }))).toEqual([
      'PREVIEW_GATEWAY_HOST: must be an IP address',
    ])
  })

  it('opens the release API only where RELEASE_API_HOST says, with a default URL outside production', () => {
    expect(loadConfig(devEnv).core?.releaseApi).toBeNull()
    expect(loadConfig({ ...devEnv, RELEASE_API_HOST: '127.0.0.1' }).core?.releaseApi).toEqual({
      host: '127.0.0.1',
      port: 8085,
      publicUrl: 'http://127.0.0.1:8085',
      startTimeoutMinutes: 10,
    })
    expect(
      loadConfig({
        ...devEnv,
        RELEASE_API_HOST: '172.17.0.1',
        RELEASE_API_PUBLIC_URL: 'http://host.docker.internal:8085/',
      }).core?.releaseApi,
    ).toMatchObject({ host: '172.17.0.1', publicUrl: 'http://host.docker.internal:8085' })
    const local = { ...devEnv, RELEASE_API_HOST: '127.0.0.1' }
    expect(problemsOf({ ...local, RELEASE_API_PORT: '8081' })).toEqual([
      'RELEASE_API_PORT: must differ from the other ports of this process',
    ])
    expect(problemsOf({ ...local, RELEASE_API_PUBLIC_URL: 'http://x:8085/v1' })).toEqual([
      'RELEASE_API_PUBLIC_URL: expected an origin (no path, credentials or query)',
    ])
    expect(problemsOf({ ...devEnv, RELEASE_API_PUBLIC_URL: 'http://127.0.0.1:8085' })).toEqual([
      'RELEASE_API_HOST: required with RELEASE_API_PUBLIC_URL',
    ])
    expect(problemsOf({ ...devEnv, RELEASE_API_HOST: 'localhost' })).toEqual([
      'RELEASE_API_HOST: must be an IP address',
    ])
    // The port of the llm role is taken as well: bind would fail at start-up.
    expect(
      problemsOf({ ...local, ORCHESTRATOR_ROLES: 'core,llm', RELEASE_API_PORT: '8084' }),
    ).toEqual(['RELEASE_API_PORT: must differ from the other ports of this process'])
  })

  it('takes previews and the release API in production over https on private addresses', () => {
    const core = loadConfig(previewProd()).core
    expect(core?.previews).toMatchObject({
      address: { baseDomain: 'preview.raditi-sites.ru', scheme: 'https', publicPort: null },
      executor: 'runner',
      runtime: 'runsc',
    })
    expect(core?.releaseApi).toEqual({
      host: '10.20.0.4',
      port: 8085,
      publicUrl: 'http://10.20.0.4:8085',
      startTimeoutMinutes: 10,
    })
  })

  it('refuses in production http previews, the local executor, runc and a shared domain', () => {
    expect(problemsOf(previewProd({ PREVIEW_SCHEME: 'http' }))).toEqual([
      'PREVIEW_SCHEME: must be https in production',
    ])
    expect(problemsOf(previewProd({ PREVIEW_EXECUTOR: 'local' }))).toEqual([
      'PREVIEW_EXECUTOR: production runs previews only on runner VMs (runner)',
    ])
    expect(problemsOf(previewProd({ PREVIEW_RUNTIME: 'runc' }))).toEqual([
      'PREVIEW_RUNTIME: production previews run under gVisor (runsc)',
    ])
    expect(problemsOf(previewProd({ PREVIEW_BASE_DOMAIN: 'preview.raditi.ru' }))[0]).toMatch(
      /^PREVIEW_BASE_DOMAIN: must not share its registrable domain with APP_URL/,
    )
    expect(
      problemsOf(
        previewProd({
          PREVIEW_BASE_DOMAIN: 'preview.git-sites.ru',
          GITEA_URL: 'https://gitea.git-sites.ru',
          GITEA_TOKEN: 'token',
        }),
      )[0],
    ).toMatch(/GITEA_URL/)
    expect(problemsOf(previewProd({ PREVIEW_BASE_DOMAIN: 'localhost' }))[0]).toMatch(
      /^PREVIEW_BASE_DOMAIN: must be a name under a public suffix/,
    )
  })

  it('sends the content of a preview in production only to a private or loopback upstream', () => {
    expect(problemsOf(previewProd({ PREVIEW_UPSTREAM_HOST: '203.0.113.7' }))).toEqual([
      'PREVIEW_UPSTREAM_HOST: must be a private or loopback IP address in production (spec §19)',
    ])
    expect(
      loadConfig(previewProd({ PREVIEW_UPSTREAM_HOST: '10.20.0.9' })).core?.previews,
    ).toMatchObject({ upstreamHost: '10.20.0.9' })
    expect(loadConfig(previewProd()).core?.previews).toMatchObject({ upstreamHost: '127.0.0.1' })
    expect(
      problemsOf({ ...prodEnv(), ORCHESTRATOR_ROLES: 'mcp', PREVIEW_UPSTREAM_HOST: '8.8.8.8' }),
    ).toContain(
      'PREVIEW_UPSTREAM_HOST: must be a private or loopback IP address in production (spec §19)',
    )
    // Outside production any address literal is taken, as before.
    expect(loadConfig(previewDev({ PREVIEW_UPSTREAM_HOST: '203.0.113.7' })).mcp).toMatchObject({
      previewUpstreamHost: '203.0.113.7',
    })
  })

  it('keeps the release API in production on a private address with an explicit URL', () => {
    expect(problemsOf(previewProd({ RELEASE_API_HOST: '203.0.113.7' }))).toContain(
      'RELEASE_API_HOST: must be a private IP address in production (spec §19)',
    )
    expect(problemsOf(previewProd({ RELEASE_API_PUBLIC_URL: '' }))).toEqual([
      'RELEASE_API_PUBLIC_URL: required with RELEASE_API_HOST in production',
    ])
    expect(problemsOf(previewProd({ RELEASE_API_PUBLIC_URL: 'http://release.raditi.ru' }))).toEqual(
      ['RELEASE_API_PUBLIC_URL: plain http only to a private IP address in production (spec §19)'],
    )
    expect(problemsOf(previewProd({ RELEASE_API_HOST: '' }))).toEqual([
      'RELEASE_API_HOST: required with RELEASE_API_PUBLIC_URL',
    ])
  })

  it('starts the gateway alone in production with a secret of its own', () => {
    expect(loadConfig(gatewayProd()).preview).toMatchObject({
      appEnv: 'production',
      port: 8090,
      address: { scheme: 'https', baseDomain: 'preview.raditi-sites.ru' },
    })
    const problems = problemsOf(gatewayProd({ PREVIEW_SESSION_SECRET: '' }))
    expect(problems).toEqual(['PREVIEW_SESSION_SECRET: required in production'])
    const short = problemsOf(gatewayProd({ PREVIEW_SESSION_SECRET: 'tiny-secret' }))
    expect(short.join('\n')).not.toContain('tiny-secret')
    expect(problemsOf(gatewayProd({ PREVIEW_BASE_DOMAIN: 'app.raditi.ru' }))[0]).toMatch(/APP_URL/)
  })
})
