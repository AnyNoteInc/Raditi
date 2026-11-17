import { describe, expect, it } from 'vitest'

import { gitAuthEnvironment } from './git-auth.ts'

const access = (
  ms: number,
  basic: { username: string; password: string } | null = {
    username: 'oauth2',
    password: 'synthetic-grant',
  },
) => ({
  auth: basic ? { kind: 'bearer' as const, token: basic.password } : { kind: 'anonymous' as const },
  basic,
  expiresAt: new Date(Date.now() + ms),
})

describe('gitAuthEnvironment', () => {
  it('sends a short-lived grant as one header, and nothing for an open repository', () => {
    expect(gitAuthEnvironment(access(60_000))).toEqual({
      RADITI_GIT_AUTH: `Authorization: Basic ${Buffer.from('oauth2:synthetic-grant').toString('base64')}`,
      RADITI_GIT_AUTH_EXPIRES: expect.stringMatching(/^\d+$/),
    })
    expect(gitAuthEnvironment(access(60_000, null))).toEqual({})
  })

  it.each([
    ['too short', access(1_000)],
    ['a colon in the name', access(60_000, { username: 'o:auth', password: 'x' })],
    ['a control character in the token', access(60_000, { username: 'oauth2', password: 'a\nb' })],
    ['no token', access(60_000, { username: 'oauth2', password: '' })],
  ])('refuses a grant with %s', (_, grant) => {
    expect(() => gitAuthEnvironment(grant)).toThrow('short-lived grant')
  })

  it('lets the worker use a longer-lived token only within one grant (a token of a GitHub installation)', () => {
    const before = Date.now()
    const env = gitAuthEnvironment(access(60 * 60_000))
    const expires = Number((env as { RADITI_GIT_AUTH_EXPIRES: string }).RADITI_GIT_AUTH_EXPIRES)
    expect(expires).toBeGreaterThanOrEqual(before + 120_000)
    expect(expires).toBeLessThanOrEqual(Date.now() + 120_000)
  })

  it('refuses a bearer grant that names no Basic access', () => {
    expect(() =>
      gitAuthEnvironment({
        auth: { kind: 'bearer', token: 't' },
        basic: null,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).toThrow('Basic')
  })
})
