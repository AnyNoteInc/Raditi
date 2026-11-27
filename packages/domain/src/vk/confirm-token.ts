import { z } from 'zod'

import { DomainError } from '../errors.ts'
import { vkActionKinds } from './feed.ts'

// The press of «Опубликовать» on a card of VK (docs/plan/99-vk-community.md, §3.3, rule 4): web,
// after it checks the session, signs the claims by VK_CONFIRM_SECRET and writes a row of
// `vk_actions` that holds the token itself; core checks it again before it calls VK — one user of
// PostgreSQL for every service, so a row inserted without a press must not run. The text the client
// publishes — maybe edited on the card — is named by its hash: core publishes only that text.

export const VK_CONFIRM_TTL_SECONDS = 10 * 60
export const VK_CONFIRM_TOKEN_MAX = 2048

export const vkConfirmClaimsSchema = z.strictObject({
  kind: z.enum(vkActionKinds),
  userId: z.uuid(),
  workspaceId: z.uuid(),
  communityId: z.uuid(),
  reservationId: z.uuid(),
  taskId: z.uuid(),
  textSha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** A delayed post: when VK publishes it; null — at once, and for a reply. */
  publishAt: z.iso.datetime().nullable(),
  nonce: z.string().regex(/^[0-9a-f]{32}$/),
  /** Unix seconds. */
  expiresAt: z.number().int().positive(),
})
export type VkConfirmClaims = z.infer<typeof vkConfirmClaimsSchema>

export function vkConfirmMaterial(claims: VkConfirmClaims): string {
  const value = vkConfirmClaimsSchema.parse(claims)
  return [
    'raditi-vk-confirm:v1',
    value.kind,
    value.userId,
    value.workspaceId,
    value.communityId,
    value.reservationId,
    value.taskId,
    value.textSha256,
    value.publishAt ?? '-',
    value.nonce,
    value.expiresAt,
  ].join('\n')
}

/** HMAC-SHA256 of the material by VK_CONFIRM_SECRET, base64url: the transport's, passed in. */
export type VkConfirmMac = (material: string) => string

const toBase64Url = (text: string): string => {
  let binary = ''
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

const fromBase64Url = (value: string): string | null => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null
  try {
    const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/'))
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(binary, (char) => char.charCodeAt(0)),
    )
  } catch {
    return null
  }
}

function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export function signVkConfirmToken(claims: VkConfirmClaims, mac: VkConfirmMac): string {
  const value = vkConfirmClaimsSchema.parse(claims)
  return `${toBase64Url(JSON.stringify(value))}.${mac(vkConfirmMaterial(value))}`
}

export const vkConfirmInvalid = (): DomainError =>
  new DomainError('VK_CONFIRM_INVALID', 'The confirmation of the publication is not valid', 409)
export const vkConfirmExpired = (): DomainError =>
  new DomainError('VK_CONFIRM_EXPIRED', 'The confirmation of the publication has expired', 409)

/** The claims of a token whose HMAC holds and whose time has not passed; a refusal otherwise. */
export function readVkConfirmToken(token: string, mac: VkConfirmMac, now: Date): VkConfirmClaims {
  if (typeof token !== 'string' || token.length > VK_CONFIRM_TOKEN_MAX) throw vkConfirmInvalid()
  const [body, given, ...rest] = token.split('.')
  if (!body || !given || rest.length) throw vkConfirmInvalid()
  const json = fromBase64Url(body)
  if (json === null) throw vkConfirmInvalid()
  let parsed: ReturnType<typeof vkConfirmClaimsSchema.safeParse>
  try {
    parsed = vkConfirmClaimsSchema.safeParse(JSON.parse(json))
  } catch {
    throw vkConfirmInvalid()
  }
  if (!parsed.success) throw vkConfirmInvalid()
  if (!sameText(mac(vkConfirmMaterial(parsed.data)), given)) throw vkConfirmInvalid()
  if (parsed.data.expiresAt * 1000 <= now.getTime()) throw vkConfirmExpired()
  return parsed.data
}
