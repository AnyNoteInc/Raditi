import { forbidden } from '@repo/domain'

// The fixed environment and options of every git the worker runs (docs/plan/84-projects.md,
// ПР12, ПР33), returned from main (apps/core/src/git-workspace/trusted-git.ts there). Nothing of
// the machine, the user, a repository or a grant can switch a check off, run a hook or a filter,
// follow a link on disk or prompt for a password. The worker applies them; core never runs git.

export type TrustedGitProtocol = 'none' | 'https' | 'file'

export interface TrustedGitContext {
  /** A private directory of one operation: HOME and XDG_CONFIG_HOME of every git it runs. */
  home: string
  protocol: TrustedGitProtocol
  /**
   * Absolute path of a PEM bundle git also trusts (GIT_SSL_CAINFO), https only: the CA of a
   * stand (GIT_CA_FILE, never in production). It adds trust and removes none.
   */
  caFile?: string
  /** The one address the host of an https remote resolves to during this operation (§4.6). */
  pin?: { host: string; address: string }
}

/** The whole environment of a trusted git: nothing is inherited but PATH. */
export function trustedGitEnvironment(context: TrustedGitContext): NodeJS.ProcessEnv {
  return {
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
    GIT_PROTOCOL_FROM_USER: '0',
  }
}

/** `[host]:443:address` for curl; an IPv6 address goes in brackets. */
const resolveEntry = (pin: { host: string; address: string }) =>
  `${pin.host}:443:${pin.address.includes(':') ? `[${pin.address}]` : pin.address}`

/**
 * The options in front of every subcommand. A grant in `auth` (RADITI_GIT_AUTH) is sent as one
 * extra header taken from the environment, never from argv or a URL, and only while it is valid.
 */
export function trustedGitOptions(context: TrustedGitContext, auth: NodeJS.ProcessEnv): string[] {
  const options = [
    '--no-pager',
    '--no-replace-objects',
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'core.fsmonitor=false',
    '-c',
    'core.symlinks=false',
    '-c',
    'core.attributesFile=/dev/null',
    '-c',
    'core.excludesFile=/dev/null',
    '-c',
    'core.protectHFS=true',
    '-c',
    'core.protectNTFS=true',
    // A huge blob is stored whole and never deltified: bounded memory for packs of others.
    '-c',
    'core.bigFileThreshold=16m',
    '-c',
    'pack.windowMemory=64m',
    '-c',
    'pack.threads=1',
    '-c',
    'submodule.recurse=false',
    '-c',
    'credential.helper=',
    '-c',
    'protocol.allow=never',
    ...(context.protocol === 'none' ? [] : ['-c', `protocol.${context.protocol}.allow=always`]),
    '-c',
    'http.followRedirects=false',
    '-c',
    'transfer.fsckObjects=true',
    '-c',
    'fetch.fsckObjects=true',
    // Every fetch keeps its pack: the trusted side moves a checked pack into the mirror whole.
    '-c',
    'fetch.unpackLimit=1',
    '-c',
    'transfer.unpackLimit=1',
    '-c',
    'commit.gpgsign=false',
    '-c',
    'gc.auto=0',
    '-c',
    'maintenance.auto=false',
  ]
  if (context.protocol === 'https' && context.pin)
    options.push('-c', `http.curloptResolve=${resolveEntry(context.pin)}`)
  if (auth.RADITI_GIT_AUTH) {
    if (Number(auth.RADITI_GIT_AUTH_EXPIRES) <= Date.now())
      throw forbidden('Repository credential expired before use')
    options.push('--config-env=http.extraHeader=RADITI_GIT_AUTH')
  }
  return options
}
