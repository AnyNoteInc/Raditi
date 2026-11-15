import { readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'

import type { Env } from '@repo/domain'
import { describe, expect, it } from 'vitest'

import { ConfigError, loadMcpConfig } from './config.ts'
import { mcpHeadersAllowed } from '../access/mcp-policy.ts'

/** .env.example exactly as `cp .env.example .env` gives it to a new developer. */
const exampleEnv: Env = parseEnv(
  readFileSync(new URL('../../../../.env.example', import.meta.url), 'utf8'),
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
  SANDBOX_EGRESS_REFUSED_SUBNETS: '45.8.250.117/32,10.10.0.0/24',
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
    expect(config).toMatchObject({ appEnv: 'development', port: 8082 })
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

describe('the browser worker of the mcp role (plan 57, Б20)', () => {
  const token = 'w'.repeat(48)
  const worker = { BROWSER_WORKER_URL: 'http://127.0.0.1:8086', BROWSER_WORKER_TOKEN: token }

  it('has none by default, the .env.example setup included', () => {
    expect(loadMcpConfig(devEnv).browserWorker).toBeNull()
    expect(loadMcpConfig(exampleEnv).browserWorker).toBeNull()
    expect(
      loadMcpConfig({ ...devEnv, BROWSER_WORKER_URL: '', BROWSER_WORKER_TOKEN: '' }).browserWorker,
    ).toBeNull()
  })

  it('opens a session with the deadline of the worker’s own setting (plan 61, К11)', () => {
    expect(
      loadMcpConfig({ ...devEnv, ...worker, BROWSER_SESSION_MAX_HOURS: '8' }).browserWorker,
    ).toMatchObject({ sessionMaxHours: 8 })
    expect(problemsOf({ ...devEnv, ...worker, BROWSER_SESSION_MAX_HOURS: '25' })).toEqual([
      expect.stringMatching(/^BROWSER_SESSION_MAX_HOURS: /),
    ])
    expect(problemsOf({ ...devEnv, ...worker, BROWSER_SESSION_MAX_HOURS: '0' })).toEqual([
      expect.stringMatching(/^BROWSER_SESSION_MAX_HOURS: /),
    ])
  })

  it('reads the worker and its token together, outside production and in it', () => {
    expect(loadMcpConfig({ ...devEnv, ...worker }).browserWorker).toEqual({
      url: 'http://127.0.0.1:8086',
      token,
      sessionMaxHours: 4,
    })
    // A product path, not a profile: production takes it, without any S3 setting.
    expect(
      loadMcpConfig(
        prodEnv({ BROWSER_WORKER_URL: 'http://10.0.0.7:8086/', BROWSER_WORKER_TOKEN: token }),
      ),
    ).toMatchObject({ browserWorker: { url: 'http://10.0.0.7:8086', token } })
    expect(
      loadMcpConfig(
        prodEnv({
          BROWSER_WORKER_URL: 'https://browser.raditi.internal',
          BROWSER_WORKER_TOKEN: token,
        }),
      ).browserWorker,
    ).toEqual({ url: 'https://browser.raditi.internal', token, sessionMaxHours: 4 })
    expect(problemsOf({ ...devEnv, BROWSER_WORKER_URL: worker.BROWSER_WORKER_URL })).toEqual([
      'BROWSER_WORKER_TOKEN: required with BROWSER_WORKER_URL',
    ])
    // The token alone is the worker's in the shared .env: mcp has no worker then.
    expect(loadMcpConfig(prodEnv({ BROWSER_WORKER_TOKEN: token })).browserWorker).toBeNull()
  })

  it('sends the token over plain http in production only to a private or loopback address', () => {
    for (const url of ['http://browser:8086', 'http://203.0.113.7:8086'])
      expect(problemsOf(prodEnv({ BROWSER_WORKER_URL: url, BROWSER_WORKER_TOKEN: token }))).toEqual(
        [
          'BROWSER_WORKER_URL: plain http only to a private or loopback IP address in production (spec §19)',
        ],
      )
    expect(
      loadMcpConfig({
        ...devEnv,
        BROWSER_WORKER_URL: 'http://browser:8086',
        BROWSER_WORKER_TOKEN: token,
      }).browserWorker,
    ).toEqual({ url: 'http://browser:8086', token, sessionMaxHours: 4 })
  })

  it('refuses an address that is not an origin and a weak token, never printing either', () => {
    for (const url of [
      'ftp://127.0.0.1:8086',
      'http://user:pass@127.0.0.1:8086',
      'http://127.0.0.1:8086/v1',
      'http://127.0.0.1:8086?x=1',
      'not a url',
    ]) {
      const problems = problemsOf({ ...devEnv, ...worker, BROWSER_WORKER_URL: url })
      expect(problems).toEqual([
        'BROWSER_WORKER_URL: must be an http(s) origin without credentials or a path',
      ])
      expect(problems.join('\n')).not.toContain('127.0.0.1')
    }
    for (const weak of [
      'short',
      `${'w'.repeat(40)} space`,
      `${'w'.repeat(40)}\u00e9`,
      'w'.repeat(4097),
    ]) {
      const problems = problemsOf({ ...devEnv, ...worker, BROWSER_WORKER_TOKEN: weak })
      expect(problems).toEqual([
        'BROWSER_WORKER_TOKEN: must be 32 to 4096 visible ASCII characters without spaces',
      ])
      expect(problems.join('\n')).not.toContain(weak)
    }
  })
})

describe('loadMcpConfig — production', () => {
  it('does not ask the MCP gateway for a metrics token: it serves no /metrics', () => {
    expect(loadMcpConfig(prodEnv({ METRICS_TOKEN: '' })).port).toBe(8082)
  })

  it('reads none of the settings of the removed preview and content profiles (plan 83)', () => {
    const config = loadMcpConfig(
      prodEnv({
        MCP_CONTENT_PROFILE: 'local',
        MCP_BROWSER_PROFILE: 'local',
        SINGLE_SERVER: 'yes',
        PREVIEW_UPSTREAM_HOST: '8.8.8.8',
        PREVIEW_BASE_DOMAIN: 'raditi-platform.example',
        S3_ENDPOINT: 'not a url',
      }),
    )
    expect(config).not.toHaveProperty('contentProfile')
    expect(config).not.toHaveProperty('storage')
    expect(config).not.toHaveProperty('preview')
  })

  it('requires the exact upstream Host names in production', () => {
    expect(problemsOf(prodEnv({ MCP_ALLOWED_HOSTS: undefined })).join('\n')).toMatch(
      /MCP_ALLOWED_HOSTS|allowed/i,
    )
  })
})

describe('the pages of the mcp role (plan 69)', () => {
  it('gives the agent no pages without PAGES_BASE_DOMAIN, and the address with it', () => {
    expect(loadMcpConfig(devEnv).pages).toBeNull()
    expect(
      loadMcpConfig({ ...devEnv, PAGES_BASE_DOMAIN: 'pages.localhost', PAGES_PUBLIC_PORT: '8092' })
        .pages,
    ).toEqual({ baseDomain: 'pages.localhost', scheme: 'http', port: 8092 })
    expect(loadMcpConfig(prodEnv({ PAGES_BASE_DOMAIN: 'pages.raditi.ru' })).pages).toEqual({
      baseDomain: 'pages.raditi.ru',
      scheme: 'https',
    })
    expect(
      problemsOf(prodEnv({ PAGES_BASE_DOMAIN: 'pages.raditi.ru', PAGES_PUBLIC_PORT: '443' })),
    ).toContain('PAGES_PUBLIC_PORT: not in production (a page host carries no port there)')
  })
})

describe('the web search of the mcp role', () => {
  const pilot = { timeoutMs: 10_000, limits: { turn: 3, serviceMonth: 5000 } }

  it('has the pilot limits by default and in .env.example, in production too, and no key', () => {
    expect(loadMcpConfig(devEnv).webSearch).toEqual(pilot)
    expect(loadMcpConfig(exampleEnv).webSearch).toEqual(pilot)
    expect(loadMcpConfig(prodEnv()).webSearch).toEqual(pilot)
    // The key lives in Vault where the keys of the model are: YANDEX_SEARCH_API_KEY is the input of the
    // operator command alone, and the role reads nothing of it.
    const withKey = loadMcpConfig({
      ...devEnv,
      YANDEX_SEARCH_API_KEY: 'synthetic-yandex-key-0123456789',
    })
    expect(JSON.stringify(withKey)).not.toContain('synthetic-yandex-key')
    expect(Object.keys(exampleEnv)).not.toContain('WEB_SEARCH_WORKSPACE_MONTH_LIMIT')
  })

  it('takes its limits and timeout from the environment', () => {
    expect(
      loadMcpConfig({
        ...devEnv,
        WEB_SEARCH_TIMEOUT_SECONDS: '5',
        WEB_SEARCH_TURN_LIMIT: '0',
        WEB_SEARCH_SERVICE_MONTH_LIMIT: '100',
      }).webSearch,
    ).toEqual({ timeoutMs: 5000, limits: { turn: 0, serviceMonth: 100 } })
  })

  it('refuses a malformed limit or timeout', () => {
    const problems = problemsOf({
      ...devEnv,
      WEB_SEARCH_TURN_LIMIT: '-1',
      WEB_SEARCH_TIMEOUT_SECONDS: '60',
    }).join('\n')
    expect(problems).toMatch(/WEB_SEARCH_TURN_LIMIT/)
    expect(problems).toMatch(/WEB_SEARCH_TIMEOUT_SECONDS/)
  })

  it('needs the platform subnets in production and keeps a loopback relay out of it (plan 81)', () => {
    expect(problemsOf(prodEnv({ SANDBOX_EGRESS_REFUSED_SUBNETS: '' }))).toContain(
      'SANDBOX_EGRESS_REFUSED_SUBNETS: required in production (the platform subnets the relay of MCP servers never reaches)',
    )
    expect(problemsOf(prodEnv({ MCP_SKILL_RELAY_LOOPBACK: 'on' }))).toContain(
      'MCP_SKILL_RELAY_LOOPBACK: only off is allowed in production',
    )
    expect(loadMcpConfig(prodEnv()).skillRelay).toEqual({
      refusedSubnets: [
        { address: '45.8.250.117', prefix: 32, family: 4 },
        { address: '10.10.0.0', prefix: 24, family: 4 },
      ],
      allowLoopback: false,
    })
  })

  it('takes the hosts of a stand only outside production and with loopback on', () => {
    const hosts = JSON.stringify({ 'mcp.relay-stand.example': '127.0.0.1:45123' })
    expect(
      loadMcpConfig({ ...devEnv, MCP_SKILL_RELAY_LOOPBACK: 'on', MCP_SKILL_RELAY_HOSTS: hosts })
        .skillRelay?.hosts,
    ).toEqual({ 'mcp.relay-stand.example': { address: '127.0.0.1', port: 45123 } })
    expect(problemsOf({ ...devEnv, MCP_SKILL_RELAY_HOSTS: hosts })).toContain(
      'MCP_SKILL_RELAY_HOSTS: only outside production, with MCP_SKILL_RELAY_LOOPBACK=on',
    )
    expect(problemsOf(prodEnv({ MCP_SKILL_RELAY_HOSTS: hosts }))).toContain(
      'MCP_SKILL_RELAY_HOSTS: only outside production, with MCP_SKILL_RELAY_LOOPBACK=on',
    )
    expect(
      problemsOf({
        ...devEnv,
        MCP_SKILL_RELAY_LOOPBACK: 'on',
        MCP_SKILL_RELAY_HOSTS: '{"x.example":"10.0.0.1:1"}',
      })[0],
    ).toMatch(/MCP_SKILL_RELAY_HOSTS/)
  })
})
