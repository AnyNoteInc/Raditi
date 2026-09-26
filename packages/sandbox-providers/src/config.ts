import type { SandboxRuntime } from '@repo/domain'
import { appEnvSchema, isProduction, sandboxRuntimes } from '@repo/domain'
import { z } from 'zod'

const emptyAsMissing = (value: unknown) => (value === '' ? undefined : value)

/**
 * A docker repository without tag or digest: `raditi/agent`, `registry.local:3300/raditi/agent`.
 * TODO(P2): sandboxSpecSchema accepts only digest-pinned images, so `<prefix>-<driver>` must be
 * resolved to `…@sha256:` (Gitea registry) before a SandboxSpec is built.
 */
const imagePrefixPattern =
  /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+(?=\/))?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/

const sandboxEnvSchema = z
  .object({
    // Required, never defaulted: a missing APP_ENV must not switch the gVisor check off.
    APP_ENV: z.preprocess(emptyAsMissing, appEnvSchema),
    // On macOS gVisor is unavailable, hence the runc default (CLAUDE.md, local development).
    SANDBOX_RUNTIME: z.preprocess(emptyAsMissing, z.enum(sandboxRuntimes).default('runc')),
    SANDBOX_IMAGE_PREFIX: z.preprocess(
      emptyAsMissing,
      z.string().regex(imagePrefixPattern, 'expected a repository without tag, e.g. raditi/agent'),
    ),
  })
  .refine((env) => !isProduction(env.APP_ENV) || env.SANDBOX_RUNTIME === 'runsc', {
    message: 'production sandboxes run under gVisor: set SANDBOX_RUNTIME=runsc (CLAUDE.md rule 5)',
    path: ['SANDBOX_RUNTIME'],
  })

export interface SandboxConfig {
  runtime: SandboxRuntime
  /** Agent images are `<prefix>-<driver>`. */
  imagePrefix: string
}

export function sandboxConfigFromEnv(env: Record<string, string | undefined>): SandboxConfig {
  const parsed = sandboxEnvSchema.safeParse(env)
  if (!parsed.success) {
    throw new Error(`Invalid sandbox configuration:\n${z.prettifyError(parsed.error)}`)
  }
  return { runtime: parsed.data.SANDBOX_RUNTIME, imagePrefix: parsed.data.SANDBOX_IMAGE_PREFIX }
}
