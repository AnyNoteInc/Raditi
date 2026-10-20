import { isAbsolute } from 'node:path'

import { appEnvSchema, envProblems, envVar, isProduction, type Env } from '@repo/domain'
import { isPrivateAddress } from '@repo/ip-address'
import type { RunnerConfig } from '@repo/runner-engine'
import { sandboxConfigFromEnv } from '@repo/sandbox-providers'
import { ConfigError } from '@repo/app-bootstrap'
import { z } from 'zod'

export { ConfigError }
export type { RunnerConfig }

const ownEnvSchema = z.object({
  // Required, never defaulted: a missing APP_ENV must not switch the production checks off.
  APP_ENV: envVar(appEnvSchema),
  RUNNER_CORE_URL: envVar(
    z.url({ protocol: /^https?$/, error: 'must be an http(s):// URL' }).optional(),
  ),
  RUNNER_TOKEN_FILE: envVar(z.string().optional()),
  RUNNER_CORE_CA_FILE: envVar(z.string().optional()),
  RUNNER_S3_ORIGIN: envVar(
    z.url({ protocol: /^https?$/, error: 'must be an http(s):// URL' }).optional(),
  ),
  RUNNER_MAX_TURNS: envVar(
    z.coerce
      .number()
      .int()
      .min(1)
      .max(1, 'one turn per runner until several runners are supported (stage 2)')
      .default(1),
  ),
})

/** Set by the OS, Docker or the Node image: never a platform setting. */
const systemVariables = new Set([
  'PATH',
  'HOME',
  'HOSTNAME',
  'TZ',
  'TERM',
  'LANG',
  'LANGUAGE',
  'PWD',
  'OLDPWD',
  'SHLVL',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'NODE_VERSION',
  'YARN_VERSION',
  '_',
])

/**
 * All a production runner may be given (spec §8, §19): its own and the sandbox settings plus the
 * system's. Anything else may be a platform credential a sandbox VM must never hold.
 */
function isRunnerVariable(name: string): boolean {
  return (
    ['APP_ENV', 'NODE_ENV'].includes(name) ||
    name.startsWith('RUNNER_') ||
    name.startsWith('SANDBOX_') ||
    name.startsWith('LC_') ||
    systemVariables.has(name)
  )
}

/** An origin; with `bucket`, optionally followed by one S3 bucket name as its path. */
const isOrigin = (url: URL, { bucket = false } = {}) =>
  !url.username &&
  !url.password &&
  (url.pathname === '/' ||
    (bucket && /^\/[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]\/?$/.test(url.pathname))) &&
  !url.search &&
  !url.hash

/**
 * The settings of the runner on a sandbox VM (spec §8, §19) and nothing else: Docker and core's
 * runner API. In production it refuses any variable that is not its own, the sandbox's or the
 * system's (names only: the values may be exactly what must not be on the VM). Lists every
 * problem at once.
 */
export function loadRunnerConfig(env: Env): RunnerConfig {
  const parsed = ownEnvSchema.safeParse(env)
  if (!parsed.success) throw new ConfigError(envProblems(parsed.error), 'runner')
  const own = parsed.data
  const appEnv = own.APP_ENV
  const production = isProduction(appEnv)
  const problems: string[] = []

  let coreUrl: URL | undefined
  let s3Origin: string | null = null
  if (own.RUNNER_CORE_URL === undefined)
    problems.push('RUNNER_CORE_URL: required for the runner role')
  else {
    coreUrl = new URL(own.RUNNER_CORE_URL)
    if (!isOrigin(coreUrl))
      problems.push('RUNNER_CORE_URL: expected an origin (no path, credentials or query)')
    // Inside the perimeter plain http goes to the app VM's private address only (spec §19).
    if (production && coreUrl.protocol === 'http:' && !isPrivateAddress(coreUrl.hostname))
      problems.push(
        'RUNNER_CORE_URL: plain http only to a private IP address in production (spec §19)',
      )
  }
  if (own.RUNNER_S3_ORIGIN === undefined) {
    if (production) problems.push('RUNNER_S3_ORIGIN: required for the runner role in production')
  } else {
    const s3 = new URL(own.RUNNER_S3_ORIGIN)
    // Path-style S3 shares one host between buckets: the pin names the sessions bucket too.
    if (!isOrigin(s3, { bucket: true }))
      problems.push(
        'RUNNER_S3_ORIGIN: expected an origin, with the sessions bucket for path-style S3 (no credentials or query)',
      )
    // The cloud's S3 is outside the private network: presigned URLs go there over TLS only.
    else if (production && s3.protocol !== 'https:')
      problems.push('RUNNER_S3_ORIGIN: must use https in production')
    s3Origin = s3.origin + s3.pathname.replace(/\/$/, '')
  }
  if (own.RUNNER_TOKEN_FILE === undefined)
    problems.push(
      'RUNNER_TOKEN_FILE: required for the runner role (the token is never an env value)',
    )
  else if (!isAbsolute(own.RUNNER_TOKEN_FILE))
    problems.push('RUNNER_TOKEN_FILE: must be an absolute path')
  if (own.RUNNER_CORE_CA_FILE !== undefined && !isAbsolute(own.RUNNER_CORE_CA_FILE))
    problems.push('RUNNER_CORE_CA_FILE: must be an absolute path')
  // Names only: the values may be exactly what must not be on a sandbox VM.
  if (production)
    for (const name of Object.keys(env).sort())
      if (!isRunnerVariable(name) && env[name]?.trim())
        problems.push(`${name}: must not be set for the runner role in production`)

  let sandbox: RunnerConfig['sandbox'] | undefined
  try {
    sandbox = sandboxConfigFromEnv(env)
  } catch (err) {
    problems.push(err instanceof Error ? err.message : String(err))
  }
  if (
    problems.length > 0 ||
    coreUrl === undefined ||
    sandbox === undefined ||
    own.RUNNER_TOKEN_FILE === undefined
  )
    throw new ConfigError(problems, 'runner')

  return {
    appEnv,
    coreUrl,
    tokenFile: own.RUNNER_TOKEN_FILE,
    caFile: own.RUNNER_CORE_CA_FILE ?? null,
    s3Origin,
    maxTurns: own.RUNNER_MAX_TURNS,
    sandbox,
  }
}
