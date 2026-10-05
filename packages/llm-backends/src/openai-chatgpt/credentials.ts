import { badRequest, type CredentialMetadata, type SubscriptionCredential } from '@repo/domain'
import { z } from 'zod'

import { decodeControlJson } from '../shared.ts'
import { object } from '../usage.ts'

const authClaim = 'https://api.openai.com/auth'
const secret = z
  .string()
  .min(1)
  .max(32_768)
  .regex(/^[\x21-\x7e]+$/)
const account = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/)
const instant = z.iso.datetime({ offset: true })
/** One shape for the plan in the login's `id_token` and in the usage probe. */
export const codexPlanPattern = /^[a-z0-9_-]{1,64}$/

/** Decoding is for metadata only. Provider authentication, not these claims, authenticates users. */
export function codexJwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split('.')
  if (parts.length !== 3 || !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))) return null
  const payload = Buffer.from(parts[1]!, 'base64url')
  if (payload.toString('base64url') !== parts[1]) return null
  return decodeControlJson(payload)
}

export function jwtInstant(value: unknown): Date | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return null
  const date = new Date(value * 1000)
  return Number.isFinite(date.getTime()) ? date : null
}

export const codexCredentialSchema = z
  .object({
    v: z.literal('1'),
    kind: z.literal('chatgpt_oauth'),
    accessToken: secret,
    refreshToken: secret,
    idToken: secret,
    chatgptAccountId: account,
    accessExpiresAt: instant.nullable(),
    refreshedAt: instant,
  })
  .strict()
  .superRefine((credential, ctx) => {
    const access = codexJwtClaims(credential.accessToken)
    const accessIdentity = object(access?.[authClaim])
    const identity = object(codexJwtClaims(credential.idToken)?.[authClaim])
    const expiry = jwtInstant(access?.exp)
    const issued = jwtInstant(access?.iat)
    const storedExpiry =
      credential.accessExpiresAt === null ? null : new Date(credential.accessExpiresAt)
    if (
      access === null ||
      (access[authClaim] !== undefined && accessIdentity === undefined) ||
      (accessIdentity?.chatgpt_account_id !== undefined &&
        accessIdentity.chatgpt_account_id !== credential.chatgptAccountId) ||
      identity?.chatgpt_account_id !== credential.chatgptAccountId ||
      (identity.chatgpt_plan_type !== undefined &&
        (typeof identity.chatgpt_plan_type !== 'string' ||
          !codexPlanPattern.test(identity.chatgpt_plan_type))) ||
      (access.exp !== undefined && expiry === null) ||
      (access.iat !== undefined && issued === null) ||
      (expiry !== null && storedExpiry?.getTime() !== expiry.getTime()) ||
      (issued !== null && storedExpiry !== null && issued >= storedExpiry)
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid Codex credential metadata' })
  })

export type CodexCredential = z.infer<typeof codexCredentialSchema>

export function readCodexCredential(value: SubscriptionCredential): CodexCredential {
  const parsed = codexCredentialSchema.safeParse(value)
  if (!parsed.success) throw badRequest('Invalid Codex credential')
  return parsed.data
}

export function codexCredentialMetadata(value: SubscriptionCredential): CredentialMetadata {
  const credential = readCodexCredential(value)
  const identity = object(codexJwtClaims(credential.idToken)?.[authClaim])!
  return {
    externalAccountId: credential.chatgptAccountId,
    plan: typeof identity.chatgpt_plan_type === 'string' ? identity.chatgpt_plan_type : null,
    accessExpiresAt:
      credential.accessExpiresAt === null ? null : new Date(credential.accessExpiresAt),
    accessIssuedAt: jwtInstant(codexJwtClaims(credential.accessToken)?.iat),
  }
}

/** Merge partial refresh responses; malformed replacements must never overwrite usable tokens. */
export function credentialFromTokens(
  body: Record<string, unknown>,
  now: Date,
  previous?: CodexCredential,
): CodexCredential | null {
  if (!Number.isFinite(now.getTime())) return null
  const fields = ['access_token', 'refresh_token', 'id_token'] as const
  if (!fields.some((field) => body[field] !== undefined)) return null
  for (const field of fields)
    if (body[field] !== undefined && !secret.safeParse(body[field]).success) return null
  const accessToken = body.access_token ?? previous?.accessToken
  const refreshToken = body.refresh_token ?? previous?.refreshToken
  const idToken = body.id_token ?? previous?.idToken
  if (
    typeof accessToken !== 'string' ||
    typeof refreshToken !== 'string' ||
    typeof idToken !== 'string'
  )
    return null
  const identity = object(codexJwtClaims(idToken)?.[authClaim])
  const chatgptAccountId = identity?.chatgpt_account_id
  if (previous !== undefined && chatgptAccountId !== previous.chatgptAccountId) return null
  const claims = codexJwtClaims(accessToken)
  if (claims === null) return null
  let expiry = jwtInstant(claims.exp)?.toISOString() ?? null
  if (claims.exp === undefined) {
    if (body.access_token === undefined && previous !== undefined) expiry = previous.accessExpiresAt
    else if (body.expires_in !== undefined) {
      if (
        typeof body.expires_in !== 'number' ||
        !Number.isSafeInteger(body.expires_in) ||
        body.expires_in <= 0
      )
        return null
      const date = new Date(now.getTime() + body.expires_in * 1000)
      if (!Number.isFinite(date.getTime())) return null
      expiry = date.toISOString()
    }
  }
  const parsed = codexCredentialSchema.safeParse({
    v: '1',
    kind: 'chatgpt_oauth',
    accessToken,
    refreshToken,
    idToken,
    chatgptAccountId,
    accessExpiresAt: expiry,
    refreshedAt: now.toISOString(),
  })
  return parsed.success ? parsed.data : null
}
