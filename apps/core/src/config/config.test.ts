import { readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'

import type { Env } from '@repo/domain'
import { DEV_METRICS_TOKEN } from '@repo/observability'
import { describe, expect, it } from 'vitest'

import { ConfigError, loadConfig } from './config.ts'
import { runnerCredentialAddress } from './runner-tokens.ts'

/** .env.example exactly as `cp .env.example .env` gives it to a new developer. */
const exampleEnv: Env = parseEnv(
  readFileSync(new URL('../../../../.env.example', import.meta.url), 'utf8'),
)

/** The local setup of .env.example. */
const devEnv: Env = {
  APP_ENV: 'development',
  APP_URL: 'http://localhost:3000',
  CORE_PORT: '8081',
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
    expect(loadConfig(devEnv)).toMatchObject({
      llmControlUrl: 'http://127.0.0.1:8084',
      minTurnHeadroomPct: 5,
    })
    expect(
      loadConfig({
        ...devEnv,
        LLM_CONTROL_URL: 'http://localhost:9876',
        LLM_POOL_MIN_TURN_HEADROOM_PCT: '7.5',
      }),
    ).toMatchObject({ llmControlUrl: 'http://127.0.0.1:9876', minTurnHeadroomPct: 7.5 })
  })

  it('reads the .env.example setup: core on its port', () => {
    const config = loadConfig(devEnv)

    expect(config.appEnv).toBe('development')
    expect(config).toMatchObject({
      port: 8081,
      redisUrl: 'redis://localhost:6379',
      metricsToken: DEV_METRICS_TOKEN,
      db: { databaseUrl: 'postgresql://raditi:raditi@localhost:5432/raditi' },
      vault: { addr: 'http://localhost:8200', token: 'raditi-dev-root' },
      sandbox: { runtime: 'runc' },
      agentDrivers: { image: `raditi/sbx-wordpress@sha256:${'a'.repeat(64)}` },
      mailer: { sendsayApiKey: undefined },
    })
    expect(config.storage.buckets.artifacts).toBe('raditi-artifacts')
  })

  it('defaults to core and the dev metrics token', () => {
    const config = loadConfig({
      ...devEnv,
      CORE_PORT: '',
      METRICS_TOKEN: '',
    })

    expect(config.port).toBe(8081)
    expect(config.metricsToken).toBe(DEV_METRICS_TOKEN)
  })

  it('requires APP_ENV: a missing or misspelt one never falls back to development', () => {
    const refused = 'APP_ENV: must be one of development, test, production'
    expect(problemsOf({ ...devEnv, APP_ENV: undefined })).toEqual([refused])
    expect(problemsOf({ ...devEnv, APP_ENV: ' ' })).toEqual([refused])
    expect(problemsOf({ ...devEnv, APP_ENV: 'prod' })).toEqual([refused])
    expect(problemsOf({ APP_ENV: undefined })).toEqual([refused])
  })

  it('still rejects invalid settings when their role or the runner API is active', () => {
    expect(
      problemsOf({ ...devEnv, TURN_EXECUTOR: 'runner', RUNNER_API_PORT: 'unused' })[0],
    ).toMatch(/^RUNNER_API_PORT:/)
  })

  it('drives Docker from core only with the local executor', () => {
    expect(loadConfig(devEnv).sandbox).toEqual({
      runtime: 'runc',
      socketPath: '/var/run/docker.sock',
    })
    const runner = loadConfig({
      ...devEnv,
      TURN_EXECUTOR: 'runner',
      RUNNER_TOKENS: `sandbox-1:${RUNNER_HASH}@127.0.0.1`,
      SANDBOX_RUNTIME: 'kata',
    })
    expect(runner.sandbox).toBeNull()
  })

  it('runs turns in core by default and on runners with their token hashes', () => {
    expect(loadConfig(devEnv)).toMatchObject({ turnExecutor: 'local', runnerApi: null })
    const runner = loadConfig({
      ...devEnv,
      TURN_EXECUTOR: 'runner',
      RUNNER_TOKENS: ` sandbox-1:${RUNNER_HASH}@127.0.0.1, sandbox-1:${'B'.repeat(64)}@127.0.0.1,sandbox-2:${'c'.repeat(64)}@[::1] `,
    })
    expect(runner.turnExecutor).toBe('runner')
    expect(runner.runnerApi?.port).toBe(8083)
    expect([...runner!.runnerApi!.tokens.keys()]).toEqual(['sandbox-1', 'sandbox-2'])
    expect(
      runner!.runnerApi!.tokens.get('sandbox-1')!.map((hash) => hash.digest.toString('hex')),
    ).toEqual([RUNNER_HASH, 'b'.repeat(64)])
  })

  it('binds every runner to one address at start: its turn keys are issued for it', () => {
    const runner = { ...devEnv, TURN_EXECUTOR: 'runner' }
    // Outside production a runner on this machine reaches core from loopback.
    const tokens = loadConfig({ ...runner, RUNNER_TOKENS: `sandbox-1:${RUNNER_HASH}@127.0.0.1` })
      .runnerApi!.tokens
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
    expect(loadConfig({ ...devEnv, RUNNER_TOKENS: `sandbox-1:${RUNNER_HASH}` }).runnerApi).toBe(
      null,
    )
  })

  it('refuses runner settings it cannot serve, naming entries and never their values', () => {
    const runner = { ...devEnv, TURN_EXECUTOR: 'runner' }
    expect(problemsOf(runner)).toEqual([
      'RUNNER_TOKENS: at least one runner token hash is required (id:sha256@ip)',
    ])
    const leaked = 'rnr_sandbox-1.' + 'x'.repeat(43)
    const problems = problemsOf({
      ...runner,
      RUNNER_API_PORT: '8081',
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
      'RUNNER_API_PORT: must differ from CORE_PORT',
      'RUNNER_TOKENS: entry 1 must be <runner id>:<sha256 hex>[@<IP address>]',
      'RUNNER_TOKENS: entry 3 repeats a hash of runner sandbox-1',
      'RUNNER_TOKENS: runner sandbox-1 has more than 2 token hashes',
      'RUNNER_TOKENS: entry 6 must be <runner id>:<sha256 hex>[@<IP address>]',
    ])
    expect(problems.join('\n')).not.toContain(leaked)
    expect(problemsOf({ ...runner, TURN_EXECUTOR: 'docker' })[0]).toMatch(/^TURN_EXECUTOR/)
  })

  it('rejects a bad port', () => {
    expect(problemsOf({ ...devEnv, CORE_PORT: 'http' })[0]).toMatch(/^CORE_PORT/)
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
      turnExecutor: 'local',
      agentDrivers: { image: exampleEnv.SANDBOX_IMAGE },
      previews: {
        address: { baseDomain: 'localhost', scheme: 'http', publicPort: 8090 },
        executor: 'local',
        runtime: 'runc',
        upstreamHost: '127.0.0.1',
      },
      releaseApi: { host: '127.0.0.1', port: 8085, startTimeoutMinutes: 10 },
    })
    // apps/e2e/playwright.config.ts on top of the same file.
    const e2e = loadConfig({
      ...exampleEnv,
      APP_ENV: 'test',
      CORE_PORT: '8181',
      TURN_EXECUTOR: 'local',
    })
    expect(e2e).toMatchObject({ port: 8181 })
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
      expect(loadConfig(env).agentDrivers).toEqual({ image: placeholder })
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
      expect(loadConfig(gitEnv()).git).toEqual({
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
        ).git,
      ).toEqual({
        kind: 'gitea',
        baseUrl: 'https://host.raditi.test/gitea',
        token: 'synthetic-bot-token',
        caFile: '/run/raditi/gitea-ca.pem',
      })
    })

    it('takes the directory of the repository mirrors when it is set (plan 53, Р10)', () => {
      expect(loadConfig(gitEnv({ GIT_MIRROR_DIR: '/work/mirrors' })).git).toMatchObject({
        mirrorDir: '/work/mirrors',
      })
      expect(loadConfig(gitEnv({ GIT_MIRROR_DIR: '' })).git).not.toHaveProperty('mirrorDir')
    })

    it('leaves git unconfigured, and core starting, with the plain-http Gitea of .env.example', () => {
      expect(exampleEnv.GITEA_URL).toBe('http://localhost:3300')
      expect(loadConfig(exampleEnv).git).toBeNull()
      // A token does not make plain http a git transport (spec §19).
      expect(loadConfig(gitEnv({ GITEA_URL: 'http://localhost:3300' })).git).toBeNull()
      expect(loadConfig(devEnv).git).toBeNull()
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

    const creatorToken = 'synthetic-provisioner-token'

    it('leaves the token that creates site repositories null until it is set', () => {
      expect(exampleEnv.GITEA_PROVISIONER_TOKEN).toBe('')
      expect(loadConfig(exampleEnv).siteRepositoryProvisionerToken).toBeNull()
      expect(loadConfig(devEnv).siteRepositoryProvisionerToken).toBeNull()
      // The bot's token never stands in for it.
      expect(loadConfig(gitEnv()).siteRepositoryProvisionerToken).toBeNull()
      expect(
        loadConfig(gitEnv({ GITEA_PROVISIONER_TOKEN: ' ' })).siteRepositoryProvisionerToken,
      ).toBeNull()
    })

    it('takes the creator token beside git with an https Gitea, and git stays as it was', () => {
      const core = loadConfig(gitEnv({ GITEA_PROVISIONER_TOKEN: creatorToken }))
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
        ).siteRepositoryProvisionerToken,
      ).toBe(creatorToken)
    })

    it('has no creator token where git is not configured: there is no Gitea to create in', () => {
      for (const env of [
        gitEnv({ GITEA_URL: 'http://localhost:3300', GITEA_PROVISIONER_TOKEN: creatorToken }),
        { ...devEnv, GITEA_PROVISIONER_TOKEN: creatorToken },
        prodEnv({ GITEA_PROVISIONER_TOKEN: creatorToken }),
      ]) {
        const core = loadConfig(env)
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
  })

  describe('the ЮKassa shop for renewal charges', () => {
    const shop = { YOOKASSA_SHOP_ID: '123456', YOOKASSA_SECRET_KEY: 'test_shop-secret-key' }

    it('leaves payments off, and core starting, without the shop credentials', () => {
      expect(exampleEnv.YOOKASSA_SHOP_ID).toBe('')
      expect(exampleEnv.YOOKASSA_SECRET_KEY).toBe('')
      expect(exampleEnv.YOOKASSA_API_URL).toBe('')
      expect(exampleEnv.YOOKASSA_WEBHOOK_ALLOWLIST).toBe('')
      expect(exampleEnv.YOOKASSA_AUTOPAYMENTS).toBe('')
      expect(loadConfig(exampleEnv).yookassa).toBeNull()
      expect(loadConfig(devEnv).yookassa).toBeNull()
    })

    it('reads the shop, the address of a local fake and its notification senders', () => {
      expect(loadConfig({ ...devEnv, ...shop }).yookassa).toEqual({
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
        }).yookassa,
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
        expect(loadConfig({ ...devEnv, ...shop, YOOKASSA_AUTOPAYMENTS }).yookassa).toMatchObject({
          autopayments,
        })
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
      expect(loadConfig(exampleEnv).billing).toEqual(billing)
      // The same without the three variables, and with blank ones.
      expect(loadConfig(devEnv).billing).toEqual(billing)
      expect(
        loadConfig({
          ...devEnv,
          BILLING_RENEWAL_NOTICE_DAYS: '',
          BILLING_PAST_DUE_DAYS: ' ',
          BILLING_TICK_SECONDS: '',
        }).billing,
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
        }).billing,
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
  })
})

describe('loadConfig — production', () => {
  it('leaves the control endpoint absent until an operator configures its private origin', () => {
    expect(loadConfig(prodEnv()).llmControlUrl).toBeUndefined()
    expect(loadConfig(prodEnv({ LLM_CONTROL_URL: 'http://10.20.0.4:8084' })).llmControlUrl).toBe(
      'http://10.20.0.4:8084',
    )
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

    expect(config).toMatchObject({
      appEnv: 'production',
      metricsToken: PROD_METRICS_TOKEN,
      vault: { appRole: { roleId: 'core-role', secretId: 'core-secret' } },
      sandbox: null,
    })
  })

  it('takes a ЮKassa shop or none, and never the settings of a local fake', () => {
    const credentials = { YOOKASSA_SHOP_ID: '123456', YOOKASSA_SECRET_KEY: 'live_shop-secret-key' }
    const shop = { ...credentials, YOOKASSA_AUTOPAYMENTS: 'on' }
    expect(loadConfig(prodEnv()).yookassa).toBeNull()
    expect(loadConfig(prodEnv(shop)).yookassa).toEqual({
      shopId: '123456',
      secretKey: 'live_shop-secret-key',
      autopayments: true,
    })
    expect(
      loadConfig(prodEnv({ ...credentials, YOOKASSA_AUTOPAYMENTS: 'off' })).yookassa,
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
  })

  it('links billing letters to the https address of the app only', () => {
    expect(loadConfig(prodEnv()).billing).toEqual({
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
    expect(loadConfig(prodEnv())).toMatchObject({
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
    ).runnerApi!.tokens
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
      loadConfig(prodEnv({ S3_RUNNER_ENDPOINT: 'https://storage.yandexcloud.net' })).storage
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
      ).storage.endpoint,
    ).toBe('http://10.20.0.5:8333')
    // Local S3 stays plain outside production.
    expect(loadConfig(devEnv).storage.endpoint).toMatch(/^http:/)
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
    expect(loadConfig({ ...devEnv, METRICS_TOKEN: 'short' }).metricsToken).toBe('short')
  })

  it('refuses a METRICS_TOKEN with whitespace in any environment: no Bearer header carries it', () => {
    const refused = 'METRICS_TOKEN: must not contain whitespace (it is sent as a Bearer token)'
    const spaced = 'my long metrics token with spaces 1234567890'
    for (const env of [
      prodEnv({ METRICS_TOKEN: spaced }),
      prodEnv({ METRICS_TOKEN: `${PROD_METRICS_TOKEN}\n` }),
      { ...devEnv, METRICS_TOKEN: 'dev token' },
    ]) {
      const problems = problemsOf(env)
      expect(problems).toEqual([refused])
      expect(problems.join('\n')).not.toMatch(/spaces|dev token|xxxx/)
    }
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
      ).git,
    ).toEqual({
      kind: 'gitea',
      baseUrl: 'https://gitea.raditi.internal',
      token: 'synthetic-token',
      caFile: '/run/raditi/gitea-ca.pem',
    })
    // Until the turn handler is wired (P12) a core without git still starts.
    expect(loadConfig(prodEnv()).git).toBeNull()
  })
})

describe('loadConfig — previews and releases', () => {
  const digest = `@sha256:${'a'.repeat(64)}`
  const previewDev = (overrides: Env = {}): Env => ({
    ...devEnv,
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
  it('builds no preview without a base domain and starts core as before', () => {
    expect(loadConfig(devEnv)).toMatchObject({ previews: null })
    expect(loadConfig(prodEnv())).toMatchObject({ previews: null, releaseApi: null })
  })

  it('reads previews of core with local defaults and pinned images', () => {
    const config = loadConfig(
      previewDev({
        PREVIEW_WEB_IMAGES: `8.3=registry.raditi.ru/preview-php${digest}`,
        PREVIEW_DB_IMAGE: `mariadb${digest}`,
        PREVIEW_TTL_HOURS: '24',
      }),
    )
    expect(config.previews).toEqual({
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
  })

  it("gives previews the platform's subnets the sandbox gateway refuses too (R10)", () => {
    // On runner VMs, as production runs turns: core's own sandbox gateway is not configured.
    expect(
      loadConfig(
        previewProd({ SANDBOX_EGRESS_REFUSED_SUBNETS: '84.201.128.0/18, 2a02:6b8:c00::/40' }),
      ).previews?.egressRefusedSubnets,
    ).toEqual(['84.201.128.0/18', '2a02:6b8:c00::/40'])
    expect(loadConfig(previewProd()).previews?.egressRefusedSubnets).toEqual([])
    expect(problemsOf(previewProd({ SANDBOX_EGRESS_REFUSED_SUBNETS: '84.201.128.0' }))[0]).toMatch(
      /^SANDBOX_EGRESS_REFUSED_SUBNETS\b.*CIDR/,
    )
  })

  it('gives core its Docker for local previews and none for runner VMs (R5c)', () => {
    const local = loadConfig(
      previewDev({ SANDBOX_DOCKER_SOCKET: '/run/docker.sock', PREVIEW_GATEWAY_PORT: '18090' }),
    )
    expect(local.previews).toMatchObject({
      gatewayPort: 18090,
      docker: { socketPath: '/run/docker.sock', firewallImage: null },
    })
    expect(loadConfig(previewDev({ PREVIEW_EXECUTOR: 'runner' })).previews?.docker).toBeNull()
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

  it('opens the release API only where RELEASE_API_HOST says, with a default URL outside production', () => {
    expect(loadConfig(devEnv).releaseApi).toBeNull()
    expect(loadConfig({ ...devEnv, RELEASE_API_HOST: '127.0.0.1' }).releaseApi).toEqual({
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
      }).releaseApi,
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
  })

  it('takes previews and the release API in production over https on private addresses', () => {
    const core = loadConfig(previewProd())
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
    expect(loadConfig(previewProd({ PREVIEW_UPSTREAM_HOST: '10.20.0.9' })).previews).toMatchObject({
      upstreamHost: '10.20.0.9',
    })
    expect(loadConfig(previewProd()).previews).toMatchObject({ upstreamHost: '127.0.0.1' })
    // Outside production any address literal is taken, as before.
    expect(loadConfig(previewDev({ PREVIEW_UPSTREAM_HOST: '203.0.113.7' })).previews).toMatchObject(
      {
        upstreamHost: '203.0.113.7',
      },
    )
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
})

describe('loadConfig — the browser worker (docs/plan/57-browser-tasks.md, Б10)', () => {
  const TOKEN = 'browser-worker-token-'.padEnd(40, 'x')

  it('leaves tasks in the browser unavailable, and core starting, without BROWSER_WORKER_URL', () => {
    expect(loadConfig(devEnv).browser).toBeNull()
    // The token alone belongs to the worker in the shared .env: core reads nothing of it.
    expect(loadConfig({ ...devEnv, BROWSER_WORKER_TOKEN: 'short' }).browser).toBeNull()
  })

  it('reads the origin of the worker, its token and the deadline of its sessions', () => {
    expect(
      loadConfig({
        ...devEnv,
        BROWSER_WORKER_URL: 'http://127.0.0.1:8086/',
        BROWSER_WORKER_TOKEN: TOKEN,
      }).browser,
    ).toEqual({ url: 'http://127.0.0.1:8086', token: TOKEN, sessionMaxHours: 4 })
    // The worker's own BROWSER_SESSION_MAX_HOURS: the deadline core writes is the worker's.
    const worker = { BROWSER_WORKER_URL: 'http://127.0.0.1:8086', BROWSER_WORKER_TOKEN: TOKEN }
    expect(
      loadConfig({ ...devEnv, ...worker, BROWSER_SESSION_MAX_HOURS: '8' }).browser,
    ).toMatchObject({ sessionMaxHours: 8 })
    expect(problemsOf({ ...devEnv, ...worker, BROWSER_SESSION_MAX_HOURS: '25' })).toEqual([
      expect.stringMatching(/^BROWSER_SESSION_MAX_HOURS: /),
    ])
    // Without the worker core reads none of it.
    expect(loadConfig({ ...devEnv, BROWSER_SESSION_MAX_HOURS: '25' }).browser).toBeNull()
  })

  it('names what is wrong with the worker settings, never their values', () => {
    const problems = problemsOf({
      ...devEnv,
      BROWSER_WORKER_URL: 'http://user:secret-pass@127.0.0.1:8086/api',
      BROWSER_WORKER_TOKEN: 'short token',
    })
    expect(problems).toEqual([
      'BROWSER_WORKER_TOKEN: must be 32 to 4096 visible ASCII characters without spaces',
    ])
    // The rule of mcp, preview and the worker too: a token one of them refuses, core refuses.
    const long = 't'.repeat(4097)
    const tooLong = problemsOf({
      ...devEnv,
      BROWSER_WORKER_URL: 'http://127.0.0.1:8086',
      BROWSER_WORKER_TOKEN: long,
    })
    expect(tooLong).toEqual([
      'BROWSER_WORKER_TOKEN: must be 32 to 4096 visible ASCII characters without spaces',
    ])
    expect(tooLong.join('\n')).not.toContain(long)
    expect(problemsOf({ ...devEnv, BROWSER_WORKER_URL: 'http://127.0.0.1:8086' })).toEqual([
      'BROWSER_WORKER_TOKEN: required with BROWSER_WORKER_URL',
    ])
    const bad = problemsOf({
      ...devEnv,
      BROWSER_WORKER_URL: 'http://user:secret-pass@127.0.0.1:8086/api',
      BROWSER_WORKER_TOKEN: TOKEN,
    })
    expect(bad).toEqual([
      'BROWSER_WORKER_URL: expected an http(s) origin (no path, credentials or query)',
    ])
    expect(JSON.stringify(bad)).not.toContain('secret-pass')
  })

  it('reaches the worker in production over plain http only on a private address', () => {
    expect(
      loadConfig(
        prodEnv({ BROWSER_WORKER_URL: 'http://10.20.0.30:8086', BROWSER_WORKER_TOKEN: TOKEN }),
      ).browser,
    ).toEqual({ url: 'http://10.20.0.30:8086', token: TOKEN, sessionMaxHours: 4 })
    expect(
      problemsOf(
        prodEnv({ BROWSER_WORKER_URL: 'http://browser:8086', BROWSER_WORKER_TOKEN: TOKEN }),
      ),
    ).toEqual([
      'BROWSER_WORKER_URL: plain http only to a private or loopback IP address in production (spec §19)',
    ])
    expect(
      loadConfig(
        prodEnv({ BROWSER_WORKER_URL: 'https://browser.internal', BROWSER_WORKER_TOKEN: TOKEN }),
      ).browser,
    ).toMatchObject({ url: 'https://browser.internal' })
  })
})
