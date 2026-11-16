import { describe, expect, it } from 'vitest'

import { DomainError, type OAuthApp } from '@repo/domain'

import { createGitConnect } from './connect.ts'
import { fakeSend } from './testing/fake-send.ts'
import { createGitTransport } from './transport.ts'

const app: OAuthApp = {
  host: 'gitlab.com',
  clientId: 'client',
  clientSecret: 'secret',
  redirectUri: 'https://raditi.ru/api/git/gitlab/callback',
}

function setup(answer: { status: number; body: unknown }, gitlabComUrl?: string) {
  const { send, calls } = fakeSend({ 'POST /oauth/token': answer })
  const transport = createGitTransport({ resolvePublic: async () => '203.0.113.5', send })
  return {
    connect: createGitConnect('gitlab', { transport, ...(gitlabComUrl ? { gitlabComUrl } : {}) }),
    calls,
  }
}

describe('GitLab sign-in', () => {
  it('exchanges a code with PKCE', async () => {
    const { connect, calls } = setup({
      status: 200,
      body: {
        access_token: 'a',
        token_type: 'bearer',
        expires_in: 7200,
        refresh_token: 'r',
        created_at: 1_800_000_000,
      },
    })
    const tokens = await connect.exchangeCode(app, 'code', 'verifier')
    expect(tokens).toEqual({
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: new Date((1_800_000_000 + 7200) * 1000),
    })
    expect(calls[0]!.url.toString()).toBe('https://gitlab.com/oauth/token')
    expect(calls[0]!.body).toEqual({
      client_id: 'client',
      client_secret: 'secret',
      redirect_uri: app.redirectUri,
      grant_type: 'authorization_code',
      code: 'code',
      code_verifier: 'verifier',
    })
  })

  it('a refused refresh is a new sign-in', async () => {
    const { connect, calls } = setup({
      status: 400,
      body: { error: 'invalid_grant', error_description: 'x' },
    })
    expect(await connect.refreshAccess(app, 'r')).toEqual({ reauth: true })
    expect(calls[0]!.body).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'r',
      redirect_uri: app.redirectUri,
    })
  })

  it('another failure is not a reauth', async () => {
    const { connect } = setup({ status: 401, body: { error: 'invalid_client' } })
    await expect(connect.refreshAccess(app, 'r')).rejects.toMatchObject({
      code: 'GIT_PROVIDER_FAILED',
    })
  })

  it('goes to the own server of the app, and to a stand fake only on localhost', async () => {
    const own = setup({ status: 200, body: { access_token: 'a' } })
    await own.connect.exchangeCode({ ...app, host: 'gitlab.example.ru' }, 'c', 'v')
    expect(own.calls[0]!.url.host).toBe('gitlab.example.ru')
    const stand = setup({ status: 200, body: { access_token: 'a' } }, 'https://localhost:4443')
    await stand.connect.exchangeCode(app, 'c', 'v')
    expect(stand.calls[0]!.url.toString()).toBe('https://localhost:4443/oauth/token')
    expect(() => setup({ status: 200, body: {} }, 'https://evil.example')).toThrow(DomainError)
  })
})
