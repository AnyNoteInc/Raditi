import 'server-only'

import { createHash, randomBytes } from 'node:crypto'

import { isDomainError, type GitConnect, type OAuthApp } from '@repo/domain'
import { z } from 'zod'

import {
  GIT_SIGN_IN_TTL_MS,
  gitSignInCookie,
  gitSignInCookieOf,
  openGitSignIn,
  sealGitSignIn,
} from '@/server/git-sign-in-cookie'
import { refusedCrossOriginPost } from '@/server/trpc-origin'

// The sign-in on gitlab.com (docs/plan/84-projects.md, ПР10, §4.3; slice 84.17):
// `POST /api/git/gitlab/start` — the page of a project asks it; web checks the project is the
// user's, seals the PKCE verifier (S256) and the state in a cookie of these routes and answers the
// address of gitlab.com the browser goes to; `GET /api/git/gitlab/callback` — gitlab.com sends the
// client back with a code: the state must be the cookie's, the user the same, then web exchanges
// the code (`exchangeCode` of @repo/git-providers/connect), asks who signed in and writes the
// tokens to Vault without reading them back (`connectGitlabOAuth`). Nothing secret is answered.

export const MAX_GIT_SIGN_IN_BODY_BYTES = 1024

/** The scopes of the OAuth app of Raditi (ПР10): the API and git writing. */
export const GITLAB_SCOPES = 'api write_repository'

/** What the page of the project reads from its address after the return. */
export type GitSignInOutcome = 'connected' | 'refused' | 'expired' | 'failed' | 'unavailable'

export interface GitSignInDependencies {
  appUrl(): string
  /** BETTER_AUTH_SECRET: the key of the sealed cookie is derived from it. */
  secret(): string
  now(): number
  userOf(headers: Headers): Promise<string | null>
  /** The project is the user's and alive: `projectRepo.get` as the user; throws its refusal. */
  checkProject(headers: Headers, projectId: string): Promise<void>
  /**
   * Raditi's app on gitlab.com and where its pages are (a fake of a stand outside production);
   * null — «Подключить GitLab.com» is not offered here (not configured, or «Скоро», ПР29).
   */
  gitlab(): { app: Omit<OAuthApp, 'redirectUri'>; authorizeOrigin: string } | null
  connect(): GitConnect
  /** connectGitlabOAuth of @repo/trpc with the app's Vault. */
  save(input: {
    userId: string
    account: { login: string; id: string }
    tokens: { accessToken: string; refreshToken: string | null; expiresAt: Date | null }
    ip: string | null
  }): Promise<void>
  clientIp(headers: Headers): string | null
}

const startInput = z.strictObject({ projectId: z.uuid() })

const json = (status: number, body: Record<string, string>, cookie?: string) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      ...(cookie ? { 'set-cookie': cookie } : {}),
    },
  })

function statusOf(error: unknown): number {
  const code = (error as { code?: unknown } | null)?.code
  if (code === 'UNAUTHORIZED') return 401
  if (code === 'FORBIDDEN') return 403
  if (code === 'NOT_FOUND') return 404
  if (code === 'CONFLICT') return 409
  if (code === 'BAD_REQUEST') return 400
  return 500
}

const callbackOf = (app: string) => `${app}/api/git/gitlab/callback`

export async function startGitlabSignIn(
  request: Request,
  deps: GitSignInDependencies,
): Promise<Response> {
  const app = deps.appUrl()
  if (refusedCrossOriginPost(request, app)) return new Response(null, { status: 403 })
  const userId = await deps.userOf(request.headers)
  if (userId === null) return json(401, { reason: 'unauthorized' })
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json(400, { reason: 'invalid' })
  }
  const input = startInput.safeParse(body)
  if (!input.success) return json(400, { reason: 'invalid' })
  const gitlab = deps.gitlab()
  if (gitlab === null) return json(503, { reason: 'unavailable' })
  try {
    await deps.checkProject(request.headers, input.data.projectId)
  } catch (error) {
    const status = statusOf(error)
    if (status === 500) throw error
    return json(status, { message: (error as Error).message })
  }
  const verifier = randomBytes(32).toString('base64url')
  const state = randomBytes(24).toString('base64url')
  const authorization = new URL('/oauth/authorize', gitlab.authorizeOrigin)
  for (const [name, value] of Object.entries({
    client_id: gitlab.app.clientId,
    redirect_uri: callbackOf(app),
    response_type: 'code',
    state,
    scope: GITLAB_SCOPES,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  }))
    authorization.searchParams.set(name, value)
  const sealed = sealGitSignIn(
    {
      userId,
      projectId: input.data.projectId.toLowerCase(),
      state,
      verifier,
      expiresAt: deps.now() + GIT_SIGN_IN_TTL_MS,
    },
    deps.secret(),
  )
  return json(
    200,
    { authorizationUrl: authorization.href },
    gitSignInCookie(sealed, app.startsWith('https://')),
  )
}

export async function finishGitlabSignIn(
  request: Request,
  deps: GitSignInDependencies,
): Promise<Response> {
  const app = deps.appUrl()
  const cleared = gitSignInCookie(null, app.startsWith('https://'))
  const back = (path: string) =>
    new Response(null, {
      status: 303,
      headers: { location: `${app}${path}`, 'set-cookie': cleared, 'cache-control': 'no-store' },
    })
  const sealed = openGitSignIn(gitSignInCookieOf(request.headers), deps.secret(), deps.now())
  // «Начните подключение из Радити»: a return without this browser's own start.
  if (sealed === null) return back('/projects?git=expired')
  const project = (outcome: GitSignInOutcome) =>
    back(`/projects/${sealed.projectId}?git=${outcome}`)
  const params = new URL(request.url).searchParams
  const code = params.get('code')
  if (
    params.get('error') !== null ||
    code === null ||
    code.length > 1024 ||
    params.get('state') !== sealed.state
  )
    return project('refused')
  if ((await deps.userOf(request.headers)) !== sealed.userId) return project('refused')
  const gitlab = deps.gitlab()
  if (gitlab === null) return project('unavailable')
  const oauth: OAuthApp = { ...gitlab.app, redirectUri: callbackOf(app) }
  try {
    const connect = deps.connect()
    const tokens = await connect.exchangeCode(oauth, code, sealed.verifier)
    const account = await connect.signedInUser(oauth, tokens.accessToken)
    await deps.save({
      userId: sealed.userId,
      account,
      tokens,
      ip: deps.clientIp(request.headers),
    })
    return project('connected')
  } catch (error) {
    if (isDomainError(error))
      return project(error.code === 'GIT_CONNECT_UNAVAILABLE' ? 'unavailable' : 'failed')
    throw error
  }
}
