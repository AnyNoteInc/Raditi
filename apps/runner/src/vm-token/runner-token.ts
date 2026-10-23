import { open } from 'node:fs/promises'

import { isProduction, parseRunnerToken, type AppEnv } from '@repo/domain'

/** `rnr_<63-char id>.<43 chars>` and a newline fit well within this. */
const MAX_TOKEN_FILE_BYTES = 1024

/**
 * The VM token from RUNNER_TOKEN_FILE (spec §15). In production the file must be readable by its
 * owner only (root, 0400). Errors name the variable and a cause, never the token.
 */
export async function readRunnerToken(path: string, appEnv: AppEnv): Promise<string> {
  let file
  try {
    file = await open(path, 'r')
  } catch (error) {
    throw new Error(`RUNNER_TOKEN_FILE: cannot open the token file (${causeOf(error)})`, {
      cause: error,
    })
  }
  try {
    const stats = await file.stat()
    if (!stats.isFile()) throw new Error('RUNNER_TOKEN_FILE: not a regular file')
    if (isProduction(appEnv) && (stats.mode & 0o077) !== 0)
      throw new Error('RUNNER_TOKEN_FILE: must be readable by its owner only (0400)')
    if (stats.size > MAX_TOKEN_FILE_BYTES) throw new Error('RUNNER_TOKEN_FILE: too large')
    const token = (await file.readFile('utf8')).trim()
    if (!parseRunnerToken(token)) throw new Error('RUNNER_TOKEN_FILE: does not hold a runner token')
    return token
  } finally {
    await file.close()
  }
}

/** The runner id a VM token names; a token that names none is refused as the file above is. */
export function runnerIdOf(token: string): string {
  const parsed = parseRunnerToken(token)
  if (!parsed) throw new Error('RUNNER_TOKEN_FILE: does not hold a runner token')
  return parsed.runnerId
}

function causeOf(error: unknown): string {
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : 'error'
}
