import { describe, expect, it } from 'vitest'

import {
  gitConnectionLimits,
  gitConnectionSecretPath,
  gitConnectionSecretSchema,
  gitlabComOffered,
  gitServerHostOf,
  gitTokenInputSchema,
} from './connections.ts'

// The git connections of a user (docs/plan/84-projects.md, ПР10, ПР29; slice 84.17).
describe('git connections', () => {
  it('takes the host of an own GitLab server as a name or its https address only', () => {
    expect(gitServerHostOf('git.kolos-bakery.ru')).toBe('git.kolos-bakery.ru')
    expect(gitServerHostOf(' https://Git.Kolos-Bakery.ru/ ')).toBe('git.kolos-bakery.ru')
    expect(gitServerHostOf('https://git.kolos-bakery.ru:443')).toBe('git.kolos-bakery.ru')
    for (const refused of [
      'http://git.kolos-bakery.ru',
      'https://git.kolos-bakery.ru:8443',
      'https://user:pass@git.kolos-bakery.ru',
      'https://git.kolos-bakery.ru/group',
      'https://10.0.0.1',
      'localhost',
      '',
    ])
      expect(gitServerHostOf(refused)).toBeNull()
  })

  it('offers GitLab.com in production only once the texts of 84.16а are published', () => {
    expect(gitlabComOffered('development', true)).toBe(true)
    expect(gitlabComOffered('development', false)).toBe(false)
    expect(gitlabComOffered('production', true)).toBe(false)
  })

  it('keeps the tokens as strings at the path of the workspace', () => {
    expect(gitConnectionSecretPath('w', 'c')).toBe('kv/workspaces/w/git/c')
    expect(
      gitConnectionSecretSchema.safeParse({ accessToken: 'a', expiresAt: '2030-01-01T00:00:00Z' })
        .success,
    ).toBe(true)
    expect(gitConnectionSecretSchema.safeParse({ token: 't' }).success).toBe(true)
    expect(gitConnectionSecretSchema.safeParse({ token: 't', extra: 'x' }).success).toBe(false)
    expect(gitTokenInputSchema.safeParse('glpat with space').success).toBe(false)
    expect(
      gitTokenInputSchema.safeParse('x'.repeat(gitConnectionLimits.tokenChars + 1)).success,
    ).toBe(false)
  })
})
