import { Buffer } from 'node:buffer'

import {
  DomainError,
  forbidden,
  publicationLimits,
  withTimeout,
  type GitCredentials,
  type GitProvider,
  type RepoRef,
} from '@repo/domain'

import { runProcess, type ProcessResult } from './process.ts'

// The one way core runs git against a site repository: the publication of a turn
// (GitWorkspaceService) and the first version of a connected site (site-provisioning). Every
// invocation gets the same environment and the same fixed options, so nothing of the machine,
// the user, a repository or a grant can switch a check off, run a hook or prompt for a password.

/**
 * How git reaches a repository: `https` to the configured origins, `file` to a bare repository
 * of a test fixture. The caller decides which is allowed (only NODE_ENV=test may use `file`).
 */
export type TrustedGitProtocol = 'https' | 'file'

export interface TrustedGitContext {
  /** A private directory of one operation: HOME and XDG_CONFIG_HOME of every git it runs. */
  home: string
  protocol: TrustedGitProtocol
  /**
   * Absolute path of a PEM bundle git also trusts (GIT_SSL_CAINFO), https only: the CA of our
   * own Gitea. It adds trust and removes none.
   */
  caFile?: string
}

/** Lifetime of one grant: a clone, a ls-remote or a push, never a whole stage. */
export const GIT_CREDENTIAL_TTL_SECONDS = 120

export const gitOperationFailed = () =>
  new DomainError('GIT_OPERATION_FAILED', 'Trusted repository operation failed', 502)

/** The whole environment of a trusted git: nothing is inherited but PATH. */
export function trustedGitEnvironment(context: TrustedGitContext): NodeJS.ProcessEnv {
  return {
    // One more trusted CA when set; nothing here can switch certificate checks off.
    ...(context.protocol === 'https' && context.caFile !== undefined
      ? { GIT_SSL_CAINFO: context.caFile }
      : {}),
    PATH: process.env.PATH,
    HOME: context.home,
    XDG_CONFIG_HOME: context.home,
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_LITERAL_PATHSPECS: '1',
  }
}

/**
 * The options in front of every subcommand. A grant in `auth` (RADITI_GIT_AUTH) is sent as one
 * extra header taken from the environment, never from argv or a URL, and only while it is valid.
 */
export function trustedGitOptions(protocol: TrustedGitProtocol, auth: NodeJS.ProcessEnv): string[] {
  const options = [
    '--no-pager',
    '--no-replace-objects',
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'core.fsmonitor=false',
    '-c',
    'submodule.recurse=false',
    '-c',
    'credential.helper=',
    '-c',
    'core.attributesFile=/dev/null',
    // On by default only where git was built for that file system: every platform refuses the
    // aliases of `.git` alike (`.g\u200cit` on HFS+, `git~1` and `.git.` on NTFS), so a path
    // one core would keep is never kept by another. update-index leaves such a path out and still
    // exits 0; its callers check the index back.
    '-c',
    'core.protectHFS=true',
    '-c',
    'core.protectNTFS=true',
    '-c',
    'protocol.allow=never',
    '-c',
    `protocol.${protocol}.allow=always`,
    '-c',
    'http.followRedirects=false',
    '-c',
    'transfer.fsckObjects=true',
    '-c',
    'fetch.fsckObjects=true',
    '-c',
    'commit.gpgsign=false',
    '-c',
    'gc.auto=0',
  ]
  if (auth.RADITI_GIT_AUTH) {
    if (Number(auth.RADITI_GIT_AUTH_EXPIRES) <= Date.now())
      throw forbidden('Repository credential expired before use')
    options.push('--config-env=http.extraHeader=RADITI_GIT_AUTH')
  }
  return options
}

export interface TrustedGitRun {
  cwd: string
  input?: Uint8Array
  maxBytes?: number
  /** A grant from gitAuthEnvironment, and the per-command extras (author, committer, date). */
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
}

/** One git subcommand under runProcess: the exit code and stdout, never stderr or argv. */
export async function runTrustedGit(
  context: TrustedGitContext,
  args: string[],
  run: TrustedGitRun,
): Promise<ProcessResult> {
  const env = run.env ?? {}
  const options = trustedGitOptions(context.protocol, env)
  return runProcess('git', [...options, ...args], {
    cwd: run.cwd,
    input: run.input,
    maxBytes: run.maxBytes,
    ...(run.timeoutMs === undefined ? {} : { timeoutMs: run.timeoutMs }),
    env: { ...trustedGitEnvironment(context), ...env },
  })
}

const hasControl = (value: string) =>
  [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)

/**
 * A grant of the provider as the environment of a trusted git: one Basic authorization header and
 * its expiry. Anything that is not a short-lived, printable username and token is refused.
 */
export function gitAuthEnvironment(
  credentials: GitCredentials,
  ttlSeconds: number = GIT_CREDENTIAL_TTL_SECONDS,
): NodeJS.ProcessEnv {
  const ttl =
    credentials.expiresAt instanceof Date ? credentials.expiresAt.getTime() - Date.now() : 0
  if (
    !Number.isFinite(ttl) ||
    ttl < 5000 ||
    ttl > (ttlSeconds + 5) * 1000 ||
    typeof credentials.username !== 'string' ||
    typeof credentials.token !== 'string' ||
    !credentials.username ||
    credentials.username.length > 1024 ||
    !credentials.token ||
    credentials.token.length > 4096 ||
    credentials.username.includes(':') ||
    hasControl(credentials.username) ||
    hasControl(credentials.token)
  )
    throw forbidden('Repository credentials are not a valid short-lived grant')
  return {
    RADITI_GIT_AUTH: `Authorization: Basic ${Buffer.from(`${credentials.username}:${credentials.token}`).toString('base64')}`,
    RADITI_GIT_AUTH_EXPIRES: String(credentials.expiresAt.getTime()),
  }
}

/**
 * Asks the provider for a grant of `access` to `ref` and checks it. A provider that fails or
 * answers late is GIT_OPERATION_FAILED (its error goes nowhere); an unusable grant is FORBIDDEN.
 */
export async function issueGitAuth(
  provider: Pick<GitProvider, 'issueCredentials'>,
  ref: RepoRef,
  access: 'read' | 'write',
): Promise<NodeJS.ProcessEnv> {
  let credentials: GitCredentials
  try {
    credentials = await withTimeout(
      provider.issueCredentials(ref, access, GIT_CREDENTIAL_TTL_SECONDS),
      publicationLimits.commandMs,
      'Repository credentials timed out',
    )
  } catch {
    throw gitOperationFailed()
  }
  return gitAuthEnvironment(credentials)
}
