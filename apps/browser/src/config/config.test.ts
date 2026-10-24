import type { Env } from '@repo/domain'
import { describe, expect, it } from 'vitest'

import { ConfigError, loadBrowserConfig } from './config.ts'
import { TEST_WORKER_TOKEN, testEnv } from '../testing/fakes.ts'

const DIGEST = (name: string) => `registry.raditi.internal/${name}@sha256:${'b'.repeat(64)}`

const devEnv = (overrides: Env = {}): Env => ({ ...testEnv, APP_ENV: 'development', ...overrides })

const prodEnv = (overrides: Env = {}): Env => ({
  APP_ENV: 'production',
  DATABASE_URL: 'postgresql://raditi:secret@db.internal:5432/raditi',
  S3_ENDPOINT: 'https://storage.yandexcloud.net',
  S3_ACCESS_KEY_ID: 'key',
  S3_SECRET_ACCESS_KEY: 'secret',
  METRICS_TOKEN: 'm'.repeat(32),
  BROWSER_WORKER_TOKEN: 't'.repeat(48),
  BROWSER_RUNTIME: 'runsc',
  BROWSER_IMAGE: DIGEST('browser'),
  BROWSER_FORWARDER_IMAGE: DIGEST('tools'),
  BROWSER_EGRESS_IMAGE: DIGEST('egress'),
  SANDBOX_NETWORK_GUARD_IMAGE: DIGEST('guard'),
  SANDBOX_EGRESS_REFUSED_SUBNETS: '10.0.0.0/8,84.201.128.0/18',
  ...overrides,
})

function problemsOf(env: Env): readonly string[] {
  try {
    loadBrowserConfig(env)
  } catch (err) {
    if (err instanceof ConfigError) return err.problems
    throw err
  }
  throw new Error('expected a ConfigError')
}

describe('loadBrowserConfig', () => {
  it('starts on loopback with its token, the inbox bucket alone and the default numbers', () => {
    const config = loadBrowserConfig(devEnv())
    expect(config).toMatchObject({
      appEnv: 'development',
      host: '127.0.0.1',
      port: 8086,
      token: TEST_WORKER_TOKEN,
      extraHosts: [],
      localSites: [],
      session: { idleMinutes: 30, maxHours: 4, maxSessions: 8 },
      stream: { maxFps: 12, quality: 70, window: 2 },
      runtime: { appEnv: 'development', runtime: 'runc', refusedSubnets: [] },
    })
    // The worker's S3 key reads the inbox; no other bucket is its setting.
    expect(config.storage.buckets).toEqual({ inbox: 'raditi-inbox' })
  })

  it('requires a token by the rule of core, mcp and preview, and never repeats it', () => {
    expect(problemsOf(devEnv({ BROWSER_WORKER_TOKEN: '' }))).toEqual([
      'BROWSER_WORKER_TOKEN: required (the bearer token of core, mcp and the stream gateway)',
    ])
    const rule = 'BROWSER_WORKER_TOKEN: must be 32 to 4096 visible ASCII characters without spaces'
    // Short, with a space, not ASCII, or longer than the apps that send it take: refused here too.
    for (const bad of [
      'short-token',
      `${'x'.repeat(40)} y`,
      `${'x'.repeat(40)}é`,
      'x'.repeat(4097),
    ]) {
      const problems = problemsOf(devEnv({ BROWSER_WORKER_TOKEN: bad }))
      expect(problems).toEqual([rule])
      expect(problems.join('\n')).not.toContain(bad)
    }
    expect(
      loadBrowserConfig(devEnv({ BROWSER_WORKER_TOKEN: 'x'.repeat(4096) })).token,
    ).toHaveLength(4096)
  })

  it('starts without images outside production, every session then unavailable', () => {
    const none = { BROWSER_IMAGE: '', BROWSER_FORWARDER_IMAGE: '', BROWSER_EGRESS_IMAGE: '' }
    expect(loadBrowserConfig(devEnv(none)).runtime).toBeNull()
    expect(problemsOf(devEnv({ BROWSER_EGRESS_IMAGE: '' }))).toEqual([
      'BROWSER_IMAGE, BROWSER_FORWARDER_IMAGE, BROWSER_EGRESS_IMAGE: set all three or none',
    ])
    expect(problemsOf(devEnv({ BROWSER_IMAGE: 'raditi-preview-browser:local' }))[0]).toMatch(
      /^BROWSER_IMAGE: expected an image pinned by digest/,
    )
    expect(problemsOf(prodEnv(none))).toEqual([
      'BROWSER_IMAGE, BROWSER_FORWARDER_IMAGE, BROWSER_EGRESS_IMAGE: required in production',
    ])
  })

  it('runs production browsers under gVisor with the host firewall and the refused subnets', () => {
    const config = loadBrowserConfig(prodEnv())
    expect(config.host).toBeUndefined()
    expect(config.runtime).toMatchObject({
      // The sessions' egress proxies hear where they run: they refuse local sites in production.
      appEnv: 'production',
      runtime: 'runsc',
      firewallImage: DIGEST('guard'),
      refusedSubnets: ['10.0.0.0/8', '84.201.128.0/18'],
    })
    expect(config.runtime?.localSites).toBeUndefined()
    expect(problemsOf(prodEnv({ BROWSER_RUNTIME: 'runc' }))).toEqual([
      'BROWSER_RUNTIME: production browsers run under gVisor (runsc)',
    ])
    expect(problemsOf(prodEnv({ SANDBOX_EGRESS_REFUSED_SUBNETS: '' }))).toEqual([
      'SANDBOX_EGRESS_REFUSED_SUBNETS: required in production (the platform subnets the browser never reaches)',
    ])
    expect(problemsOf(prodEnv({ SANDBOX_NETWORK_GUARD_IMAGE: '' }))).toEqual([
      'SANDBOX_NETWORK_GUARD_IMAGE: required under runsc (the host firewall of a session network)',
    ])
    expect(problemsOf(prodEnv({ METRICS_TOKEN: '' }))[0]).toMatch(/^METRICS_TOKEN: /)
  })

  it('names local sites exactly outside production and refuses them in it', () => {
    const sites = JSON.stringify({ 'http://wp-stand.localhost:8080': 'host.docker.internal:8080' })
    const config = loadBrowserConfig(devEnv({ BROWSER_LOCAL_SITES: sites }))
    expect(config.localSites).toEqual([
      { origin: 'http://wp-stand.localhost:8080', target: 'host.docker.internal:8080' },
    ])
    // The runtime takes local sites only when the worker names some.
    expect(config.runtime?.localSites).toBe(true)
    expect(loadBrowserConfig(devEnv()).runtime?.localSites).toBeUndefined()
    expect(problemsOf(prodEnv({ BROWSER_LOCAL_SITES: sites }))).toEqual([
      'BROWSER_LOCAL_SITES: refused in production (local sites are for stands only)',
    ])
    // An address, https, a path or a value that is not host:port: never a local site.
    for (const bad of [
      { 'http://127.0.0.1:8080': 'host.docker.internal:8080' },
      { 'https://wp.localhost': 'host.docker.internal:443' },
      { 'http://wp.localhost/blog': 'host.docker.internal:80' },
      { 'http://wp.localhost': 'host.docker.internal' },
    ])
      expect(problemsOf(devEnv({ BROWSER_LOCAL_SITES: JSON.stringify(bad) }))[0]).toMatch(
        /^BROWSER_LOCAL_SITES: each key/,
      )
    expect(problemsOf(devEnv({ BROWSER_LOCAL_SITES: '[1]' }))).toEqual([
      'BROWSER_LOCAL_SITES: expected a JSON object of origins and host:port targets',
    ])
  })

  it('reads the extra hosts as the egress proxy spells them, public names only', () => {
    expect(
      loadBrowserConfig(devEnv({ BROWSER_EXTRA_HOSTS: 'S.W.org, fonts.example.ru:8443' }))
        .extraHosts,
    ).toEqual(['s.w.org:443', 'fonts.example.ru:8443'])
    expect(problemsOf(devEnv({ BROWSER_EXTRA_HOSTS: '10.0.0.5' }))).toEqual([
      'BROWSER_EXTRA_HOSTS: expected public host names with an optional port',
    ])
  })

  it('keeps the numbers of a session and its stream within their bounds', () => {
    const config = loadBrowserConfig(
      devEnv({
        BROWSER_SESSION_IDLE_MINUTES: '10',
        BROWSER_SESSION_MAX_HOURS: '2',
        BROWSER_MAX_SESSIONS: '3',
        BROWSER_STREAM_MAX_FPS: '20',
        BROWSER_STREAM_QUALITY: '50',
        BROWSER_STREAM_WINDOW: '3',
        BROWSER_WORKER_PORT: '9086',
        BROWSER_WORKER_HOST: '10.0.0.7',
      }),
    )
    expect(config).toMatchObject({
      host: '10.0.0.7',
      port: 9086,
      session: { idleMinutes: 10, maxHours: 2, maxSessions: 3 },
      stream: { maxFps: 20, quality: 50, window: 3 },
    })
    for (const name of [
      'BROWSER_SESSION_IDLE_MINUTES',
      'BROWSER_SESSION_MAX_HOURS',
      'BROWSER_MAX_SESSIONS',
      'BROWSER_STREAM_MAX_FPS',
      'BROWSER_STREAM_QUALITY',
      'BROWSER_STREAM_WINDOW',
    ])
      expect(problemsOf(devEnv({ [name]: '1000' }))[0]).toMatch(new RegExp(`^${name}: `))
    expect(problemsOf(devEnv({ BROWSER_WORKER_HOST: 'localhost' }))).toEqual([
      'BROWSER_WORKER_HOST: must be an IP address',
    ])
    expect(problemsOf(devEnv({ BROWSER_DOCKER_SOCKET: 'tcp://docker:2375' }))).toEqual([
      'BROWSER_DOCKER_SOCKET: must be an absolute Unix socket path',
    ])
  })
})
