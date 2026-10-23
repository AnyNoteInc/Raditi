import type { SandboxConfig } from '@repo/sandbox-providers'

import type { RunnerConfig } from '../config/config.ts'

/**
 * The runner's Docker settings: its turn containers carry its id, and it lists only those, so
 * two runners sharing one daemon (a verification next to another) never collect each other's.
 */
export function runnerSandboxConfig(config: RunnerConfig, runnerId: string): SandboxConfig {
  return { ...config.sandbox, runnerId }
}
