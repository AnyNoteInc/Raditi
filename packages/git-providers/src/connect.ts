import { z } from 'zod'

import {
  githubHost,
  gitlabComHost,
  gitProviderFailed,
  isRepoPath,
  repoCloneUrl,
  repoWebUrl,
  sameHostUrl,
  type GitConnect,
  type GitTokens,
  type OAuthApp,
  type RepositoryInfo,
} from '@repo/domain'

import { parseEndpointOverride } from './api.ts'
import { createGitTransport, type GitTransport, type GitTransportOptions } from './transport.ts'

// Sign-in with a provider (docs/plan/84-projects.md, ПР11): `@repo/git-providers/connect`, the one
// part of the package web may import. GitLab OAuth with PKCE (https://docs.gitlab.com/api/oauth2/);
// the GitHub App's sign-in of its user — the web application flow with PKCE
// (https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)
// — and the check of an installation by that user's token (slice 84.25): the `installation_id` of
// a return can be forged, the user's own list of installations cannot.

export { createGitTransport }
export type { GitTransport, GitTransportOptions }
// web's part of the variables of the git apps (§4.5)
export {
  DEV_REPO_CONFIRM_SECRET,
  webGitAppsFromEnv,
  type GitAppsConfig,
  type GithubAppWebCredentials,
  type GitlabOauthCredentials,
} from './config.ts'

export interface GitConnectConfig {
  transport: GitTransport
  /** Stands only: `https://localhost:<port>` instead of https://gitlab.com. */
  gitlabComUrl?: string
  /** Stands only: `https://localhost:<port>` instead of https://api.github.com. */
  githubApiUrl?: string
  /** Stands only: `https://localhost:<port>` instead of https://github.com (its sign-in pages). */
  githubWebUrl?: string
}

/** Installations and their repositories a check reads at most (100 a page). */
const GITHUB_PAGES = 10

const tokenSchema = z.looseObject({
  access_token: z.string().min(1).max(4096),
  token_type: z.string().optional(),
  refresh_token: z.string().min(1).max(4096).nullish(),
  expires_in: z.number().int().positive().nullish(),
  created_at: z.number().int().positive().nullish(),
})

export function createGitConnect(kind: 'github' | 'gitlab', config: GitConnectConfig): GitConnect {
  if (kind === 'github') return createGithubConnect(config)
  const override = parseEndpointOverride(config.gitlabComUrl)

  const urlOf = (app: OAuthApp, pathname: string): URL => {
    const origin =
      app.host === gitlabComHost && override !== null ? override : new URL(`https://${app.host}`)
    const url = new URL(origin)
    url.pathname = pathname
    return url
  }
  const tokenUrl = (app: OAuthApp): URL => urlOf(app, '/oauth/token')

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
    async signedInUser(app, accessToken) {
      // `GET /api/v4/user` — the one call of the sign-in besides the token (the whitelist of ПР10).
      const response = await config.transport.session().request({
        method: 'GET',
        url: urlOf(app, '/api/v4/user'),
        headers: { accept: 'application/json', authorization: `Bearer ${accessToken}` },
      })
      let body: unknown = null
      try {
        body = JSON.parse(response.body.toString('utf8'))
      } catch {
        // judged below
      }
      const user = z
        .looseObject({ id: z.number().int().positive(), username: z.string().min(1).max(100) })
        .safeParse(body)
      if (response.status !== 200 || !user.success)
        throw gitProviderFailed('the user of the sign-in', response.status)
      return { login: user.data.username, id: String(user.data.id) }
    },
  }
}

const githubHeaders = {
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'Raditi',
}

function parsed(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString('utf8'))
  } catch {
    return null
  }
}

/**
 * The sign-in of the user of the GitHub App and the check of an installation. The user's token is
 * used for these few requests only and never kept (ПР10).
 */
function createGithubConnect(config: GitConnectConfig): GitConnect {
  const web = parseEndpointOverride(config.githubWebUrl) ?? new URL(`https://${githubHost}`)
  const api = parseEndpointOverride(config.githubApiUrl) ?? new URL('https://api.github.com')

  const tokenUrl = () => {
    const url = new URL(web)
    url.pathname = '/login/oauth/access_token'
    return url
  }
  const apiGet = async (token: string, pathname: string, query: Record<string, string> = {}) => {
    const url = new URL(api)
    url.pathname = pathname
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value)
    const response = await config.transport.session().request({
      method: 'GET',
      url,
      headers: { ...githubHeaders, authorization: `Bearer ${token}` },
    })
    return { status: response.status, body: parsed(response.body) }
  }
  const tokens = async (form: Record<string, string>): Promise<GitTokens | { reauth: true }> => {
    const response = await config.transport.session().request({
      method: 'POST',
      url: tokenUrl(),
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    })
    const body = parsed(response.body)
    // GitHub answers a refused code or refresh token with 200 and an `error`.
    const error = z.looseObject({ error: z.string() }).safeParse(body)
    if (error.success && error.data.error === 'bad_refresh_token') return { reauth: true }
    const t = tokenSchema.safeParse(body)
    if (response.status !== 200 || !t.success || error.success)
      throw gitProviderFailed('the token endpoint refused', response.status)
    return {
      accessToken: t.data.access_token,
      refreshToken: t.data.refresh_token ?? null,
      expiresAt: t.data.expires_in == null ? null : new Date(Date.now() + t.data.expires_in * 1000),
    }
  }

  const userOf = async (token: string) => {
    const { status, body } = await apiGet(token, '/user')
    const user = z
      .looseObject({ id: z.number().int().positive(), login: z.string().min(1).max(100) })
      .safeParse(body)
    if (status !== 200 || !user.success) throw gitProviderFailed('the user of the sign-in', status)
    return { login: user.data.login, id: String(user.data.id) }
  }

  const repositorySchema = z.looseObject({
    id: z.number().int().positive(),
    full_name: z.string(),
    default_branch: z.string().nullish(),
    private: z.boolean(),
    html_url: z.unknown().optional(),
    size: z.number().nonnegative().nullish(),
    permissions: z
      .looseObject({
        push: z.boolean().optional(),
        maintain: z.boolean().optional(),
        admin: z.boolean().optional(),
      })
      .nullish(),
  })

  return {
    async exchangeCode(app, code, verifier) {
      const answer = await tokens({
        client_id: app.clientId,
        client_secret: app.clientSecret,
        code,
        redirect_uri: app.redirectUri,
        code_verifier: verifier,
      })
      if ('reauth' in answer) throw gitProviderFailed('the token endpoint refused the code')
      return answer
    },
    refreshAccess(app, refreshToken) {
      return tokens({
        client_id: app.clientId,
        client_secret: app.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      })
    },
    signedInUser: (_app, accessToken) => userOf(accessToken),

    async verifyInstallation(userToken, installationId) {
      if (!/^[1-9][0-9]{0,19}$/.test(installationId)) return null
      const user = await userOf(userToken)
      // https://docs.github.com/en/rest/apps/installations#list-app-installations-accessible-to-the-user-access-token
      let account: { login: string; id: string } | null = null
      for (let page = 1; page <= GITHUB_PAGES && account === null; page++) {
        const { status, body } = await apiGet(userToken, '/user/installations', {
          per_page: '100',
          page: String(page),
        })
        const list = z
          .looseObject({
            total_count: z.number().int().nonnegative(),
            installations: z.array(
              z.looseObject({
                id: z.number().int().positive(),
                account: z
                  .looseObject({
                    id: z.number().int().positive(),
                    login: z.string().min(1).max(100),
                  })
                  .nullable(),
              }),
            ),
          })
          .safeParse(body)
        if (status !== 200 || !list.success) throw gitProviderFailed('installations', status)
        const found = list.data.installations.find((item) => String(item.id) === installationId)
        if (found?.account) account = { login: found.account.login, id: String(found.account.id) }
        if (page * 100 >= list.data.total_count || list.data.installations.length === 0) break
      }
      if (account === null) return null
      // Only the repositories where this user may push are offered (ПР10): the installation's
      // token acts on all of them, the user may only read some.
      const repositories: RepositoryInfo[] = []
      for (let page = 1; page <= GITHUB_PAGES; page++) {
        const { status, body } = await apiGet(
          userToken,
          `/user/installations/${installationId}/repositories`,
          { per_page: '100', page: String(page) },
        )
        const list = z
          .looseObject({
            total_count: z.number().int().nonnegative(),
            repositories: z.array(z.unknown()),
          })
          .safeParse(body)
        if (status !== 200 || !list.success) throw gitProviderFailed('repositories', status)
        for (const raw of list.data.repositories) {
          const repo = repositorySchema.safeParse(raw)
          if (!repo.success || !isRepoPath('github', repo.data.full_name)) continue
          const rights = repo.data.permissions ?? {}
          if (rights.push !== true && rights.maintain !== true && rights.admin !== true) continue
          const ref = {
            provider: 'github' as const,
            host: githubHost,
            path: repo.data.full_name,
            providerRepoId: String(repo.data.id),
          }
          repositories.push({
            ref,
            defaultBranch: repo.data.default_branch ?? 'main',
            private: repo.data.private,
            webUrl: sameHostUrl(githubHost, repo.data.html_url, repoWebUrl(ref)),
            cloneUrl: repoCloneUrl(ref),
            sizeBytes: typeof repo.data.size === 'number' ? repo.data.size * 1024 : null,
          })
        }
        if (page * 100 >= list.data.total_count || list.data.repositories.length === 0) break
      }
      return { installationId, account, user, repositories }
    },
  }
}
