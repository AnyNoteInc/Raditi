import { z } from 'zod'

import {
  gitlabComHost,
  gitNotSupported,
  gitProviderFailed,
  type GitConnect,
  type GitTokens,
  type OAuthApp,
} from '@repo/domain'

import { parseEndpointOverride } from './api.ts'
import { createGitTransport, type GitTransport, type GitTransportOptions } from './transport.ts'

// Sign-in with a provider (docs/plan/84-projects.md, ПР11): `@repo/git-providers/connect`, the one
// part of the package web may import. GitLab OAuth with PKCE (https://docs.gitlab.com/api/oauth2/);
// the GitHub App's user sign-in and the check of an installation come with Э10.

export { createGitTransport }
export type { GitTransport, GitTransportOptions }

export interface GitConnectConfig {
  transport: GitTransport
  /** Stands only: `https://localhost:<port>` instead of https://gitlab.com. */
  gitlabComUrl?: string
}

const tokenSchema = z.looseObject({
  access_token: z.string().min(1).max(4096),
  token_type: z.string().optional(),
  refresh_token: z.string().min(1).max(4096).nullish(),
  expires_in: z.number().int().positive().nullish(),
  created_at: z.number().int().positive().nullish(),
})

export function createGitConnect(kind: 'github' | 'gitlab', config: GitConnectConfig): GitConnect {
  if (kind === 'github')
    return {
      exchangeCode: () => Promise.reject(gitNotSupported('the GitHub App sign-in before Э10')),
      refreshAccess: () => Promise.reject(gitNotSupported('the GitHub App sign-in before Э10')),
    }
  const override = parseEndpointOverride(config.gitlabComUrl)

  const tokenUrl = (app: OAuthApp): URL => {
    const origin =
      app.host === gitlabComHost && override !== null ? override : new URL(`https://${app.host}`)
    const url = new URL(origin)
    url.pathname = '/oauth/token'
    return url
  }

  const post = async (app: OAuthApp, form: Record<string, string>) => {
    const response = await config.transport.session().request({
      method: 'POST',
      url: tokenUrl(app),
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: app.clientId,
        client_secret: app.clientSecret,
        redirect_uri: app.redirectUri,
        ...form,
      }).toString(),
    })
    let body: unknown = null
    try {
      body = JSON.parse(response.body.toString('utf8'))
    } catch {
      // judged by the status below
    }
    return { status: response.status, body }
  }

  const tokensOf = (body: unknown, status: number): GitTokens => {
    const parsed = tokenSchema.safeParse(body)
    if (status !== 200 || !parsed.success)
      throw gitProviderFailed('the token endpoint refused', status)
    const t = parsed.data
    const issuedAt = t.created_at == null ? Date.now() : t.created_at * 1000
    return {
      accessToken: t.access_token,
      refreshToken: t.refresh_token ?? null,
      expiresAt: t.expires_in == null ? null : new Date(issuedAt + t.expires_in * 1000),
    }
  }

  return {
    async exchangeCode(app, code, verifier) {
      const { status, body } = await post(app, {
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
      })
      return tokensOf(body, status)
    },
    async refreshAccess(app, refreshToken) {
      const { status, body } = await post(app, {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      })
      // A refresh revokes the old pair (§1): a refused grant means a new sign-in, nothing else.
      const error = z.looseObject({ error: z.string() }).safeParse(body)
      if (
        (status === 400 || status === 401) &&
        error.success &&
        error.data.error === 'invalid_grant'
      )
        return { reauth: true }
      return tokensOf(body, status)
    },
  }
}
