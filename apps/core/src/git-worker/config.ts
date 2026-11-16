import { statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

import {
  appEnvSchema,
  envProblems,
  envVar,
  isProduction,
  type AppEnv,
  type Env,
} from '@repo/domain'
import { parseRefusedSubnets, type RefusedSubnet } from '@repo/ip-address'
import { z } from 'zod'

// The variables of trusted git (docs/plan/84-projects.md, §4.5): read alike by core and by its
// git worker — the worker cannot import core's configuration, which reaches the database. No
// Nest, no decorators: the worker is started from this tree without it.

/** `<tmpdir>/raditi-mirrors` outside production when GIT_MIRROR_DIR is empty. */
export const defaultMirrorDir = (): string => join(tmpdir(), 'raditi-mirrors')

export interface GitEnvConfig {
  /** GIT_MIRROR_DIR: the volume of the mirrors, the bundle cache, the operations and the socket. */
  mirrorDir: string
  /** GIT_CA_FILE: one more CA git trusts (GIT_SSL_CAINFO); never in production. */
  caFile?: string
  /** GIT_ALLOW_LOOPBACK: `localhost` fakes of a stand pass the public check; never in production. */
  allowLoopback: boolean
}

const flag = envVar(z.enum(['0', '1', 'true', 'false']).optional())

const schema = z.object({
  APP_ENV: envVar(appEnvSchema),
  GIT_MIRROR_DIR: envVar(z.string().optional()),
  GIT_CA_FILE: envVar(z.string().optional()),
  GIT_ALLOW_LOOPBACK: flag,
})

/** The git variables, or the problems with them (no values). */
export function gitEnvConfig(env: Env): { config: GitEnvConfig; problems: string[] } {
  const parsed = schema.safeParse({
    APP_ENV: env.APP_ENV,
    GIT_MIRROR_DIR: env.GIT_MIRROR_DIR,
    GIT_CA_FILE: env.GIT_CA_FILE,
    GIT_ALLOW_LOOPBACK: env.GIT_ALLOW_LOOPBACK,
  })
  if (!parsed.success)
    return {
      config: { mirrorDir: defaultMirrorDir(), allowLoopback: false },
      problems: envProblems(parsed.error),
    }
  const own = parsed.data
  const production = isProduction(own.APP_ENV)
  const problems: string[] = []
  if (own.GIT_MIRROR_DIR === undefined && production)
    problems.push('GIT_MIRROR_DIR: required in production (the volume of the mirrors)')
  if (own.GIT_MIRROR_DIR !== undefined && !isAbsolute(own.GIT_MIRROR_DIR))
    problems.push('GIT_MIRROR_DIR: must be an absolute path')
  if (own.GIT_CA_FILE !== undefined) {
    if (production) problems.push('GIT_CA_FILE: only outside production (the CA of a stand)')
    else {
      let regular = false
      try {
        regular = isAbsolute(own.GIT_CA_FILE) && statSync(own.GIT_CA_FILE).isFile()
      } catch {
        // A missing file fails here, at start, and not inside the first fetch.
      }
      if (!regular) problems.push('GIT_CA_FILE: must be an absolute path of a file')
    }
  }
  const allowLoopback = own.GIT_ALLOW_LOOPBACK === '1' || own.GIT_ALLOW_LOOPBACK === 'true'
  if (allowLoopback && production)
    problems.push('GIT_ALLOW_LOOPBACK: only outside production (the fakes of a stand)')
  return {
    config: {
      mirrorDir: own.GIT_MIRROR_DIR ?? defaultMirrorDir(),
      ...(own.GIT_CA_FILE === undefined ? {} : { caFile: own.GIT_CA_FILE }),
      allowLoopback,
    },
    problems,
  }
}

export interface GitWorkerConfig extends GitEnvConfig {
  appEnv: AppEnv
  /** SANDBOX_EGRESS_REFUSED_SUBNETS: a pinned address in them is refused, as core refuses it. */
  refusedSubnets: RefusedSubnet[]
}

/** The worker's configuration; throws one error naming every problem. */
export function loadGitWorkerConfig(env: Env): GitWorkerConfig {
  const appEnv = appEnvSchema.safeParse(env.APP_ENV)
  const { config, problems } = gitEnvConfig(env)
  const subnets = env.SANDBOX_EGRESS_REFUSED_SUBNETS?.trim()
  const refusedSubnets = subnets ? parseRefusedSubnets(subnets) : []
  if (refusedSubnets === null)
    problems.push('SANDBOX_EGRESS_REFUSED_SUBNETS: expected subnets such as 10.10.0.0/16')
  if (!appEnv.success) problems.push('APP_ENV: expected a known environment')
  else if (isProduction(appEnv.data) && !subnets)
    problems.push('SANDBOX_EGRESS_REFUSED_SUBNETS: required in production')
  if (problems.length || !appEnv.success)
    throw new Error(`[git-worker] invalid configuration: ${problems.join('; ')}`)
  return { ...config, appEnv: appEnv.data, refusedSubnets: refusedSubnets ?? [] }
}
