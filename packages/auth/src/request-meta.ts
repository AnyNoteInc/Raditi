import type { BetterAuthOptions } from 'better-auth'
import { getIP } from 'better-auth/api'

/**
 * Where the client address comes from. better-auth trusts X-Forwarded-For only when it
 * holds a single address, so the reverse proxy in front of web must overwrite the header
 * with the address it sees (not append to it); otherwise the rate limiter, the captcha and
 * the consent log get no address or a forged one.
 */
export const ipAddressOptions = {
  ipAddressHeaders: ['x-forwarded-for'],
} satisfies NonNullable<NonNullable<BetterAuthOptions['advanced']>['ipAddress']>

// The rate limiter collapses IPv6 to /64; evidence (consents, captcha) keeps the full address.
const fullAddressOptions: BetterAuthOptions = {
  advanced: { ipAddress: { ...ipAddressOptions, ipv6Subnet: 128 } },
}

const USER_AGENT_MAX = 1024

export interface RequestMeta {
  ipAddress: string | null
  userAgent: string | null
}

/** Client address as the reverse proxy reported it; null when it cannot be trusted. */
export function clientIp(source: Headers | Request | undefined): string | null {
  return source ? getIP(source, fullAddressOptions) : null
}

export function requestMeta(headers: Headers | undefined): RequestMeta {
  const userAgent = headers?.get('user-agent')?.trim()
  return {
    ipAddress: clientIp(headers),
    userAgent: userAgent ? userAgent.slice(0, USER_AGENT_MAX) : null,
  }
}
