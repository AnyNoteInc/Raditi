import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createGitProvider } from './create-git-provider.ts'
import {
  verifyGiteaSignature,
  verifyGithubSignature,
  verifyGitlabToken,
} from './webhook-signature.ts'

const secret = 'webhook-secret'
const body = '{"action":"completed","workflow_run":{"id":1,"name":"деплой"}}'
const hmac = (key: string, payload: string) =>
  createHmac('sha256', key).update(payload, 'utf8').digest('hex')

describe('verifyGiteaSignature', () => {
  const headers = (signature: string) => new Headers({ 'X-Gitea-Signature': signature })

  it('accepts the hex HMAC-SHA256 of the raw body', () => {
    expect(verifyGiteaSignature(headers(hmac(secret, body)), body, secret)).toBe(true)
    expect(verifyGiteaSignature(headers(hmac(secret, body).toUpperCase()), body, secret)).toBe(true)
  })

  it('rejects a tampered body, a wrong secret and a missing header', () => {
    expect(verifyGiteaSignature(headers(hmac(secret, body)), `${body} `, secret)).toBe(false)
    expect(verifyGiteaSignature(headers(hmac('other', body)), body, secret)).toBe(false)
    expect(verifyGiteaSignature(new Headers(), body, secret)).toBe(false)
  })

  it('rejects malformed signatures without throwing', () => {
    const valid = hmac(secret, body)
    for (const bad of [
      '',
      valid.slice(0, 63),
      `${valid}00`,
      `${valid.slice(0, 62)}zz`,
      `sha256=${valid}`,
    ]) {
      expect(verifyGiteaSignature(headers(bad), body, secret)).toBe(false)
    }
  })

  it('fails closed on an empty secret', () => {
    expect(verifyGiteaSignature(headers(hmac('', body)), body, '')).toBe(false)
  })

  it('ignores the GitHub header', () => {
    const h = new Headers({ 'X-Hub-Signature-256': `sha256=${hmac(secret, body)}` })
    expect(verifyGiteaSignature(h, body, secret)).toBe(false)
  })
})

describe('verifyGithubSignature', () => {
  const headers = (signature: string) => new Headers({ 'X-Hub-Signature-256': signature })

  it('accepts sha256= + hex HMAC-SHA256 of the raw body', () => {
    expect(verifyGithubSignature(headers(`sha256=${hmac(secret, body)}`), body, secret)).toBe(true)
  })

  it('rejects a missing prefix, sha1 and a tampered body', () => {
    expect(verifyGithubSignature(headers(hmac(secret, body)), body, secret)).toBe(false)
    const sha1 = createHmac('sha1', secret).update(body).digest('hex')
    expect(verifyGithubSignature(headers(`sha1=${sha1}`), body, secret)).toBe(false)
    expect(verifyGithubSignature(headers(`sha256=${hmac(secret, body)}`), '{}', secret)).toBe(false)
    expect(verifyGithubSignature(new Headers(), body, secret)).toBe(false)
  })

  it('fails closed on an empty secret', () => {
    expect(verifyGithubSignature(headers(`sha256=${hmac('', body)}`), body, '')).toBe(false)
  })
})

describe('verifyGitlabToken', () => {
  const headers = (token: string) => new Headers({ 'X-Gitlab-Token': token })

  it('accepts the plain secret', () => {
    expect(verifyGitlabToken(headers(secret), body, secret)).toBe(true)
  })

  it('rejects another token, a prefix of the secret and a missing header', () => {
    expect(verifyGitlabToken(headers('webhook-secreT'), body, secret)).toBe(false)
    expect(verifyGitlabToken(headers('webhook'), body, secret)).toBe(false)
    expect(verifyGitlabToken(headers(`${secret}x`), body, secret)).toBe(false)
    expect(verifyGitlabToken(new Headers(), body, secret)).toBe(false)
  })

  it('fails closed on an empty secret', () => {
    expect(verifyGitlabToken(headers(''), body, '')).toBe(false)
  })
})

describe('createGitProvider', () => {
  const config = { baseUrl: 'http://localhost:3300', token: 't' }

  it('builds each provider kind', () => {
    const kinds = (['gitea', 'github', 'gitlab'] as const).map((k) => createGitProvider(k, config))
    expect(kinds.map((p) => p.kind)).toEqual(['gitea', 'github', 'gitlab'])
  })

  it('rejects API calls as not implemented until P8', async () => {
    const gitea = createGitProvider('gitea', config)
    const ref = { provider: 'gitea', owner: 'sites', name: 'shop' } as const
    await expect(gitea.getRepository(ref)).rejects.toMatchObject({
      code: 'NOT_IMPLEMENTED',
      message: expect.stringContaining('GiteaProvider.getRepository (P8)'),
    })
    await expect(gitea.mergePullRequest(ref, 1, 'abc')).rejects.toMatchObject({
      code: 'NOT_IMPLEMENTED',
    })
  })

  it('validates the configuration without echoing the token', () => {
    expect(() => createGitProvider('gitea', { baseUrl: 'ftp://x', token: 'top-secret' })).toThrow(
      /Invalid GiteaProvider configuration/,
    )
    try {
      createGitProvider('github', { baseUrl: 'not a url', token: 'top-secret' })
    } catch (e) {
      expect(String(e)).not.toContain('top-secret')
    }
  })

  it('rejects an unknown kind coming from untyped data', () => {
    expect(() => createGitProvider('bitbucket' as never, config)).toThrow(/Unknown git provider/)
  })
})
