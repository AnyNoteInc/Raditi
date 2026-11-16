import { Buffer } from 'node:buffer'

import { forbidden, type IssuedGitAccess } from '@repo/domain'

// The grant of one operation as the environment of the worker's git (docs/plan/84-projects.md,
// §4.3, §4.6): one Basic authorization header taken by `--config-env`, never argv, a URL or a
// config file, and its expiry. Returned from main (trusted-git.ts there) under the new port.

/** Lifetime of one grant: a fetch or a push, never a whole stage. */
export const GIT_CREDENTIAL_TTL_SECONDS = 120

const hasControl = (value: string) =>
  [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)

/**
 * `{}` for anonymous access (an open repository); otherwise the header and its expiry. Anything
 * that is not a short-lived, printable username and token is refused.
 */
export function gitAuthEnvironment(
  access: IssuedGitAccess,
  ttlSeconds: number = GIT_CREDENTIAL_TTL_SECONDS,
): Record<'RADITI_GIT_AUTH' | 'RADITI_GIT_AUTH_EXPIRES', string> | Record<string, never> {
  if (access.basic === null) {
    if (access.auth.kind !== 'anonymous') throw forbidden('A bearer grant without Basic access')
    return {}
  }
  const { username, password } = access.basic
  const ttl = access.expiresAt instanceof Date ? access.expiresAt.getTime() - Date.now() : 0
  if (
    !Number.isFinite(ttl) ||
    ttl < 5000 ||
    ttl > (ttlSeconds + 5) * 1000 ||
    typeof username !== 'string' ||
    typeof password !== 'string' ||
    !username ||
    username.length > 1024 ||
    !password ||
    password.length > 4096 ||
    username.includes(':') ||
    hasControl(username) ||
    hasControl(password)
  )
    throw forbidden('Repository credentials are not a valid short-lived grant')
  return {
    RADITI_GIT_AUTH: `Authorization: Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
    RADITI_GIT_AUTH_EXPIRES: String(access.expiresAt.getTime()),
  }
}
