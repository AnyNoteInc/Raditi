import { readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'

import type { Env } from '@repo/domain'
import { describe, expect, it } from 'vitest'

import { ConfigError, loadMcpConfig } from './config.ts'
import { mcpHeadersAllowed } from './mcp-policy.ts'

/** .env.example exactly as `cp .env.example .env` gives it to a new developer. */
const exampleEnv: Env = parseEnv(
  readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8'),
)

/** The local setup of .env.example (the part the mcp role reads). */
const devEnv: Env = {
  APP_ENV: 'development',
  DATABASE_URL: 'postgresql://raditi:raditi@localhost:5432/raditi',
  S3_ENDPOINT: 'http://localhost:8333',
  S3_REGION: 'ru-central1',
  S3_ACCESS_KEY_ID: 'raditi',
  S3_SECRET_ACCESS_KEY: 'raditi-dev-secret',
  S3_FORCE_PATH_STYLE: 'true',
  VAULT_ADDR: 'http://localhost:8200',
  VAULT_DEV_ROOT_TOKEN: 'raditi-dev-root',
}

/** The MCP gateway as infra/app would run it: its own AppRole, no S3, no metrics token. */
const prodEnv = (overrides: Env = {}): Env => ({
  APP_ENV: 'production',
  DATABASE_URL: 'postgresql://mcp:secret@db.internal:5432/raditi',
  VAULT_ADDR: 'https://vault.internal:8200',
  VAULT_ROLE_ID: 'mcp-role',
  VAULT_SECRET_ID: 'mcp-secret',
  MCP_ALLOWED_HOSTS: 'mcp',
  ...overrides,
})

function problemsOf(env: Env): readonly string[] {
  try {
    loadMcpConfig(env)
  } catch (err) {
    if (err instanceof ConfigError) return err.problems
    throw err
  }
  throw new Error('expected a ConfigError')
}

describe('loadMcpConfig — defaults', () => {
  it('reads the .env.example setup: the port, the allowed hosts and the Docker Desktop names', () => {
    const config = loadMcpConfig(exampleEnv)
    expect(config).toMatchObject({
      appEnv: 'development',
      port: 8082,
      previewUpstreamHost: '127.0.0.1',
    })
    // sandbox-gw sends its upstream's Host: SANDBOX_MCP_UPSTREAM=http://host.docker.internal:8082.
    expect(
      mcpHeadersAllowed(
        { host: 'host.docker.internal:8082' },
        { allowedHosts: config.allowedHosts, allowLocalOrigin: true },
      ),
    ).toBe(true)
  })

  it('rejects a bad port', () => {
    expect(problemsOf({ ...devEnv, MCP_PORT: '70000' })[0]).toMatch(/^MCP_PORT/)
  })

  it('requires APP_ENV: a missing or misspelt one never falls back to development', () => {
    const refused = 'APP_ENV: must be one of development, test, production'
    expect(problemsOf({ ...devEnv, APP_ENV: undefined })).toEqual([refused])
    expect(problemsOf({ ...devEnv, APP_ENV: 'prod' })).toEqual([refused])
  })

  it('reads none of the settings of the other roles', () => {
    expect(
      loadMcpConfig({
        ...devEnv,
        CORE_PORT: 'unused',
        REDIS_URL: 'not a url',
        YOOKASSA_SHOP_ID: 'not digits',
        APP_URL: 'not a url',
        GITEA_URL: 'not a url',
      }),
    ).toMatchObject({ port: 8082 })
  })
})

describe('the content profile of the mcp role', () => {
  const mcpEnv = (overrides: Env = {}): Env => ({
    APP_ENV: 'development',
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
      expect(loadMcpConfig(mcpEnv({ MCP_CONTENT_PROFILE: value }))).toMatchObject({
        contentProfile: 'off',
        storage: null,
      })
    // Off, the S3 settings of the shared .env are not even read.
    expect(
      loadMcpConfig(mcpEnv({ MCP_CONTENT_PROFILE: 'off', S3_ENDPOINT: 'not a url' })).storage,
    ).toBeNull()
  })

  it('reads the S3 connection and the artifacts bucket alone for the local profile', () => {
    const config = loadMcpConfig(
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
    expect(config).toMatchObject({ contentProfile: 'local' })
    expect(config.storage).toEqual({
      endpoint: 'http://localhost:8333',
      region: 'ru-central1',
      accessKeyId: 'raditi',
      secretAccessKey: 'raditi-dev-secret',
      forcePathStyle: true,
      buckets: { artifacts: 'raditi-test-artifacts' },
    })
    expect(
      loadMcpConfig(mcpEnv({ ...s3, MCP_CONTENT_PROFILE: 'local-site' })).storage?.buckets,
    ).toEqual({ artifacts: 'raditi-artifacts' })
  })

  it('says where the content goes: into previews, or the site on the stands without them', () => {
    const previews = { PREVIEW_BASE_DOMAIN: 'localhost', PREVIEW_PUBLIC_PORT: '8090' }
    expect(
      loadMcpConfig(mcpEnv({ ...s3, ...previews, MCP_CONTENT_PROFILE: 'local' })),
    ).toMatchObject({ contentProfile: 'local', preview: { baseDomain: 'localhost' } })
    expect(loadMcpConfig(mcpEnv({ ...s3, MCP_CONTENT_PROFILE: 'local-site' }))).toMatchObject({
      contentProfile: 'local-site',
      preview: null,
    })
    // Without previews `local` has nowhere to write; beside them the site path is refused —
    // nothing turns the agent back onto the site by an empty variable (Р3).
    expect(problemsOf(mcpEnv({ ...s3, MCP_CONTENT_PROFILE: 'local' }))).toEqual([
      'MCP_CONTENT_PROFILE: local writes into previews and needs PREVIEW_BASE_DOMAIN',
    ])
    expect(problemsOf(mcpEnv({ ...s3, ...previews, MCP_CONTENT_PROFILE: 'local-site' }))).toEqual([
      'MCP_CONTENT_PROFILE: local-site writes the connected site itself and is refused where previews are configured (PREVIEW_BASE_DOMAIN)',
    ])
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

  it('has a browser profile of its own that needs the same S3 settings (plan 53, Р21)', () => {
    expect(loadMcpConfig(mcpEnv())).toMatchObject({ browserProfile: 'off', storage: null })
    const config = loadMcpConfig(
      mcpEnv({
        ...s3,
        MCP_BROWSER_PROFILE: 'local',
        PREVIEW_BASE_DOMAIN: 'localhost',
        PREVIEW_PUBLIC_PORT: '8090',
      }),
    )
    expect(config).toMatchObject({
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

  it('reads the dev setup of .env.example: the shared S3 settings, the artifacts bucket alone', () => {
    const config = loadMcpConfig({ ...devEnv, MCP_CONTENT_PROFILE: 'local-site' })
    expect(config.storage).toEqual({
      endpoint: 'http://localhost:8333',
      region: 'ru-central1',
      accessKeyId: 'raditi',
      secretAccessKey: 'raditi-dev-secret',
      forcePathStyle: true,
      buckets: { artifacts: 'raditi-artifacts' },
    })
  })
})

describe('loadMcpConfig — production', () => {
  it('does not ask the MCP gateway for a metrics token: it serves no /metrics', () => {
    expect(loadMcpConfig(prodEnv({ METRICS_TOKEN: '' })).port).toBe(8082)
  })

  it('refuses every content profile but off in production', () => {
    for (const value of [undefined, '', 'off'])
      expect(loadMcpConfig(prodEnv({ MCP_CONTENT_PROFILE: value }))).toMatchObject({
        contentProfile: 'off',
        storage: null,
      })
    // With every S3 setting in place: the refusal is the profile itself, not a missing value.
    const s3 = {
      S3_ENDPOINT: 'https://storage.yandexcloud.net',
      S3_ACCESS_KEY_ID: 'key-id',
      S3_SECRET_ACCESS_KEY: 'very-secret-s3-key',
    }
    for (const value of ['local', 'local-site'])
      expect(problemsOf(prodEnv({ ...s3, MCP_CONTENT_PROFILE: value }))).toEqual([
        'MCP_CONTENT_PROFILE: only off is allowed in production (published content is not open there)',
      ])
    expect(
      problemsOf(prodEnv({ MCP_CONTENT_PROFILE: 'local', S3_ENDPOINT: '', S3_ACCESS_KEY_ID: '' })),
    ).toEqual([
      'MCP_CONTENT_PROFILE: only off is allowed in production (published content is not open there)',
    ])
    // The agent's browser on a preview (plan 53, Р21) is not open there either.
    expect(loadMcpConfig(prodEnv({ MCP_BROWSER_PROFILE: 'off' }))).toMatchObject({
      browserProfile: 'off',
      storage: null,
    })
    expect(problemsOf(prodEnv({ MCP_BROWSER_PROFILE: 'local' }))).toEqual([
      'MCP_BROWSER_PROFILE: only off is allowed in production (the agent browser is not open there)',
    ])
  })

  it('sends the content of a preview in production only to a private or loopback upstream', () => {
    expect(problemsOf(prodEnv({ PREVIEW_UPSTREAM_HOST: '8.8.8.8' }))).toContain(
      'PREVIEW_UPSTREAM_HOST: must be a private or loopback IP address in production (spec §19)',
    )
    expect(loadMcpConfig(prodEnv({ PREVIEW_UPSTREAM_HOST: '10.20.0.9' }))).toMatchObject({
      previewUpstreamHost: '10.20.0.9',
    })
    // Outside production any address literal is taken, as before.
    expect(loadMcpConfig({ ...devEnv, PREVIEW_UPSTREAM_HOST: '203.0.113.7' })).toMatchObject({
      previewUpstreamHost: '203.0.113.7',
    })
  })

  it('requires the exact upstream Host names in production', () => {
    expect(problemsOf(prodEnv({ MCP_ALLOWED_HOSTS: undefined })).join('\n')).toMatch(
      /MCP_ALLOWED_HOSTS|allowed/i,
    )
  })
})
