import { z } from 'zod'

import {
  classifySiteAddress,
  classifySiteHostName,
  ipLiteralBytes,
} from '../policies/site-address.ts'

/**
 * Where a client's variable may lead (docs/plan/53-chat-preview-release.md, Р13): the hosts the
 * client listed for it, `host:port`, and only DNS names. The egress proxy resolves the name on
 * every connection and refuses any address that is not public, then connects to the address it
 * checked; this module is the one rule both the form and the proxy apply.
 */
export const EGRESS_DEFAULT_PORT = 443
export const egressHostLimits = Object.freeze({
  /** Hosts of one variable (`site_env_vars.hosts`). */
  perVariable: 16,
  /**
   * Different hosts of all the variables of one site: the egress of a sandbox or a preview
   * travels in one environment variable of its proxy (below the 128 KiB of one on Linux), so the
   * form takes no more (`MAX_SANDBOX_EGRESS_HOSTS`, a preview's settings file).
   */
  perSite: 256,
  /** `host:port` as stored. */
  chars: 253 + 6,
})

export interface EgressHost {
  host: string
  port: number
}

const HOST_PORT = /^([a-z0-9.-]+)(?::([1-9]\d{0,4}))?$/
/** `127.1`, `0x7f.1`, `2130706433`: the forms a resolver may read as an address. */
const NUMERIC_LABEL = /^(?:\d+|0x[0-9a-f]*)$/

/**
 * A host as the client may give it: a public DNS name with an optional port (443 by default).
 * null for an IP literal in any spelling, a single label, `localhost` and `*.localhost`,
 * `*.internal` (and so `host.docker.internal`), the other local and reserved zones, a trailing
 * dot, a path or credentials. Letter case is ignored; the result is lower case.
 */
export function parseEgressHost(text: string): EgressHost | null {
  const match = HOST_PORT.exec(text.toLowerCase())
  if (!match) return null
  const host = match[1] ?? ''
  const port = match[2] === undefined ? EGRESS_DEFAULT_PORT : Number(match[2])
  if (port > 65_535) return null
  if (ipLiteralBytes(host) !== null) return null
  if (host.split('.').every((label) => NUMERIC_LABEL.test(label))) return null
  return classifySiteHostName(host) === 'public' ? { host, port } : null
}

/** The stored spelling: always `host:port`. */
export const formatEgressHost = ({ host, port }: EgressHost): string => `${host}:${port}`

/** One host of a variable; stored as `host:port`. */
export const egressHostSchema = z
  .string()
  .max(egressHostLimits.chars)
  .transform((text, ctx) => {
    const parsed = parseEgressHost(text)
    if (parsed === null) {
      ctx.addIssue({
        code: 'custom',
        message: 'expected a public domain name with an optional port, not an address',
      })
      return z.NEVER
    }
    return formatEgressHost(parsed)
  })

/** The hosts of one variable: up to sixteen, each once. */
export const egressHostListSchema = z
  .array(egressHostSchema)
  .max(egressHostLimits.perVariable)
  .refine((hosts) => new Set(hosts).size === hosts.length, 'each host once')

// ---------------------------------------------------------------------------------------------
// Addresses the proxy connects to
// ---------------------------------------------------------------------------------------------

export interface IpSubnet {
  bytes: readonly number[]
  prefix: number
}

/** `10.0.0.0/8`, `fd00::/8`: an address and a prefix length; null for anything else. */
export function parseIpSubnet(text: string): IpSubnet | null {
  const slash = text.indexOf('/')
  if (slash < 0) return null
  const bytes = ipLiteralBytes(text.slice(0, slash))
  const prefixText = text.slice(slash + 1)
  if (bytes === null || !/^(?:0|[1-9]\d{0,2})$/.test(prefixText)) return null
  const prefix = Number(prefixText)
  return prefix <= bytes.length * 8 ? { bytes, prefix } : null
}

function inSubnet(bytes: readonly number[], subnet: IpSubnet): boolean {
  if (bytes.length !== subnet.bytes.length) return false
  for (let bit = 0; bit < subnet.prefix; bit++) {
    const index = bit >> 3
    const mask = 0x80 >> (bit & 7)
    if (((bytes[index] ?? 0) & mask) !== ((subnet.bytes[index] ?? 0) & mask)) return false
  }
  return true
}

/**
 * Whether the proxy may connect to a resolved address. Only a public unicast address outside
 * the platform's own subnets: never RFC 1918, loopback, link-local (and so the metadata
 * service 169.254.169.254), shared CGNAT space, `0.0.0.0/8`, multicast and reserved, IPv6
 * unique local, link-local, multicast, IPv4-mapped or NAT64 — the rule of site addresses
 * (policies/site-address.ts) with nothing local allowed.
 */
export function isEgressAddressAllowed(
  address: string,
  platformSubnets: readonly IpSubnet[] = [],
): boolean {
  if (classifySiteAddress(address) !== 'public') return false
  const bytes = ipLiteralBytes(address)
  return bytes !== null && !platformSubnets.some((subnet) => inSubnet(bytes, subnet))
}
