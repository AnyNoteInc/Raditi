import { describe, expect, it } from 'vitest'

import { loadGitWorkerConfig } from './config.ts'

describe('loadGitWorkerConfig', () => {
  it('needs the volume and the refused subnets in production, and nothing of core', () => {
    expect(
      loadGitWorkerConfig({
        APP_ENV: 'production',
        GIT_MIRROR_DIR: '/git',
        SANDBOX_EGRESS_REFUSED_SUBNETS: '10.10.0.0/16',
      }),
    ).toMatchObject({ appEnv: 'production', mirrorDir: '/git', allowLoopback: false })
    expect(() => loadGitWorkerConfig({ APP_ENV: 'production' })).toThrow(
      /GIT_MIRROR_DIR: required in production.*SANDBOX_EGRESS_REFUSED_SUBNETS: required in production/,
    )
  })

  it('refuses the loopback of a stand in production and takes it elsewhere', () => {
    expect(() =>
      loadGitWorkerConfig({
        APP_ENV: 'production',
        GIT_MIRROR_DIR: '/git',
        SANDBOX_EGRESS_REFUSED_SUBNETS: '10.10.0.0/16',
        GIT_ALLOW_LOOPBACK: '1',
      }),
    ).toThrow(/GIT_ALLOW_LOOPBACK/)
    expect(
      loadGitWorkerConfig({ APP_ENV: 'development', GIT_ALLOW_LOOPBACK: 'true' }).allowLoopback,
    ).toBe(true)
  })
})
