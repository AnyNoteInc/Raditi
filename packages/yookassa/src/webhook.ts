import { BlockList, isIP } from 'node:net'

import { z } from 'zod'

import { YookassaError } from './errors.ts'
import { paymentSchema, refundSchema } from './schemas.ts'

/**
 * Addresses ЮKassa sends HTTP notifications from.
 * Source: https://yookassa.ru/developers/using-api/webhooks (section «IP-адреса»),
 * checked 2026-09-26. Re-check when ЮKassa announces changes.
 */
export const YOOKASSA_WEBHOOK_IP_RANGES: readonly string[] = [
  '185.71.76.0/27',
  '185.71.77.0/27',
  '77.75.153.0/25',
  '77.75.156.11',
  '77.75.156.35',
  '77.75.154.128/25',
  '2a02:5180::/32',
]

const paymentEventSchema = z.object({
  type: z.literal('notification'),
  event: z.enum(['payment.succeeded', 'payment.waiting_for_capture', 'payment.canceled']),
  object: paymentSchema,
})

const refundEventSchema = z.object({
  type: z.literal('notification'),
  event: z.literal('refund.succeeded'),
  object: refundSchema,
})

const eventStatus = {
  'payment.succeeded': 'succeeded',
  'payment.waiting_for_capture': 'waiting_for_capture',
  'payment.canceled': 'canceled',
  'refund.succeeded': 'succeeded',
} as const

export const webhookEventSchema = z
  .discriminatedUnion('event', [paymentEventSchema, refundEventSchema])
  .refine((e) => e.object.status === eventStatus[e.event], {
    message: 'event does not match the object status',
    path: ['object', 'status'],
  })

export type WebhookEvent = z.infer<typeof webhookEventSchema>
export type PaymentWebhookEvent = z.infer<typeof paymentEventSchema>
export type RefundWebhookEvent = z.infer<typeof refundEventSchema>

/**
 * Parses a notification body. A notification is a hint, not proof: before crediting money
 * the handler reads the object back with getPayment/getRefund and acts on that answer.
 * The handler answers 200 to everything it has accepted; otherwise ЮKassa retries for 24 hours.
 */
export function parseWebhookEvent(body: unknown): WebhookEvent {
  const parsed = webhookEventSchema.safeParse(body)
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
    throw new YookassaError(`Invalid webhook body: ${problems.join('; ')}`, {
      cause: parsed.error,
    })
  }
  return parsed.data
}

export interface VerifyTrustedIpOptions {
  /** Production: an empty allowlist denies everything instead of allowing everything. */
  requireAllowlist: boolean
}

/**
 * Checks the sender address against IPv4/IPv6 CIDRs or single addresses.
 * `ip` must be the TCP peer or a header set by our own reverse proxy, never a
 * client-controlled X-Forwarded-For entry. IPv4-mapped IPv6 (::ffff:a.b.c.d) matches IPv4
 * entries. A malformed allowlist entry throws: a misconfiguration must not pass silently.
 */
export function verifyTrustedIp(
  ip: string | null | undefined,
  allowlist: readonly string[],
  options: VerifyTrustedIpOptions,
): boolean {
  const entries = allowlist.map((entry) => entry.trim()).filter((entry) => entry !== '')
  if (entries.length === 0) return !options.requireAllowlist

  const blockList = new BlockList()
  for (const entry of entries) addEntry(blockList, entry)

  const address = normalizeIp(ip)
  if (address === null) return false
  return blockList.check(address, isIP(address) === 4 ? 'ipv4' : 'ipv6')
}

function addEntry(blockList: BlockList, entry: string): void {
  const [address = '', prefixText, ...rest] = entry.split('/')
  const family = isIP(address)
  const maxPrefix = family === 4 ? 32 : 128
  const prefix = prefixText === undefined ? maxPrefix : Number(prefixText)
  if (
    family === 0 ||
    rest.length > 0 ||
    (prefixText !== undefined && !/^\d{1,3}$/.test(prefixText)) ||
    prefix > maxPrefix
  ) {
    throw new YookassaError(`Invalid IP allowlist entry: ${entry}`)
  }
  blockList.addSubnet(address, prefix, family === 4 ? 'ipv4' : 'ipv6')
}

function normalizeIp(ip: string | null | undefined): string | null {
  if (!ip) return null
  let address = ip.trim()
  if (address.startsWith('[') && address.endsWith(']')) address = address.slice(1, -1)
  // Zone ids (fe80::1%eth0) are link-local only and never match a public range.
  const zone = address.indexOf('%')
  if (zone !== -1) address = address.slice(0, zone)
  return isIP(address) === 0 ? null : address
}
