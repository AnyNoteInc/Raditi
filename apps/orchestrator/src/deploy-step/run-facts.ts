import {
  appEnvSchema,
  deployWrapMatchesRun,
  isProduction,
  parseDeployWrap,
  publicationShaSchema,
  versionTagSchema,
  type AppEnv,
  type DeployWrap,
} from '@repo/domain'
import { z } from 'zod'

// What the deploy job knows about its run (the `gitea.*` context the workflow hands over as
// RADITI_RUN_* variables) and about its machine (RADITI_* of the runner's configuration). The
// repository decides neither where the wrapped token goes nor which image runs: the runner does.

const runSchema = z.strictObject({
  event: z.enum(['push', 'workflow_dispatch']),
  ref: z.string().regex(/^refs\/tags\/v\d{1,9}\.\d{1,9}\.\d{1,9}$/),
  refName: versionTagSchema,
  sha: publicationShaSchema,
  /** `gitea.server_url`: the instance itself, as its ROOT_URL. */
  server: z.url({ protocol: /^https?$/ }).max(2048),
  repository: z.string().regex(/^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/),
})
export type RunFacts = z.infer<typeof runSchema>

/** null — the run is not a release tag of a site (the job's `if:` already says so; checked again). */
export function runFactsFrom(env: Record<string, string | undefined>): RunFacts | null {
  const parsed = runSchema.safeParse({
    event: env.RADITI_RUN_EVENT,
    ref: env.RADITI_RUN_REF,
    refName: env.RADITI_RUN_REF_NAME,
    sha: env.RADITI_RUN_SHA,
    server: env.RADITI_RUN_SERVER,
    repository: env.RADITI_RUN_REPOSITORY,
  })
  if (!parsed.success) return null
  // The tag of the ref and its name agree; `v0.0.0` is the import's and never deploys.
  if (parsed.data.ref !== `refs/tags/${parsed.data.refName}` || parsed.data.refName === 'v0.0.0')
    return null
  return parsed.data
}

export type RunMatch =
  | { matched: true; wrap: DeployWrap }
  | { matched: false; reason: 'no_secret' | 'unreadable' | 'another_run' }

/**
 * Р29: the wrapping is for this run only when its tag and commit are the run's. Decided before
 * anything is unwrapped, so a tag of the import, any other tag, or a repeat spends nothing.
 */
export function matchRun(secret: string | undefined, run: RunFacts): RunMatch {
  if (secret === undefined || secret === '') return { matched: false, reason: 'no_secret' }
  const wrap = parseDeployWrap(secret)
  if (wrap === null) return { matched: false, reason: 'unreadable' }
  if (!deployWrapMatchesRun(wrap, { refName: run.refName, sha: run.sha }))
    return { matched: false, reason: 'another_run' }
  return { matched: true, wrap }
}

/** The machine side: set by the deploy runner (`runner.envs`), never by a site repository. */
const machineSchema = z.strictObject({
  appEnv: appEnvSchema,
  vaultAddr: z.url({ protocol: /^https?$/ }).max(2048),
  releaseApiUrl: z.url({ protocol: /^https?$/ }).max(2048),
})
export interface MachineFacts {
  appEnv: AppEnv
  vaultAddr: string
  releaseApiUrl: string
}

/** null — the runner is not configured for releases; nothing is sent anywhere. */
export function machineFactsFrom(env: Record<string, string | undefined>): MachineFacts | null {
  const parsed = machineSchema.safeParse({
    appEnv: env.APP_ENV,
    vaultAddr: env.RADITI_VAULT_ADDR,
    releaseApiUrl: env.RADITI_RELEASE_API_URL,
  })
  if (!parsed.success) return null
  // In production Vault speaks TLS; the release API listens on a private address (Р32).
  if (isProduction(parsed.data.appEnv) && !parsed.data.vaultAddr.startsWith('https:')) return null
  return parsed.data
}

/**
 * The job token goes to the Gitea of the run: in production only over TLS (Gitea between the
 * machines of the platform speaks HTTPS, CLAUDE.md «Стек»).
 */
export const runServerAllowed = (run: RunFacts, machine: MachineFacts): boolean =>
  !isProduction(machine.appEnv) || run.server.startsWith('https:')
