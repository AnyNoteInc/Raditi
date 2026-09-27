import type { AppEnv } from '@repo/domain'
import type { SandboxConfig } from '@repo/sandbox-providers'

/**
 * The runner role on a sandbox VM (spec §8): Docker and core's runner API only. It holds no
 * PostgreSQL, Redis, Vault or S3 settings; the VM token is read from its file at start.
 */
export interface RunnerConfig {
  appEnv: AppEnv
  /** RUNNER_CORE_URL: the origin of core's runner API, https:// in production. */
  coreUrl: URL
  /** RUNNER_TOKEN_FILE: the file with the VM token, never an env value (docker inspect shows env). */
  tokenFile: string
  /** RUNNER_CORE_CA_FILE: a private CA for core's certificate. */
  caFile: string | null
  /** RUNNER_MAX_TURNS: turns at once; one until several runners are supported (stage 2). */
  maxTurns: number
  sandbox: SandboxConfig
}
