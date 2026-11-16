import 'server-only'

import { createHash, randomBytes } from 'node:crypto'

import {
  isDomainError,
  type GitConnect,
  type OAuthApp,
  type VerifiedInstallation,
} from '@repo/domain'
import { z } from 'zod'

import {
  GIT_SIGN_IN_TTL_MS,
  githubSignInRoute,
  gitSignInCookie,
  gitSignInCookieOf,
  openGitSignIn,
  sealGitSignIn,
  type SealedGitSignIn,
} from '@/server/git-sign-in-cookie'

// The connection of the GitHub App (docs/plan/84-projects.md, ПР10, §4.3; slice 84.25), in two
// steps under one sealed cookie of these routes (`HttpOnly`, `SameSite=Lax`, ten minutes):
// 1. `GET /api/git/github/start?project=<id>` — the project is the user's; web seals the state and
//    a PKCE verifier and sends the browser to install the app on github.com
//    (`/apps/<slug>/installations/new?state=…`).
// 2. github.com returns to `GET /api/git/github/callback` with `installation_id` and `setup_action`
//    (the app's Setup URL). That id proves nothing — anyone can open the address with another one
//    (https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-setup-url)
//    — so web keeps it in the cookie and sends the browser through the sign-in of the app's user
//    with its own state and PKCE (`/login/oauth/authorize`). github.com returns with a `code`: the
//    state must be the cookie's and the user the same; web exchanges the code, checks by that
//    user's own token that the installation is among theirs, takes only the repositories where
//    they may push (`verifyInstallation` of @repo/git-providers/connect), writes the connection
//    with their GitHub id (`connectGithubApp`) and forgets the token. `setup_action=request` — an
//    organisation's owner has to approve the installation first.

/** What the page of the project reads from its address after the return. */
export type GithubSignInOutcome =
  | 'connected'
  | 'expired'
  | 'github-refused'
  | 'github-failed'
  | 'github-unavailable'
  | 'github-requested'

export interface GithubSignInDependencies {
  appUrl(): string
  /** BETTER_AUTH_SECRET: the key of the sealed cookie is derived from it. */
  secret(): string
  now(): number
  userOf(headers: Headers): Promise<string | null>
  /** The project is the user's and alive: `projectRepo.get` as the user; throws its refusal. */
  checkProject(headers: Headers, projectId: string): Promise<void>
  /**
   * Raditi's GitHub App and where the pages of github.com are (a fake of a stand outside
   * production); null — «Подключить GitHub» is not offered here.
   */
  github(): { slug: string; app: Omit<OAuthApp, 'redirectUri'>; webOrigin: string } | null
  connect(): GitConnect
  /** connectGithubApp of @repo/trpc. */
  save(input: {
    userId: string
    installation: VerifiedInstallation
    ip: string | null
  }): Promise<{ connectionId: string }>
  clientIp(headers: Headers): string | null
}

const projectIdSchema = z.uuid()
const installationIdSchema = z.string().regex(/^[1-9][0-9]{0,19}$/)

export const githubCallbackOf = (app: string) => `${app}/api/git/github/callback`

function redirect(location: string, cookie: string): Response {
  return new Response(null, {
    status: 303,
    headers: { location, 'set-cookie': cookie, 'cache-control': 'no-store' },
  })
}

export async function startGithubSignIn(
  request: Request,
  deps: GithubSignInDependencies,
): Promise<Response> {
  const app = deps.appUrl()
  const secure = app.startsWith('https://')
  const cleared = gitSignInCookie(null, secure, githubSignInRoute)
  const userId = await deps.userOf(request.headers)
  if (userId === null) return redirect(`${app}/projects?git=expired`, cleared)
  const project = projectIdSchema.safeParse(new URL(request.url).searchParams.get('project'))
  if (!project.success) return redirect(`${app}/projects?git=expired`, cleared)
  const projectId = project.data.toLowerCase()
  const github = deps.github()
  if (github === null)
    return redirect(`${app}/projects/${projectId}?git=github-unavailable`, cleared)
  try {
    await deps.checkProject(request.headers, projectId)
  } catch (error) {
    if (isDomainError(error) || (error as { code?: unknown } | null)?.code !== undefined)
      return redirect(`${app}/projects?git=github-refused`, cleared)
    throw error
  }
  const state = randomBytes(24).toString('base64url')
  const sealed = sealGitSignIn(
    {
      userId,
      projectId,
      state,
      verifier: randomBytes(32).toString('base64url'),
      expiresAt: deps.now() + GIT_SIGN_IN_TTL_MS,
    },
    deps.secret(),
  )
  const install = new URL(`/apps/${github.slug}/installations/new`, github.webOrigin)
  install.searchParams.set('state', state)
  return redirect(install.href, gitSignInCookie(sealed, secure, githubSignInRoute))
}

export async function finishGithubSignIn(
  request: Request,
  deps: GithubSignInDependencies,
): Promise<Response> {
  const app = deps.appUrl()
  const secure = app.startsWith('https://')
  const cleared = gitSignInCookie(null, secure, githubSignInRoute)
  const sealed = openGitSignIn(
    gitSignInCookieOf(request.headers, githubSignInRoute),
    deps.secret(),
    deps.now(),
  )
  // «Начните подключение из Радити»: a return without this browser's own start.
  if (sealed === null) return redirect(`${app}/projects?git=expired`, cleared)
  const back = (outcome: GithubSignInOutcome, extra = '') =>
    redirect(`${app}/projects/${sealed.projectId}?git=${outcome}${extra}`, cleared)
  if ((await deps.userOf(request.headers)) !== sealed.userId) return back('github-refused')
  const github = deps.github()
  if (github === null) return back('github-unavailable')
  const params = new URL(request.url).searchParams
  if (params.get('error') !== null) return back('github-refused')
  // A state GitHub passed back must be ours; on the return of an installation it may be absent.
  const state = params.get('state')
  if (state !== null && state !== sealed.state) return back('github-refused')
  const code = params.get('code')
  if (code === null) return afterInstallation(params, sealed, app, secure, github, deps, back)
  if (code.length > 1024 || state === null || sealed.installationId === undefined)
    return back('github-refused')
  const oauth: OAuthApp = { ...github.app, redirectUri: githubCallbackOf(app) }
  try {
    const connect = deps.connect()
    const tokens = await connect.exchangeCode(oauth, code, sealed.verifier)
    const installation = connect.verifyInstallation
      ? await connect.verifyInstallation(tokens.accessToken, sealed.installationId)
      : null
    // Not among the installations this user sees: a forged or foreign `installation_id`.
    if (installation === null) return back('github-refused')
    const { connectionId } = await deps.save({
      userId: sealed.userId,
      installation,
      ip: deps.clientIp(request.headers),
    })
    return back('connected', `&connection=${connectionId}`)
  } catch (error) {
    if (isDomainError(error))
      return back(error.code === 'GIT_CONNECT_UNAVAILABLE' ? 'github-unavailable' : 'github-failed')
    throw error
  }
}

/**
 * The return of an installation (the Setup URL): its id is kept in the cookie, and the browser goes
 * through the sign-in of the app's user, by which it is checked.
 */
function afterInstallation(
  params: URLSearchParams,
  sealed: SealedGitSignIn,
  app: string,
  secure: boolean,
  github: { app: Omit<OAuthApp, 'redirectUri'>; webOrigin: string },
  deps: GithubSignInDependencies,
  back: (outcome: GithubSignInOutcome) => Response,
): Response {
  const action = params.get('setup_action')
  // An owner of the organisation has to approve the installation the user asked for.
  if (action === 'request') return back('github-requested')
  const installation = installationIdSchema.safeParse(params.get('installation_id'))
  if ((action !== 'install' && action !== 'update') || !installation.success)
    return back('github-refused')
  const next = sealGitSignIn({ ...sealed, installationId: installation.data }, deps.secret())
  const authorize = new URL('/login/oauth/authorize', github.webOrigin)
  for (const [name, value] of Object.entries({
    client_id: github.app.clientId,
    redirect_uri: githubCallbackOf(app),
    state: sealed.state,
    code_challenge: createHash('sha256').update(sealed.verifier).digest('base64url'),
    code_challenge_method: 'S256',
  }))
    authorize.searchParams.set(name, value)
  return redirect(authorize.href, gitSignInCookie(next, secure, githubSignInRoute))
}
