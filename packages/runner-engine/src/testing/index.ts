// The configuration of a runner as tests of core and of the app make it up. Only for *.test.ts.
import { sandboxConfigFromEnv } from '@repo/sandbox-providers'

import type { RunnerConfig } from '../runner-config.ts'

export function testRunnerConfig(overrides: Partial<RunnerConfig> = {}): RunnerConfig {
  return {
    appEnv: 'test',
    coreUrl: new URL('http://127.0.0.1:8083'),
    tokenFile: '/run/raditi/runner-token',
    caFile: null,
    s3Origin: null,
    maxTurns: 1,
    sandbox: sandboxConfigFromEnv({ APP_ENV: 'test' }),
    ...overrides,
  }
}
