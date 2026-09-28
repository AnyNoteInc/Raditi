import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

import { TELEGRAM_LIMITS } from './limits.ts'

/** Uppercase base32 without the ambiguous 0/O/1/I: 24 letters and digits 2-9. */
const LINK_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/**
 * secret_token for setWebhook: 256 random bits as base64url (43 characters), which fits
 * Telegram's allowed alphabet A-Z, a-z, 0-9, _ and -.
 */
export function generateWebhookSecret(): string {
  return randomBytes(32).toString('base64url')
}

/**
 * Compares the X-Telegram-Bot-Api-Secret-Token header with the configured secret in
 * constant time. Hashing first makes the comparison independent of the lengths too.
 */
export function verifyWebhookSecret(
  received: string | null | undefined,
  expected: string | null | undefined,
): boolean {
  if (!received || !expected) return false
  const a = createHash('sha256').update(received, 'utf8').digest()
  const b = createHash('sha256').update(expected, 'utf8').digest()
  return timingSafeEqual(a, b)
}

/**
 * 8-character one-time code (~40 bits: enough for a 15-minute single-use code).
 * 32 symbols divide 256 evenly, so `byte & 31` is unbiased.
 */
export function generateLinkCode(): string {
  const bytes = randomBytes(TELEGRAM_LIMITS.linkCodeLength)
  let out = ''
  for (const b of bytes) out += LINK_CODE_ALPHABET[b & 31]!
  return out
}

/** Link codes are stored hashed: sha256 hex, no salt (15-minute TTL, single use). */
export function hashLinkCode(code: string): string {
  return createHash('sha256').update(code).digest('hex')
}
