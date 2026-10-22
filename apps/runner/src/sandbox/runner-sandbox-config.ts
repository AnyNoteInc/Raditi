import { parseRunnerToken } from '@repo/domain'
import type { SandboxConfig } from '@repo/sandbox-providers'

import type { RunnerConfig } from '../config/config.ts'

/**
 * The runner's Docker settings: its turn containers carry its id, and it lists only those, so
 * two runners sharing one daemon (a verification next to another) never collect each other's.
 */
export function runnerSandboxConfig(config: RunnerConfig, token: string): SandboxConfig {
  const parsed = parseRunnerToken(token)
  if (!parsed) throw new Error('RUNNER_TOKEN_FILE: does not hold a runner token')
  return { ...config.sandbox, runnerId: parsed.runnerId }
}
