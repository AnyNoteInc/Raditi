import 'server-only'

import { artifactLinkTokenSchema } from '@repo/domain/artifacts'

// The page /a of a link (docs/plan/88-artifacts.md, Ар33; spike 8): the token lives in the
// fragment, which no browser sends to the server. Signed out, the page posts it here once and it
// waits an hour in `__Host-raditi_share` for the sign-in; signed in, «Открыть» posts it (or the
// cookie brings it) and the link opens by the procedure of the owner's rules.

export const SHARE_COOKIE = '__Host-raditi_share'
/** A token in JSON is some 60 bytes: a larger body is refused before it is read whole. */
export const MAX_SHARE_BODY_BYTES = 1024
const HOUR_S = 60 * 60

const noStore = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }

async function tokenOf(request: Request): Promise<string | null> {
  try {
    const body = (await request.json()) as { token?: unknown }
    const parsed = artifactLinkTokenSchema.safeParse(body?.token)
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export function heldToken(cookieHeader: string | null): string | null {
  for (const part of (cookieHeader ?? '').split(';')) {
    const [name, ...value] = part.trim().split('=')
    if (name === SHARE_COOKIE) {
      const parsed = artifactLinkTokenSchema.safeParse(value.join('='))
      return parsed.success ? parsed.data : null
    }
  }
  return null
}

const cookie = (token: string, maxAge: number) =>
  `${SHARE_COOKIE}=${token}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`

/** «Войти, чтобы открыть»: the token waits an hour in an HttpOnly cookie of this host. */
export async function holdShareToken(request: Request, open: boolean): Promise<Response> {
  if (!open) return new Response(null, { status: 404, headers: noStore })
  const token = await tokenOf(request)
  if (token === null) return new Response(null, { status: 400, headers: noStore })
  return new Response(null, {
    status: 204,
    headers: { ...noStore, 'Set-Cookie': cookie(token, HOUR_S) },
  })
}

export type ShareOpener = (token: string) => Promise<{ artifactId: string }>

/**
 * «Открыть»: the token of the body, or the one the cookie holds; the cookie goes either way. The
 * refusals are the procedure's codes, never told apart further (Ар23).
 */
export async function openSharedArtifact(
  request: Request,
  deps: { open: boolean; opener: ShareOpener },
): Promise<Response> {
  if (!deps.open) return new Response(null, { status: 404, headers: noStore })
  const token = (await tokenOf(request)) ?? heldToken(request.headers.get('cookie'))
  const clear = { ...noStore, 'Set-Cookie': cookie('', 0), 'Content-Type': 'application/json' }
  if (token === null)
    return new Response(JSON.stringify({ code: 'ARTIFACT_LINK_GONE' }), {
      status: 404,
      headers: clear,
    })
  try {
    const { artifactId } = await deps.opener(token)
    return new Response(JSON.stringify({ artifactId }), { status: 200, headers: clear })
  } catch (error) {
    const data = (error as { cause?: { code?: string }; code?: string }) ?? {}
    const code = data.cause?.code ?? data.code ?? 'ARTIFACT_LINK_GONE'
    const status = code === 'TOO_MANY_REQUESTS' ? 429 : code === 'UNAUTHORIZED' ? 401 : 404
    return new Response(JSON.stringify({ code }), {
      status,
      headers:
        status === 429 || status === 401
          ? { ...noStore, 'Content-Type': 'application/json' }
          : clear,
    })
  }
}
