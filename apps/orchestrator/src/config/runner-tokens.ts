import { createHash } from 'node:crypto'

import { runnerIdSchema } from '@repo/domain'

/** Two hashes per runner let a new token go live before the old one is dropped (spec §15). */
export const MAX_TOKENS_PER_RUNNER = 2
const HASH = /^[0-9a-f]{64}$/

/** SHA-256 hashes of whole runner tokens by runner id: RUNNER_TOKENS=id:hash,… */
export type RunnerTokenHashes = ReadonlyMap<string, readonly Buffer[]>

/** The hex SHA-256 core keeps for a token; the token itself stays on the runner VM. */
export function hashRunnerToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/** Problems name entries by position, never by value. */
export function parseRunnerTokens(raw: string): { hashes: RunnerTokenHashes; problems: string[] } {
  const hashes = new Map<string, Buffer[]>()
  const problems: string[] = []
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  entries.forEach((entry, index) => {
    const separator = entry.indexOf(':')
    const id = entry.slice(0, separator)
    const hash = entry.slice(separator + 1).toLowerCase()
    if (separator < 0 || !runnerIdSchema.safeParse(id).success || !HASH.test(hash)) {
      problems.push(`entry ${index + 1} must be <runner id>:<sha256 hex>`)
      return
    }
    const known = hashes.get(id) ?? []
    const digest = Buffer.from(hash, 'hex')
    if (known.some((value) => value.equals(digest))) {
      problems.push(`entry ${index + 1} repeats a hash of runner ${id}`)
      return
    }
    if (known.length === MAX_TOKENS_PER_RUNNER) {
      problems.push(`runner ${id} has more than ${MAX_TOKENS_PER_RUNNER} token hashes`)
      return
    }
    hashes.set(id, [...known, digest])
  })
  return { hashes, problems }
}
