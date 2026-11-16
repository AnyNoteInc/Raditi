import 'server-only'

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

import { z } from 'zod'

// A sign-in on gitlab.com between its start and the client's return (docs/plan/84-projects.md,
// ПР10, §4.3): the PKCE verifier, the state, the user and the project it started from — sealed in
// a cookie of the path of these routes for ten minutes (`HttpOnly`, `SameSite=Lax`), never kept in
// the base. AES-256-GCM under a key of its own derived from BETTER_AUTH_SECRET, as the sign-in of
// an MCP server (mcp-sign-in-cookie.ts).

export const GIT_SIGN_IN_COOKIE = 'raditi_git_sign_in'
export const GIT_SIGN_IN_PATH = '/api/git/gitlab'
export const GIT_SIGN_IN_TTL_MS = 10 * 60_000
const KEY_INFO = 'raditi-git-sign-in-v1'

/** The installation of the GitHub App between its return and the sign-in of its user (84.25). */
export const GITHUB_SIGN_IN_COOKIE = 'raditi_github_sign_in'
export const GITHUB_SIGN_IN_PATH = '/api/git/github'

/** Which sign-in a cookie is of: its name and the path of its routes. */
export interface GitSignInRoute {
  name: string
  path: string
}
export const gitlabSignInRoute: GitSignInRoute = {
  name: GIT_SIGN_IN_COOKIE,
  path: GIT_SIGN_IN_PATH,
}
export const githubSignInRoute: GitSignInRoute = {
  name: GITHUB_SIGN_IN_COOKIE,
  path: GITHUB_SIGN_IN_PATH,
}

export const sealedGitSignInSchema = z.strictObject({
  userId: z.string().min(1).max(128),
  projectId: z.uuid(),
  state: z.string().min(16).max(128),
  verifier: z.string().min(43).max(128),
  expiresAt: z.number().int(),
  /**
   * GitHub: the installation its return named, kept until the user signs in and the installation
   * is checked by their own token (ПР10) — it proves nothing by itself.
   */
  installationId: z
    .string()
    .regex(/^[1-9][0-9]{0,19}$/)
    .optional(),
})
export type SealedGitSignIn = z.infer<typeof sealedGitSignInSchema>

const keyOf = (secret: string) =>
  Buffer.from(hkdfSync('sha256', Buffer.from(secret), Buffer.alloc(0), KEY_INFO, 32))

export function sealGitSignIn(value: SealedGitSignIn, secret: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', keyOf(secret), iv)
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url')
}

/** The sealed sign-in, or null for one that is broken, forged or past its ten minutes. */
export function openGitSignIn(
  token: string | undefined,
  secret: string,
  now: number,
): SealedGitSignIn | null {
  if (token === undefined || token.length > 4096) return null
  try {
    const raw = Buffer.from(token, 'base64url')
    if (raw.length < 29) return null
    const decipher = createDecipheriv('aes-256-gcm', keyOf(secret), raw.subarray(0, 12))
    decipher.setAuthTag(raw.subarray(12, 28))
    const text = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString(
      'utf8',
    )
    const parsed = sealedGitSignInSchema.safeParse(JSON.parse(text))
    if (!parsed.success || parsed.data.expiresAt <= now) return null
    return parsed.data
  } catch {
    return null
  }
}

export function gitSignInCookie(
  value: string | null,
  secure: boolean,
  route: GitSignInRoute = gitlabSignInRoute,
): string {
  const parts = [
    `${route.name}=${value ?? ''}`,
    `Path=${route.path}`,
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${value === null ? 0 : GIT_SIGN_IN_TTL_MS / 1000}`,
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

export function gitSignInCookieOf(
  headers: Headers,
  route: GitSignInRoute = gitlabSignInRoute,
): string | undefined {
  for (const part of (headers.get('cookie') ?? '').split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name === route.name) return rest.join('=')
  }
  return undefined
}
