import { describe, expect, it } from 'vitest'

import { testRunnerConfig } from '../testing/config.ts'
import { runnerSandboxConfig } from './runner-sandbox-config.ts'

describe('runnerSandboxConfig', () => {
  it('labels its turn containers with the runner id of its VM token', () => {
    const config = testRunnerConfig({ tokenFile: '/etc/raditi/runner-token' })
    expect(runnerSandboxConfig(config, 'sandbox-7')).toEqual({
      ...config.sandbox,
      runnerId: 'sandbox-7',
    })
  })
})
