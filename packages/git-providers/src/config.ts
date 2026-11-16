import { isAbsolute } from 'node:path'

import { appEnvSchema, envVar, isProduction, parseEnv, type Env } from '@repo/domain'
import { z } from 'zod'

import type { GitProviderEndpoints } from './create-git-provider.ts'

// The variables of the apps of the repositories of projects (docs/plan/84-projects.md, §4.2,
// §4.5): web and core read each their own part — two schemas, one file, so the rules of a value
// are the same in both. On the server the values come from Vault (`platform-secrets.mjs render`),
// locally from .env. A group set in part is an error: it is all or nothing. The error names
// variables and reasons, never values.

/** The OAuth app of Raditi on gitlab.com: web signs in with it, core renews the tokens. */
export interface GitlabOauthCredentials {
  clientId: string
  clientSecret: string
}

/** What web needs of the GitHub App (Э10): the installation, the user's check, the webhooks. */
export interface GithubAppWebCredentials {
  slug: string
  clientId: string
  clientSecret: string
  webhookSecret: string
}

/** Where core finds the private key of the GitHub App: a file, or outside production a PEM. */
export type GithubAppKey = { kind: 'file'; path: string } | { kind: 'pem'; pem: string }

/** What core needs of the GitHub App (Э10): the installation tokens. */
export interface GithubAppCoreCredentials {
  appId: string
  key: GithubAppKey
}

/** Holds secrets: never log it. */
export interface GitAppsConfig<GithubApp> {
  /** null — «Подключить GitLab.com» says «Скоро». */
  gitlabOauth: GitlabOauthCredentials | null
  /** null — GitHub is read by a public link only. */
  githubApp: GithubApp | null
  /**
   * REPO_CONFIRM_SECRET, the HMAC of the cards of a repository (ПР13, ПР15, ПР16). null only in
   * production without it: then no card is offered and no action runs; outside production an
   * empty one is a value for development.
   */
  repoConfirmSecret: string | null
  /** The fakes of a stand instead of the providers; empty in production. */
  endpoints: GitProviderEndpoints
}

/** REPO_CONFIRM_SECRET outside production when none is set: never a secret of a server. */
export const DEV_REPO_CONFIRM_SECRET = 'raditi-development-repo-confirm-secret-not-for-production'

const secret = envVar(
  z.string().regex(/^\S+$/, 'must be one word without whitespace').max(4096).optional(),
)
const endpoint = envVar(
  z
    .string()
    .regex(/^https:\/\/localhost:[1-9][0-9]{0,4}$/, 'must be https://localhost:<port> (a fake)')
    .optional(),
)

const shared = {
  APP_ENV: envVar(appEnvSchema),
  GITLAB_OAUTH_CLIENT_ID: secret,
  GITLAB_OAUTH_CLIENT_SECRET: secret,
  REPO_CONFIRM_SECRET: secret,
  RADITI_FAKE_GITHUB_API_URL: endpoint,
  RADITI_FAKE_GITHUB_WEB_URL: endpoint,
  RADITI_FAKE_GITLAB_COM_URL: endpoint,
}

type Shared = {
  APP_ENV: z.output<typeof appEnvSchema>
  GITLAB_OAUTH_CLIENT_ID?: string | undefined
  GITLAB_OAUTH_CLIENT_SECRET?: string | undefined
  REPO_CONFIRM_SECRET?: string | undefined
  RADITI_FAKE_GITHUB_API_URL?: string | undefined
  RADITI_FAKE_GITHUB_WEB_URL?: string | undefined
  RADITI_FAKE_GITLAB_COM_URL?: string | undefined
}

/** Every name of a group or none of them. */
function whole(ctx: z.RefinementCtx, env: Record<string, unknown>, names: readonly string[]): void {
  const set = names.filter((name) => env[name] !== undefined)
  if (set.length === 0 || set.length === names.length) return
  for (const name of names.filter((name) => env[name] === undefined))
    ctx.addIssue({
      code: 'custom',
      path: [name],
      message: `set ${names.join(', ')} together or none of them`,
    })
}

function sharedProblems(env: Shared, ctx: z.RefinementCtx): void {
  whole(ctx, env, ['GITLAB_OAUTH_CLIENT_ID', 'GITLAB_OAUTH_CLIENT_SECRET'])
  if (env.REPO_CONFIRM_SECRET !== undefined && env.REPO_CONFIRM_SECRET.length < 32)
    ctx.addIssue({
      code: 'custom',
      path: ['REPO_CONFIRM_SECRET'],
      message: 'must be at least 32 characters',
    })
  if (isProduction(env.APP_ENV))
    for (const name of [
      'RADITI_FAKE_GITHUB_API_URL',
      'RADITI_FAKE_GITHUB_WEB_URL',
      'RADITI_FAKE_GITLAB_COM_URL',
    ] as const)
      if (env[name] !== undefined)
        ctx.addIssue({ code: 'custom', path: [name], message: 'only outside production' })
}

function sharedConfig(env: Shared): Omit<GitAppsConfig<never>, 'githubApp'> {
  const production = isProduction(env.APP_ENV)
  return {
    gitlabOauth:
      env.GITLAB_OAUTH_CLIENT_ID && env.GITLAB_OAUTH_CLIENT_SECRET
        ? { clientId: env.GITLAB_OAUTH_CLIENT_ID, clientSecret: env.GITLAB_OAUTH_CLIENT_SECRET }
        : null,
    repoConfirmSecret: env.REPO_CONFIRM_SECRET ?? (production ? null : DEV_REPO_CONFIRM_SECRET),
    endpoints: {
      ...(env.RADITI_FAKE_GITHUB_API_URL ? { githubApiUrl: env.RADITI_FAKE_GITHUB_API_URL } : {}),
      ...(env.RADITI_FAKE_GITHUB_WEB_URL ? { githubWebUrl: env.RADITI_FAKE_GITHUB_WEB_URL } : {}),
      ...(env.RADITI_FAKE_GITLAB_COM_URL ? { gitlabComUrl: env.RADITI_FAKE_GITLAB_COM_URL } : {}),
    },
  }
}

const webGithub = [
  'GITHUB_APP_SLUG',
  'GITHUB_APP_CLIENT_ID',
  'GITHUB_APP_CLIENT_SECRET',
  'GITHUB_APP_WEBHOOK_SECRET',
] as const

const webSchema = z
  .object({
    ...shared,
    GITHUB_APP_SLUG: envVar(
      z
        .string()
        .regex(/^[a-z0-9][a-z0-9-]{0,33}$/, 'must be the slug of a GitHub App')
        .optional(),
    ),
    GITHUB_APP_CLIENT_ID: secret,
    GITHUB_APP_CLIENT_SECRET: secret,
    GITHUB_APP_WEBHOOK_SECRET: secret,
  })
  .superRefine((env, ctx) => {
    sharedProblems(env, ctx)
    whole(ctx, env, webGithub)
  })

/** web's part: the sign-in on gitlab.com, the GitHub App's installation, the cards. */
export function webGitAppsFromEnv(env: Env): GitAppsConfig<GithubAppWebCredentials> {
  const e = parseEnv('git apps', webSchema, env)
  return {
    ...sharedConfig(e),
    githubApp:
      e.GITHUB_APP_SLUG &&
      e.GITHUB_APP_CLIENT_ID &&
      e.GITHUB_APP_CLIENT_SECRET &&
      e.GITHUB_APP_WEBHOOK_SECRET
        ? {
            slug: e.GITHUB_APP_SLUG,
            clientId: e.GITHUB_APP_CLIENT_ID,
            clientSecret: e.GITHUB_APP_CLIENT_SECRET,
            webhookSecret: e.GITHUB_APP_WEBHOOK_SECRET,
          }
        : null,
  }
}

/** A PEM private key in base64 on one line, as .env takes one line per value. */
function pemOfBase64(value: string): string | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null
  const pem = Buffer.from(value, 'base64').toString('utf8')
  return /^-----BEGIN (RSA )?PRIVATE KEY-----\r?\n/.test(pem) ? pem : null
}

const coreSchema = z
  .object({
    ...shared,
    GITHUB_APP_ID: envVar(
      z
        .string()
        .regex(/^[1-9][0-9]{0,19}$/, 'must be the numeric id of a GitHub App')
        .optional(),
    ),
    GITHUB_APP_PRIVATE_KEY_FILE: envVar(z.string().max(16_384).optional()),
  })
  .superRefine((env, ctx) => {
    sharedProblems(env, ctx)
    whole(ctx, env, ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY_FILE'])
    const key = env.GITHUB_APP_PRIVATE_KEY_FILE
    if (key === undefined || isAbsolute(key)) return
    if (isProduction(env.APP_ENV))
      ctx.addIssue({
        code: 'custom',
        path: ['GITHUB_APP_PRIVATE_KEY_FILE'],
        message: 'must be an absolute path in production (/run/raditi/github-app.pem)',
      })
    else if (pemOfBase64(key) === null)
      ctx.addIssue({
        code: 'custom',
        path: ['GITHUB_APP_PRIVATE_KEY_FILE'],
        message: 'must be an absolute path or a PEM private key in base64 on one line',
      })
  })

/** core's part: the renewal on gitlab.com, the GitHub App's installation tokens, the cards. */
export function coreGitAppsFromEnv(env: Env): GitAppsConfig<GithubAppCoreCredentials> {
  const e = parseEnv('git apps', coreSchema, env)
  const file = e.GITHUB_APP_PRIVATE_KEY_FILE
  const key: GithubAppKey | null =
    file === undefined
      ? null
      : isAbsolute(file)
        ? { kind: 'file', path: file }
        : { kind: 'pem', pem: pemOfBase64(file) ?? '' }
  return {
    ...sharedConfig(e),
    githubApp: e.GITHUB_APP_ID && key ? { appId: e.GITHUB_APP_ID, key } : null,
  }
}
