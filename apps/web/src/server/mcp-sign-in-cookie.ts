import 'server-only'

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

import { z } from 'zod'

// A sign-in to an MCP server between its start and the owner's return
// (docs/plan/81-mcp-server-credentials.md, §3.4): the PKCE verifier, the state, the client the
// platform registered — sealed in a cookie of the callback's path for ten minutes, never kept in the
// base. AES-256-GCM under a key of its own derived from BETTER_AUTH_SECRET.

export const MCP_SIGN_IN_COOKIE = 'raditi_mcp_sign_in'
export const MCP_SIGN_IN_PATH = '/api/mcp-oauth'
export const MCP_SIGN_IN_TTL_MS = 10 * 60_000
const KEY_INFO = 'raditi-mcp-sign-in-v1'

export const pendingSignInSchema = z.strictObject({
  siteId: z.uuid(),
  name: z.string().min(1).max(32),
  userId: z.string().min(1).max(128),
  expiresAt: z.number().int(),
  pending: z.strictObject({
    url: z.string().max(512),
    issuer: z.string().max(2048),
    tokenEndpoint: z.string().max(2048),
    clientId: z.string().max(512),
    clientSecret: z.string().max(8192).optional(),
    verifier: z.string().max(128),
    state: z.string().max(128),
    scope: z.string().max(1024).optional(),
    redirectUri: z.string().max(2048),
  }),
})
export type SealedSignIn = z.infer<typeof pendingSignInSchema>

const keyOf = (secret: string) =>
  Buffer.from(hkdfSync('sha256', Buffer.from(secret), Buffer.alloc(0), KEY_INFO, 32))

export function sealSignIn(value: SealedSignIn, secret: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', keyOf(secret), iv)
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url')
}

/** The sealed sign-in, or null for one that is broken, forged or past its ten minutes. */
export function openSignIn(
  token: string | undefined,
  secret: string,
  now: number,
): SealedSignIn | null {
  if (token === undefined || token.length > 16_384) return null
  try {
    const raw = Buffer.from(token, 'base64url')
    if (raw.length < 29) return null
    const decipher = createDecipheriv('aes-256-gcm', keyOf(secret), raw.subarray(0, 12))
    decipher.setAuthTag(raw.subarray(12, 28))
    const text = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString(
      'utf8',
    )
    const parsed = pendingSignInSchema.safeParse(JSON.parse(text))
    if (!parsed.success || parsed.data.expiresAt <= now) return null
    return parsed.data
  } catch {
    return null
  }
}

/** The cookie as the start sets it and the callback clears it. */
export function signInCookie(value: string | null, secure: boolean): string {
  const parts = [
    `${MCP_SIGN_IN_COOKIE}=${value ?? ''}`,
    `Path=${MCP_SIGN_IN_PATH}`,
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${value === null ? 0 : MCP_SIGN_IN_TTL_MS / 1000}`,
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}
