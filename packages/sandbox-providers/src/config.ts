import {
  appEnvSchema,
  envVar,
  isProduction,
  parseEnv,
  sandboxRuntimes,
  type Env,
  type SandboxRuntime,
} from '@repo/domain'
import { z } from 'zod'

import { isLocalSocket } from './docker-api.ts'
import { gatewayConfigFromEnv, type GatewayConfig } from './gateway/config.ts'

const sandboxEnvSchema = z
  .object({
    // Required, never defaulted: a missing APP_ENV must not switch the gVisor check off.
    APP_ENV: envVar(appEnvSchema),
    // On macOS gVisor is unavailable, hence the runc default (CLAUDE.md, local development).
    SANDBOX_RUNTIME: envVar(z.enum(sandboxRuntimes).default('runc')),
    SANDBOX_DOCKER_SOCKET: envVar(
      z
        .string()
        .refine(isLocalSocket, 'expected an absolute Unix socket path')
        .default('/var/run/docker.sock'),
    ),
  })
  .refine((env) => !isProduction(env.APP_ENV) || env.SANDBOX_RUNTIME === 'runsc', {
    message: 'production sandboxes run under gVisor: set SANDBOX_RUNTIME=runsc (CLAUDE.md rule 5)',
    path: ['SANDBOX_RUNTIME'],
  })

export interface SandboxConfig {
  runtime: SandboxRuntime
  /** Local Unix socket only. Never inferred from DOCKER_HOST. */
  socketPath?: string
  gateway?: GatewayConfig
}

export function sandboxConfigFromEnv(env: Env): SandboxConfig {
  const e = parseEnv('sandbox', sandboxEnvSchema, env)
  const gateway = gatewayConfigFromEnv(env)
  return {
    runtime: e.SANDBOX_RUNTIME,
    socketPath: e.SANDBOX_DOCKER_SOCKET,
    ...(gateway ? { gateway } : {}),
  }
}
