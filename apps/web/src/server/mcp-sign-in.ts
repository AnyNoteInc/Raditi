import 'server-only'

import { isDomainError } from '@repo/domain'
import { z } from 'zod'

import { McpOAuthRefused, type McpOAuthClient, type SignInTokens } from '@/server/mcp-oauth'
import {
  MCP_SIGN_IN_COOKIE,
  MCP_SIGN_IN_TTL_MS,
  openSignIn,
  sealSignIn,
  signInCookie,
  type SealedSignIn,
} from '@/server/mcp-sign-in-cookie'
import { refusedCrossOriginPost } from '@/server/trpc-origin'

// The two steps of a sign-in to an MCP server (docs/plan/81-mcp-server-credentials.md, §3.4):
// `POST /api/mcp-oauth/start` — the cabinet asks it, the procedure checks the site and the name,
// web finds where the server signs in and answers the address the owner's browser goes to;
// `GET /api/mcp-oauth/callback` — the server of sign-in sends the owner back with a code, web
// exchanges it for tokens and connects the server. Both answer nothing secret.

/** A site, a name and an address: far less than this. */
export const MAX_MCP_SIGN_IN_BODY_BYTES = 4 * 1024

/** The outcome the settings page reads from its address after the return. */
export type SignInOutcome = 'signed-in' | 'refused' | 'expired' | 'failed' | 'unavailable'

export interface McpSignInDependencies {
  appUrl(): string
  /** BETTER_AUTH_SECRET: the key of the sealed cookie is derived from it. */
  secret(): string
  now(): number
  /** The signed-in user of a request, or null. */
  userOf(headers: Headers): Promise<string | null>
  /**
   * `agentSkills.signInCheck` as the user: the workspace, the kept name and address, or its
   * refusal. Without a workspace it is the user's personal one (plan 83, БП11).
   */
  check(
    headers: Headers,
    input: { workspaceId?: string; name: string; url: string },
  ): Promise<{ workspaceId: string; name: string; url: string }>
  client(): McpOAuthClient
  /** connectSignedInServer of @repo/trpc with the app's Vault and check of a server. */
  connect(input: {
    userId: string
    workspaceId: string
    name: string
    url: string
    ip: string | null
    tokens: SignInTokens & { clientSecret?: string }
    oauth: {
      issuer: string
      tokenEndpoint: string
      clientId: string
      resource: string
      scope?: string
    }
  }): Promise<void>
  clientIp(headers: Headers): string | null
}

const startInput = z.strictObject({
  workspaceId: z.uuid().optional(),
  name: z.string().min(1).max(64),
  url: z.string().min(1).max(1024),
})

/** A refusal the cabinet shows: the procedure's own Russian text, or a reason of the sign-in. */
const answer = (status: number, body: Record<string, string>, cookie?: string) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      ...(cookie ? { 'set-cookie': cookie } : {}),
    },
  })

/** The status of a refusal of the procedure, by the tRPC code its error carries. */
function statusOf(error: unknown): number {
  const code = (error as { code?: unknown } | null)?.code
  if (code === 'UNAUTHORIZED') return 401
  if (code === 'FORBIDDEN') return 403
  if (code === 'NOT_FOUND') return 404
  if (code === 'CONFLICT') return 409
  if (code === 'BAD_REQUEST') return 400
  return 500
}

export async function startSignIn(
  request: Request,
  deps: McpSignInDependencies,
): Promise<Response> {
  const app = deps.appUrl()
  if (refusedCrossOriginPost(request, app)) return new Response(null, { status: 403 })
  const userId = await deps.userOf(request.headers)
  if (userId === null) return answer(401, { reason: 'unauthorized' })
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return answer(400, { reason: 'invalid' })
  }
  const input = startInput.safeParse(body)
  if (!input.success) return answer(400, { reason: 'invalid' })
  let kept: { workspaceId: string; name: string; url: string }
  try {
    kept = await deps.check(request.headers, input.data)
  } catch (error) {
    const status = statusOf(error)
    if (status === 500) throw error
    return answer(status, { message: (error as Error).message })
  }
  try {
    const { authorizationUrl, pending } = await deps
      .client()
      .start(kept.url, `${app}/api/mcp-oauth/callback`)
    const sealed: SealedSignIn = {
      workspaceId: kept.workspaceId,
      name: kept.name,
      userId,
      expiresAt: deps.now() + MCP_SIGN_IN_TTL_MS,
      pending,
    }
    return answer(
      200,
      { authorizationUrl },
      signInCookie(sealSignIn(sealed, deps.secret()), app.startsWith('https://')),
    )
  } catch (error) {
    if (error instanceof McpOAuthRefused) return answer(422, { reason: error.reason })
    throw error
  }
}

function cookieOf(headers: Headers): string | undefined {
  for (const part of (headers.get('cookie') ?? '').split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name === MCP_SIGN_IN_COOKIE) return rest.join('=')
  }
  return undefined
}

export async function finishSignIn(
  request: Request,
  deps: McpSignInDependencies,
): Promise<Response> {
  const app = deps.appUrl()
  const secure = app.startsWith('https://')
  const cleared = signInCookie(null, secure)
  const back = (path: string) =>
    new Response(null, {
      status: 303,
      headers: { location: `${app}${path}`, 'set-cookie': cleared, 'cache-control': 'no-store' },
    })
  const sealed = openSignIn(cookieOf(request.headers), deps.secret(), deps.now())
  if (sealed === null) return back('/settings/connections?mcp=expired')
  const settings = (outcome: SignInOutcome) =>
    back(`/settings/connections?mcp=${outcome}&skill=${encodeURIComponent(sealed.name)}`)
  const params = new URL(request.url).searchParams
  const code = params.get('code')
  // The state ties the return to this browser's own start: another one is refused.
  if (params.get('error') !== null || code === null || params.get('state') !== sealed.pending.state)
    return settings('refused')
  if ((await deps.userOf(request.headers)) !== sealed.userId) return settings('refused')
  try {
    const tokens = await deps.client().finish(sealed.pending, code)
    await deps.connect({
      userId: sealed.userId,
      workspaceId: sealed.workspaceId,
      name: sealed.name,
      url: sealed.pending.url,
      ip: deps.clientIp(request.headers),
      tokens: {
        ...tokens,
        ...(sealed.pending.clientSecret ? { clientSecret: sealed.pending.clientSecret } : {}),
      },
      oauth: {
        issuer: sealed.pending.issuer,
        tokenEndpoint: sealed.pending.tokenEndpoint,
        clientId: sealed.pending.clientId,
        resource: sealed.pending.url,
        ...((tokens.scope ?? sealed.pending.scope)
          ? { scope: tokens.scope ?? sealed.pending.scope }
          : {}),
      },
    })
    return settings('signed-in')
  } catch (error) {
    if (error instanceof McpOAuthRefused) return settings('failed')
    // A refusal of the domain: the server, the workspace or the name — said on the page, not thrown.
    if (isDomainError(error))
      return settings(error.code === 'AGENT_SKILL_AUTH_UNAVAILABLE' ? 'unavailable' : 'failed')
    throw error
  }
}
