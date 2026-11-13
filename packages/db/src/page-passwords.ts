import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto'

import { pageLimits } from '@repo/domain'

import type { PrismaClient } from './generated/prisma/client.ts'

// The password of a page (docs/plan/69-pages.md, Ст13): the cabinet sets it, the page server checks
// it; both keep only this hash in `pages.password_hash`. scrypt of Node: N = 2^15, r = 8, p = 1,
// a salt of 16 bytes, a key of 32 — `scrypt$15$8$1$<salt>$<key>` in base64url.

const COST_LOG2 = 15
const BLOCK = 8
const PARALLEL = 1
const KEY_BYTES = 32
/** 128 · N · r bytes and some: the default 32 MiB of Node is exactly too little for N = 2^15. */
const MAX_MEMORY = 64 * 1024 * 1024

const scrypt = (password: string, salt: Buffer, options: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) =>
    scryptCallback(password.normalize('NFC'), salt, KEY_BYTES, options, (error, key) =>
      error ? reject(error) : resolve(key),
    ),
  )

const options = (costLog2: number, block: number, parallel: number): ScryptOptions => ({
  N: 2 ** costLog2,
  r: block,
  p: parallel,
  maxmem: MAX_MEMORY,
})

/** A password within `pageLimits` — the cabinet's form says the same. */
export function pagePasswordProblem(password: string): 'too_short' | 'too_long' | null {
  const length = [...password].length
  if (length < pageLimits.passwordMinChars) return 'too_short'
  if (length > pageLimits.passwordMaxChars) return 'too_long'
  return null
}

export async function hashPagePassword(password: string): Promise<string> {
  if (pagePasswordProblem(password) !== null)
    throw new Error('A page password is out of its bounds')
  const salt = randomBytes(16)
  const key = await scrypt(password, salt, options(COST_LOG2, BLOCK, PARALLEL))
  return [
    'scrypt',
    COST_LOG2,
    BLOCK,
    PARALLEL,
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$')
}

const HASH =
  /^scrypt\$(\d{1,2})\$(\d{1,2})\$(\d{1,2})\$([A-Za-z0-9_-]{16,64})\$([A-Za-z0-9_-]{40,64})$/

/** Whether `password` is the one the hash was made of; a hash of another form never matches. */
export async function verifyPagePassword(password: string, hash: string): Promise<boolean> {
  const match = HASH.exec(hash)
  if (!match || [...password].length > pageLimits.passwordMaxChars) return false
  const [, cost, block, parallel, salt, expected] = match
  // The parameters come from the database, not the request; still only those of this module run.
  const costLog2 = Number(cost)
  if (costLog2 !== COST_LOG2 || Number(block) !== BLOCK || Number(parallel) !== PARALLEL)
    return false
  const want = Buffer.from(expected!, 'base64url')
  const got = await scrypt(
    password,
    Buffer.from(salt!, 'base64url'),
    options(costLog2, BLOCK, PARALLEL),
  )
  return got.length === want.length && timingSafeEqual(got, want)
}

/**
 * Counts one attempt under `key` and tells whether it fits its window (`rate_limits`, as the
 * cabinet counts its uploads): `last_request` holds the END of the window. One statement:
 * parallel attempts cannot pass the limit together.
 */
export async function admitInWindow(
  db: Pick<PrismaClient, '$queryRaw'>,
  window: { key: string; limit: number; windowMs: number; now: number },
): Promise<boolean> {
  const { key, limit } = window
  const at = BigInt(window.now)
  const windowEnd = BigInt(window.now + window.windowMs)
  const rows = await db.$queryRaw<{ count: number }[]>`
    INSERT INTO rate_limits (id, key, count, last_request)
    VALUES (gen_random_uuid(), ${key}, 1, ${windowEnd}::bigint)
    ON CONFLICT (key) DO UPDATE SET
      count = CASE
        WHEN rate_limits.last_request <= ${at}::bigint THEN 1
        ELSE LEAST(rate_limits.count, ${limit}::int) + 1
      END,
      last_request = CASE
        WHEN rate_limits.last_request <= ${at}::bigint THEN ${windowEnd}::bigint
        ELSE rate_limits.last_request
      END
    RETURNING count
  `
  const count = rows[0]?.count
  if (count === undefined) throw new Error('The attempt counter returned no row')
  return count <= limit
}
