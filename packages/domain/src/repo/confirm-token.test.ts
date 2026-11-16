import { createHmac } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  readRepoConfirmToken,
  repoConfirmMaterial,
  signRepoConfirmToken,
  type RepoConfirmClaims,
} from './confirm-token.ts'

const mac = (secret: string) => (material: string) =>
  createHmac('sha256', secret).update(material).digest('base64url')

const now = new Date('2026-11-16T10:00:00Z')
const claims: RepoConfirmClaims = {
  kind: 'push',
  userId: '0193a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b',
  projectId: '0193a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2c',
  projectRepositoryId: '0193a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2d',
  taskId: '0193a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2e',
  number: null,
  targetBranch: 'raditi/menyu-9e0f1a2e',
  headSha: 'a'.repeat(40),
  diffSha256: 'b'.repeat(64),
  ciDiffSha256: null,
  opensMergeRequest: true,
  deploy: null,
  nonce: '0'.repeat(32),
  expiresAt: Math.floor(now.getTime() / 1000) + 600,
}

describe('the confirmation of a button of a repository (ПР13, ПР15)', () => {
  it('reads back what it signed, and only by the same secret', () => {
    const token = signRepoConfirmToken(claims, mac('s'.repeat(40)))
    expect(readRepoConfirmToken(token, mac('s'.repeat(40)), now)).toEqual(claims)
    expect(() => readRepoConfirmToken(token, mac('t'.repeat(40)), now)).toThrow(
      expect.objectContaining({ code: 'REPO_CONFIRM_INVALID' }),
    )
  })

  it('refuses a changed claim, a broken token and an expired one', () => {
    const token = signRepoConfirmToken(claims, mac('s'.repeat(40)))
    const [body, sig] = token.split('.')
    const changed = Buffer.from(JSON.stringify({ ...claims, targetBranch: 'main' })).toString(
      'base64url',
    )
    for (const bad of [`${changed}.${sig}`, `${body}`, `${body}.${sig}.x`, '', 'x'.repeat(3000)])
      expect(() => readRepoConfirmToken(bad, mac('s'.repeat(40)), now)).toThrow(
        expect.objectContaining({ code: 'REPO_CONFIRM_INVALID' }),
      )
    expect(() =>
      readRepoConfirmToken(token, mac('s'.repeat(40)), new Date(claims.expiresAt * 1000)),
    ).toThrow(expect.objectContaining({ code: 'REPO_CONFIRM_EXPIRED' }))
  })

  it('binds every claim in the material', () => {
    const base = repoConfirmMaterial(claims)
    expect(repoConfirmMaterial({ ...claims, headSha: 'c'.repeat(40) })).not.toBe(base)
    expect(repoConfirmMaterial({ ...claims, diffSha256: null })).not.toBe(base)
    expect(repoConfirmMaterial({ ...claims, opensMergeRequest: false })).not.toBe(base)
    expect(repoConfirmMaterial({ ...claims, kind: 'merge' })).not.toBe(base)
  })
})
