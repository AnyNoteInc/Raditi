import { createHash } from 'node:crypto'

import { runnerIdSchema } from '@repo/domain'

import { ipLiteral, isPrivateAddress } from './private-address.ts'

/** Two hashes per runner let a new token go live before the old one is dropped (spec §15). */
export const MAX_TOKENS_PER_RUNNER = 2
const HASH = /^[0-9a-f]{64}$/

export interface RunnerTokenHash {
  digest: Buffer
  /** The private address of the runner's VM: the token opens nothing from anywhere else. */
  address?: string
}

/** SHA-256 hashes of whole runner tokens by runner id: RUNNER_TOKENS=id:hash[@ip],… */
export type RunnerTokenHashes = ReadonlyMap<string, readonly RunnerTokenHash[]>

/** The hex SHA-256 core keeps for a token; the token itself stays on the runner VM. */
export function hashRunnerToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/**
 * Problems name entries by position, never by value. Plain http inside the perimeter means a
 * token may be overheard, so in production each one is bound to its VM's private address.
 */
export function parseRunnerTokens(
  raw: string,
  production = false,
): { hashes: RunnerTokenHashes; problems: string[] } {
  const hashes = new Map<string, RunnerTokenHash[]>()
  const problems: string[] = []
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  entries.forEach((entry, index) => {
    const separator = entry.indexOf(':')
    const id = entry.slice(0, separator)
    const [hash = '', written, ...extra] = entry.slice(separator + 1).split('@')
    const address = written === undefined ? undefined : ipLiteral(written)
    if (
      separator < 0 ||
      !runnerIdSchema.safeParse(id).success ||
      !HASH.test(hash.toLowerCase()) ||
      (written !== undefined && address === undefined) ||
      extra.length > 0
    ) {
      problems.push(`entry ${index + 1} must be <runner id>:<sha256 hex>[@<IP address>]`)
      return
    }
    if (production && !(address && isPrivateAddress(address))) {
      problems.push(`entry ${index + 1} needs @<private IP> in production (spec §15)`)
      return
    }
    const known = hashes.get(id) ?? []
    const digest = Buffer.from(hash, 'hex')
    if (known.some((value) => value.digest.equals(digest))) {
      problems.push(`entry ${index + 1} repeats a hash of runner ${id}`)
      return
    }
    if (known.length === MAX_TOKENS_PER_RUNNER) {
      problems.push(`runner ${id} has more than ${MAX_TOKENS_PER_RUNNER} token hashes`)
      return
    }
    hashes.set(id, [...known, address === undefined ? { digest } : { digest, address }])
  })
  return { hashes, problems }
}
