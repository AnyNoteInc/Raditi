import { describe, expect, it } from 'vitest'

import {
  confirmTokenMaterial,
  CONFIRM_TOKEN_TTL_SECONDS,
  isConfirmTokenExpired,
} from './confirm-token.ts'
import { releaseKeyMaterial, releaseKeySchema } from './release-key.ts'

const candidateId = '0196abcd-0000-7000-8000-00000000000a'
const userId = '0196abcd-0000-7000-8000-00000000000b'

describe('the release key', () => {
  it('is the same text for the same candidate, revision, version and attempt', () => {
    const input = { candidateId, revision: 2, version: 'v1.4.0', attempt: 1 }
    expect(releaseKeyMaterial(input)).toBe(`raditi-release-key:v1\n${candidateId}\n2\nv1.4.0\n1`)
    expect(releaseKeyMaterial({ ...input })).toBe(releaseKeyMaterial(input))
    for (const other of [
      { ...input, revision: 3 },
      { ...input, version: 'v1.4.1' },
      { ...input, attempt: 2 },
    ])
      expect(releaseKeyMaterial(other)).not.toBe(releaseKeyMaterial(input))
  })

  it('refuses what is not a candidate, a revision, a version or an attempt', () => {
    for (const input of [
      { candidateId: 'c1', revision: 1, version: 'v1.0.0', attempt: 1 },
      { candidateId, revision: 0, version: 'v1.0.0', attempt: 1 },
      { candidateId, revision: 1, version: '1.0.0', attempt: 1 },
      { candidateId, revision: 1, version: 'v1.0.0', attempt: 0 },
    ])
      expect(() => releaseKeyMaterial(input)).toThrow()
    expect(releaseKeySchema.safeParse('a'.repeat(64)).success).toBe(true)
    expect(releaseKeySchema.safeParse('A'.repeat(64)).success).toBe(false)
  })
})

describe('the confirmation', () => {
  it('signs the reader, the candidate, the revision, the version, the shown plan and the expiry', () => {
    const view = 'a'.repeat(64)
    const claims = {
      userId,
      candidateId,
      revision: 2,
      version: 'v1.4.0',
      dbViewSha256: view,
      expiresAt: 1_800_000_000,
    }
    expect(confirmTokenMaterial(claims)).toBe(
      `raditi-release-confirm:v2\n${userId}\n${candidateId}\n2\nv1.4.0\n${view}\n1800000000`,
    )
    // A candidate without a database plan has no description to bind.
    expect(confirmTokenMaterial({ ...claims, dbViewSha256: null })).toBe(
      `raditi-release-confirm:v2\n${userId}\n${candidateId}\n2\nv1.4.0\n-\n1800000000`,
    )
    expect(isConfirmTokenExpired(claims, new Date(1_799_999_999_000))).toBe(false)
    expect(isConfirmTokenExpired(claims, new Date(1_800_000_000_000))).toBe(true)
    expect(CONFIRM_TOKEN_TTL_SECONDS).toBe(600)
  })
})
