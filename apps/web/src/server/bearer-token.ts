import { createHash, timingSafeEqual } from 'node:crypto'

const BEARER = /^Bearer\s+(\S+)\s*$/i

const digest = (value: string) => createHash('sha256').update(value).digest()

/** Compares `Authorization: Bearer <token>` in constant time (hashes make lengths equal). */
export function bearerTokenMatches(authorization: string | null, expected: string): boolean {
  const token = authorization === null ? undefined : BEARER.exec(authorization)?.[1]
  if (token === undefined) return false
  return timingSafeEqual(digest(token), digest(expected))
}
