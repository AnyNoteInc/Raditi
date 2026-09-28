import { createHash, timingSafeEqual } from 'node:crypto'

import { Logger } from '@nestjs/common'
import { parseRunnerToken } from '@repo/domain'
import { throttledLogger, type ThrottledLog } from '@repo/observability'

import { ipLiteral } from '../config/private-address.ts'
import {
  MAX_TOKENS_PER_RUNNER,
  type RunnerTokenHash,
  type RunnerTokenHashes,
} from '../config/runner-tokens.ts'

/** `Bearer rnr_<63-char id>.<43 chars>` fits well within this. */
const MAX_AUTHORIZATION = 256
/** Compared against when the runner id is unknown, so every token costs the same. */
const NO_TOKEN: RunnerTokenHash = {
  digest: createHash('sha256').update('raditi-runner-token-unknown').digest(),
}

/**
 * The runner a request comes from. Runners pull: a token may claim any waiting turn of any
 * client, then opens only the turns its runner claimed. It is a machine identity, not a
 * platform secret (spec §15). A token bound to its VM's address opens
 * nothing from another one: inside the perimeter it travels over plain http. Encryption, if ever
 * needed, is WireGuard between the VMs, with no code change (spec §15, §19).
 */
export class RunnerAuthenticator {
  readonly #hashes: RunnerTokenHashes
  readonly #log: ThrottledLog

  constructor(
    hashes: RunnerTokenHashes,
    logger: { warn(message: string): void } = new Logger('RunnerAuth'),
  ) {
    this.#hashes = hashes
    this.#log = throttledLogger((line) => logger.warn(line))
  }

  /**
   * The runner id of `Authorization: Bearer <token>` sent from `remoteAddress`, or null;
   * nothing tells why.
   */
  authenticate(
    authorization: string | undefined,
    remoteAddress: string | undefined,
  ): string | null {
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
    let matched: RunnerTokenHash | undefined
    for (const candidate of candidates)
      if (timingSafeEqual(digest, candidate.digest)) matched = candidate
    if (!runnerId || !known?.length || !matched || matched === NO_TOKEN) return null
    if (matched.address === undefined) return runnerId
    const from = remoteAddress === undefined ? undefined : ipLiteral(remoteAddress)
    if (from === matched.address) return runnerId
    // The runner and the address only: never the token.
    this.#log(`runner ${runnerId}`, new Error(`token from another address ${from ?? 'unknown'}`))
    return null
  }
}
