import { createHash, timingSafeEqual } from 'node:crypto'

import { parseRunnerToken } from '@repo/domain'

import { MAX_TOKENS_PER_RUNNER, type RunnerTokenHashes } from '../config/runner-tokens.ts'

/** `Bearer rnr_<63-char id>.<43 chars>` fits well within this. */
const MAX_AUTHORIZATION = 256
/** Compared against when the runner id is unknown, so every token costs the same. */
const NO_TOKEN = createHash('sha256').update('raditi-runner-token-unknown').digest()

/**
 * The runner a request comes from. A token opens only the turns assigned to its runner: it is
 * a machine identity, not a platform secret (spec §15). mTLS comes in M10.
 */
export class RunnerAuthenticator {
  readonly #hashes: RunnerTokenHashes

  constructor(hashes: RunnerTokenHashes) {
    this.#hashes = hashes
  }

  /** The runner id of `Authorization: Bearer <token>`, or null; nothing tells why. */
  authenticate(authorization: string | undefined): string | null {
    if (
      !authorization ||
      authorization.length > MAX_AUTHORIZATION ||
      !authorization.startsWith('Bearer ')
    )
      return null
    const token = authorization.slice('Bearer '.length)
    const runnerId = parseRunnerToken(token)?.runnerId
    const digest = createHash('sha256').update(token, 'utf8').digest()
    const known = runnerId ? this.#hashes.get(runnerId) : undefined
    // Constant time per hash, and as many comparisons whether or not the id is known.
    const candidates = [...(known ?? []), NO_TOKEN, NO_TOKEN].slice(0, MAX_TOKENS_PER_RUNNER)
    let matched = false
    for (const hash of candidates) matched = timingSafeEqual(digest, hash) || matched
    return runnerId && known?.length && matched ? runnerId : null
  }
}
