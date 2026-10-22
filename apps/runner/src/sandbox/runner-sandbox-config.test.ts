import { randomBytes } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { testRunnerConfig } from '../testing/config.ts'
import { runnerSandboxConfig } from './runner-sandbox-config.ts'

describe('runnerSandboxConfig', () => {
  it('labels its turn containers with the runner id of its VM token', () => {
    const config = testRunnerConfig({ tokenFile: '/etc/raditi/runner-token' })
    const token = `rnr_sandbox-7.${randomBytes(32).toString('base64url')}`
    expect(runnerSandboxConfig(config, token)).toEqual({ ...config.sandbox, runnerId: 'sandbox-7' })
    expect(() => runnerSandboxConfig(config, 'not-a-token')).toThrow(/RUNNER_TOKEN_FILE/)
  })
})
