import { describe, expect, it } from 'vitest'

import { TELEGRAM_LIMITS } from './limits.ts'
import {
  generateLinkCode,
  generateWebhookSecret,
  hashLinkCode,
  verifyWebhookSecret,
} from './secret.ts'

describe('generateWebhookSecret', () => {
  it('returns 43 characters from the alphabet Telegram allows', () => {
    const secret = generateWebhookSecret()
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(secret.length).toBeLessThanOrEqual(TELEGRAM_LIMITS.webhookSecretMax)
  })

  it('generates unique secrets', () => {
    const secrets = new Set(Array.from({ length: 100 }, () => generateWebhookSecret()))
    expect(secrets.size).toBe(100)
  })
})

describe('verifyWebhookSecret', () => {
  const secret = generateWebhookSecret()

  it('accepts the exact secret', () => {
    expect(verifyWebhookSecret(secret, secret)).toBe(true)
  })

  it('rejects a different secret of the same length', () => {
    const other = (secret[0] === 'A' ? 'B' : 'A') + secret.slice(1)
    expect(verifyWebhookSecret(other, secret)).toBe(false)
  })

  it('rejects prefixes and longer values without throwing on length mismatch', () => {
    expect(verifyWebhookSecret(secret.slice(0, 10), secret)).toBe(false)
    expect(verifyWebhookSecret(`${secret}x`, secret)).toBe(false)
  })

  it.each([null, undefined, ''])('rejects a missing header %j', (header) => {
    expect(verifyWebhookSecret(header, secret)).toBe(false)
  })

  it('rejects everything when no secret is configured', () => {
    expect(verifyWebhookSecret('', '')).toBe(false)
    expect(verifyWebhookSecret('anything', undefined)).toBe(false)
  })
})

describe('generateLinkCode', () => {
  it('returns 8 uppercase base32 characters without 0/O/1/I', () => {
    for (let i = 0; i < 200; i++) {
      expect(generateLinkCode()).toMatch(/^[A-HJ-NP-Z2-9]{8}$/)
    }
  })

  it('generates unique codes', () => {
    const codes = new Set(Array.from({ length: 100 }, () => generateLinkCode()))
    expect(codes.size).toBe(100)
  })
})

describe('hashLinkCode', () => {
  it('returns a deterministic sha256 hex digest', () => {
    expect(hashLinkCode('ABCD2345')).toMatch(/^[0-9a-f]{64}$/)
    expect(hashLinkCode('ABCD2345')).toBe(hashLinkCode('ABCD2345'))
    expect(hashLinkCode('ABCD2345')).not.toBe(hashLinkCode('ABCD2346'))
  })
})
