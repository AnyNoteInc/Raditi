// Internal: the package exposes these checks only through GitProvider.parseWebhook.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

const HEX_SHA256 = /^[0-9a-f]{64}$/i

/** Constant-time check of a hex HMAC-SHA256 of the raw body; malformed input is simply rejected. */
function hmacMatches(secret: string, rawBody: string, signatureHex: string | null): boolean {
  // An empty secret would let anyone forge a signature: fail closed.
  if (!secret || !signatureHex || !HEX_SHA256.test(signatureHex)) return false
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest()
  return timingSafeEqual(expected, Buffer.from(signatureHex, 'hex'))
}

/** Gitea: `X-Gitea-Signature` is the hex HMAC-SHA256 of the raw body. */
export function verifyGiteaSignature(headers: Headers, rawBody: string, secret: string): boolean {
  return hmacMatches(secret, rawBody, headers.get('x-gitea-signature'))
}

/** GitHub: `X-Hub-Signature-256` is `sha256=` + hex HMAC-SHA256 of the raw body. */
export function verifyGithubSignature(headers: Headers, rawBody: string, secret: string): boolean {
  const header = headers.get('x-hub-signature-256')
  const prefix = 'sha256='
  if (!header?.startsWith(prefix)) return false
  return hmacMatches(secret, rawBody, header.slice(prefix.length))
}

/**
 * GitLab: `X-Gitlab-Token` carries the secret itself. Both sides are hashed first so the
 * comparison is constant-time and does not leak the secret length.
 */
export function verifyGitlabToken(headers: Headers, _rawBody: string, secret: string): boolean {
  const token = headers.get('x-gitlab-token')
  if (!secret || !token) return false
  const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest()
  return timingSafeEqual(digest(token), digest(secret))
}
