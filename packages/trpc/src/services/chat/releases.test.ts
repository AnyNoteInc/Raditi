import { createHash } from 'node:crypto'

import { CONFIRM_TOKEN_TTL_SECONDS, releaseKeyMaterial } from '@repo/domain'
import { describe, expect, it } from 'vitest'

import { chatContextOf, releaseConfirmKey, RELEASE_CONFIRM_KEY_INFO } from './context.ts'
import { releaseKeyOf, signConfirmToken, verifyConfirmToken } from './releases.ts'

const key = releaseConfirmKey('the secret of the sessions of this test')
const now = new Date('2026-10-17T12:00:00.000Z')
const claims = {
  userId: '0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a60',
  candidateId: '0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a61',
  revision: 3,
  version: 'v1.4.0',
  dbViewSha256: 'd'.repeat(64),
  expiresAt: Math.floor(now.getTime() / 1000) + CONFIRM_TOKEN_TTL_SECONDS,
}
const invalid = expect.objectContaining({ code: 'RELEASE_CONFIRMATION_INVALID' })

describe('the key of release confirmations', () => {
  it('is HKDF of the secret of the sessions with its own info: the same in every replica', () => {
    expect(RELEASE_CONFIRM_KEY_INFO).toBe('raditi-release-confirm-v1')
    expect(key).toHaveLength(32)
    expect(releaseConfirmKey('the secret of the sessions of this test')).toEqual(key)
    expect(releaseConfirmKey('another secret')).not.toEqual(key)
    expect(Buffer.from(key).toString('utf8')).not.toContain('secret')
    expect(() => releaseConfirmKey('')).toThrow()
  })

  it('makes a procedure without the dialog context answer that dialogs are unavailable', () => {
    expect(() => chatContextOf({})).toThrow(
      expect.objectContaining({ code: 'CHAT_NOT_CONFIGURED', httpStatus: 503 }),
    )
    expect(() => chatContextOf({ chat: null })).toThrow(
      expect.objectContaining({ code: 'CHAT_NOT_CONFIGURED' }),
    )
  })
})

describe('a confirmation of a release', () => {
  it('carries its claims and gives them back to the key that signed it', () => {
    const token = signConfirmToken(key, claims)
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/)
    expect(verifyConfirmToken(key, token, now)).toEqual(claims)
  })

  it('is refused when altered, signed by another key, or not a token at all', () => {
    const token = signConfirmToken(key, claims)
    const [body, signature] = token.split('.') as [string, string]
    const otherVersion = Buffer.from(JSON.stringify({ ...claims, version: 'v9.0.0' })).toString(
      'base64url',
    )
    // The description of another plan: a confirmation of what the client did not see.
    const otherView = Buffer.from(
      JSON.stringify({ ...claims, dbViewSha256: 'e'.repeat(64) }),
    ).toString('base64url')
    for (const forged of [
      `${otherVersion}.${signature}`,
      `${otherView}.${signature}`,
      `${body}.${signature.slice(0, -2)}AA`,
      `${body}.${signature}.x`,
      body,
      '',
      'not.a-token',
      `${Buffer.from('{"userId":1}').toString('base64url')}.${signature}`,
      `${body}.${'A'.repeat(2000)}`,
    ])
      expect(() => verifyConfirmToken(key, forged, now), forged).toThrow(invalid)
    expect(() => verifyConfirmToken(releaseConfirmKey('another secret'), token, now)).toThrow(
      invalid,
    )
    expect(() => signConfirmToken(key, { ...claims, version: '1.4.0' })).toThrow()
  })

  it('lives ten minutes', () => {
    const token = signConfirmToken(key, claims)
    const later = new Date(claims.expiresAt * 1000)
    expect(() => verifyConfirmToken(key, token, later)).toThrow(
      expect.objectContaining({ code: 'RELEASE_CONFIRMATION_EXPIRED' }),
    )
    expect(verifyConfirmToken(key, token, new Date(later.getTime() - 1000))).toEqual(claims)
  })
})

describe('the key of a release', () => {
  it('is the SHA-256 hex of the canonical text of the candidate, revision, number and attempt', () => {
    const input = { candidateId: claims.candidateId, revision: 3, version: 'v1.4.0', attempt: 1 }
    expect(releaseKeyOf(input)).toBe(
      createHash('sha256').update(releaseKeyMaterial(input)).digest('hex'),
    )
    expect(releaseKeyOf({ ...input, attempt: 2 })).not.toBe(releaseKeyOf(input))
  })
})
