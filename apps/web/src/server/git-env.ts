import { appEnvSchema, envVar, isProduction, parseEnv, type Env } from '@repo/domain'
import {
  webGitAppsFromEnv,
  type GitAppsConfig,
  type GithubAppWebCredentials,
} from '@repo/git-providers/connect'
import { z } from 'zod'

/** Holds secrets: never log it. */
export type WebGitEnv = GitAppsConfig<GithubAppWebCredentials> & {
  /**
   * GIT_ALLOW_LOOPBACK, outside production only: the checks of a host let the `localhost` fakes of
   * a stand through — the same value core and its git worker read.
   */
  allowLoopback: boolean
}

const schema = z
  .object({
    APP_ENV: envVar(appEnvSchema),
    GIT_ALLOW_LOOPBACK: envVar(z.enum(['0', '1', 'true', 'false']).optional()),
  })
  .transform((env) => ({
    production: isProduction(env.APP_ENV),
    allowLoopback: env.GIT_ALLOW_LOOPBACK === '1' || env.GIT_ALLOW_LOOPBACK === 'true',
  }))
  .refine((env) => !(env.production && env.allowLoopback), {
    path: ['GIT_ALLOW_LOOPBACK'],
    message: 'only outside production (the fakes of a stand)',
  })

/**
 * The apps of the repositories of projects as web reads them (docs/plan/84-projects.md, §4.2,
 * §4.5): the sign-in on gitlab.com, the GitHub App (Э10), the secret of the cards, the fakes of a
 * stand. A section of its own (env.ts): a broken one fails only what connects a repository.
 */
export function webGitEnvFromEnv(env: Env): WebGitEnv {
  const own = parseEnv('git', schema, env)
  return { ...webGitAppsFromEnv(env), allowLoopback: own.allowLoopback }
}
