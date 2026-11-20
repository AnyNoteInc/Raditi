/**
 * Fractional ranks of the blocks of an artifact (docs/plan/88-artifacts.md, Ар11, §7.2): a block
 * goes between two others by a new key, without renumbering the rest. A rank is a string of base
 * 36 — digits, then small Latin letters — read as the fraction 0.xyz…, and never ends with «0», so
 * there is always room between two of them. Every sort order of PostgreSQL and of JavaScript puts
 * such strings in the same order: digits before letters, a prefix before its continuation.
 */

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'
const BASE = ALPHABET.length
const RANK_PATTERN = /^[0-9a-z]*[1-9a-z]$/

export function isArtifactRank(value: string): boolean {
  return RANK_PATTERN.test(value)
}

function digit(rank: string, at: number): number {
  const value = ALPHABET.indexOf(rank.charAt(at))
  if (value === -1) throw new RangeError(`not a rank: ${rank}`)
  return value
}

/**
 * A rank strictly between `before` and `after`; null — no bound on that side. The key is as short
 * as the gap allows: inserts again and again at one place in the middle grow it by a character
 * about every five, at an end — about every 36.
 */
export function rankBetween(before: string | null, after: string | null): string {
  if (before !== null && !isArtifactRank(before)) throw new RangeError(`not a rank: ${before}`)
  if (after !== null && !isArtifactRank(after)) throw new RangeError(`not a rank: ${after}`)
  if (before !== null && after !== null && before >= after)
    throw new RangeError(`ranks out of order: ${before} ≥ ${after}`)
  return between(before ?? '', after)
}

function between(low: string, high: string | null): string {
  let prefix = ''
  for (let at = 0; ; at += 1) {
    const lowDigit = at < low.length ? digit(low, at) : 0
    const highDigit = high === null ? BASE : at < high.length ? digit(high, at) : BASE
    if (lowDigit === highDigit) {
      prefix += ALPHABET.charAt(lowDigit)
      continue
    }
    if (highDigit - lowDigit > 1) return prefix + ALPHABET.charAt((lowDigit + highDigit) >> 1)
    // Adjacent digits: keep the low one and go above the rest of `low`, with no upper bound.
    return prefix + ALPHABET.charAt(lowDigit) + between(low.slice(at + 1), null)
  }
}

/**
 * The rank of the n-th block of an ordered list (n from 0): three digits of base 36 and «i», the
 * same as the backfill of the migration 20261120100000_artifacts. Up to 46 656 blocks.
 */
export function rankForIndex(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index >= BASE ** 3)
    throw new RangeError(`no rank for index ${index}`)
  return (
    ALPHABET.charAt(Math.floor(index / BASE ** 2) % BASE) +
    ALPHABET.charAt(Math.floor(index / BASE) % BASE) +
    ALPHABET.charAt(index % BASE) +
    'i'
  )
}
