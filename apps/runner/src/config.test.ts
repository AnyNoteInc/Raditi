import type { Env } from '@repo/domain'
import { describe, expect, it } from 'vitest'

import { ConfigError, loadRunnerConfig } from './config.ts'

const runnerEnv = (overrides: Env = {}): Env => ({
  APP_ENV: 'production',
  RUNNER_CORE_URL: 'https://core.internal:8083',
  RUNNER_TOKEN_FILE: '/etc/raditi/runner-token',
  RUNNER_CORE_CA_FILE: '/etc/raditi/core-ca.pem',
  RUNNER_S3_ORIGIN: 'https://raditi-sessions.storage.yandexcloud.net',
  SANDBOX_RUNTIME: 'runsc',
  ...overrides,
})

function problemsOf(env: Env): readonly string[] {
  try {
    loadRunnerConfig(env)
  } catch (err) {
    if (err instanceof ConfigError) return err.problems
    throw err
  }
  throw new Error('expected a ConfigError')
}

const testRunnerUrl = (url: string) =>
  loadRunnerConfig({
    APP_ENV: 'development',
    RUNNER_CORE_URL: url,
    RUNNER_TOKEN_FILE: '/etc/raditi/runner-token',
  }).coreUrl

describe('loadRunnerConfig', () => {
  it('builds the runner role from its own settings only: core, token file, Docker', () => {
    const config = loadRunnerConfig({
      APP_ENV: 'development',
      RUNNER_CORE_URL: 'http://127.0.0.1:8083',
      RUNNER_TOKEN_FILE: '/etc/raditi/runner-token',
    })
    expect(config).toEqual({
      appEnv: 'development',
      coreUrl: new URL('http://127.0.0.1:8083'),
      tokenFile: '/etc/raditi/runner-token',
      caFile: null,
      s3Origin: null,
      maxTurns: 1,
      sandbox: { runtime: 'runc', socketPath: '/var/run/docker.sock' },
    })
  })

  it('refuses a runner without core, its token file or with more than one turn', () => {
    expect(problemsOf({ APP_ENV: 'development' })).toEqual([
      'RUNNER_CORE_URL: required for the runner role',
      'RUNNER_TOKEN_FILE: required for the runner role (the token is never an env value)',
    ])
    expect(
      problemsOf({
        APP_ENV: 'development',
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
        RUNNER_CORE_URL: 'http://127.0.0.1:8083/?token=secret',
        RUNNER_TOKEN_FILE: '/etc/raditi/runner-token',
      }).join('\n'),
    ).not.toContain('secret')
    expect(
      problemsOf({
        APP_ENV: 'development',
        RUNNER_MAX_TURNS: '2',
      })[0],
    ).toBe('RUNNER_MAX_TURNS: one turn per runner until several runners are supported (stage 2)')
  })

  it('runs a runner over https under gVisor, with nothing of the platform', () => {
    expect(loadRunnerConfig(runnerEnv())).toMatchObject({
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
      expect(loadRunnerConfig(runnerEnv({ ...plain, RUNNER_CORE_URL: url })).coreUrl).toEqual(
        new URL(url),
      )
    expect(
      loadRunnerConfig(runnerEnv({ ...plain, RUNNER_CORE_URL: 'https://core.raditi.ru:8083' }))
        .coreUrl,
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
      loadRunnerConfig(runnerEnv({ ...plainCore, RUNNER_S3_ORIGIN: 'https://s3.example.ru:443' }))
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
      expect(loadRunnerConfig(runnerEnv({ RUNNER_S3_ORIGIN: pin })).s3Origin).toBe(
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
      RUNNER_CORE_URL: 'http://127.0.0.1:8083',
      RUNNER_TOKEN_FILE: '/etc/raditi/runner-token',
    }
    expect(loadRunnerConfig(dev).s3Origin).toBeNull()
    expect(loadRunnerConfig({ ...dev, RUNNER_S3_ORIGIN: 'http://192.168.5.2:8333' }).s3Origin).toBe(
      'http://192.168.5.2:8333',
    )
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
      loadRunnerConfig(
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
      ),
    ).not.toBeNull()
    // Outside production a runner shares the developer's .env.
    expect(
      loadRunnerConfig({
        APP_ENV: 'development',
        RUNNER_CORE_URL: 'http://127.0.0.1:8083',
        RUNNER_TOKEN_FILE: '/etc/raditi/runner-token',
        DATABASE_URL: 'postgresql://raditi:raditi@localhost:5432/raditi',
      }),
    ).not.toBeNull()
  })
})
