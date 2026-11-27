import { classifyHostName, classifyIpAddress, ipLiteralBytes } from './ip-address.ts'

/**
 * Where a client's variable may lead (docs/plan/53-chat-preview-release.md, Р13): the hosts the
 * client listed for it, `host:port`, and only DNS names. The egress proxy resolves the name on
 * every connection and refuses any address that is not public, then connects to the address it
 * checked; this module is the one rule both the form and the proxy apply.
 */
export const EGRESS_DEFAULT_PORT = 443
export const egressHostLimits = Object.freeze({
  /**
   * Different hosts of all the variables of one site: the egress of a sandbox travels in one
   * environment variable of its proxy (below the 128 KiB of one on Linux), so the form takes no
   * more (`MAX_SANDBOX_EGRESS_HOSTS`).
   */
  perSite: 256,
})

export interface EgressHost {
  host: string
  port: number
}

const HOST_PORT = /^([a-z0-9.-]+)(?::([1-9]\d{0,4}))?$/
/** `127.1`, `0x7f.1`, `2130706433`: the forms a resolver may read as an address. */
const NUMERIC_LABEL = /^(?:\d+|0x[0-9a-f]*)$/

const NOT_ASCII = /[^\u0020-\u007e]/
const UNICODE_HOST_PORT = /^([^\s:/?#@[\]\\]+)(:[1-9]\d{0,4})?$/u

/**
 * `host:port` in ASCII and lower case. An internationalized name (`укк-жкх.рф`, as a Russian
 * client types the address of their own site) becomes its punycode (`xn--j1aabp1a.xn--p1ai`) —
 * the spelling DNS, the SNI of the proxy's tunnel and the stored hosts use. null when the name
 * cannot be one.
 */
function asciiHostPort(text: string): string | null {
  if (!NOT_ASCII.test(text)) return text.toLowerCase()
  const match = UNICODE_HOST_PORT.exec(text)
  if (!match) return null
  let host: string
  try {
    host = new URL(`http://${match[1] ?? ''}/`).hostname
  } catch {
    return null
  }
  if (host === '' || NOT_ASCII.test(host)) return null
  return `${host}${match[2] ?? ''}`
}

/**
 * A host as the client may give it: a public DNS name (an internationalized one is taken as its
 * punycode) with an optional port (443 by default).
 * null for an IP literal in any spelling, a single label, `localhost` and `*.localhost`,
 * `*.internal` (and so `host.docker.internal`), the other local and reserved zones, a trailing
 * dot, a path or credentials. Letter case is ignored; the result is lower case.
 */
export function parseEgressHost(text: string): EgressHost | null {
  const ascii = asciiHostPort(text)
  if (ascii === null) return null
  const match = HOST_PORT.exec(ascii)
  if (!match) return null
  const host = match[1] ?? ''
  const port = match[2] === undefined ? EGRESS_DEFAULT_PORT : Number(match[2])
  if (port > 65_535) return null
  if (ipLiteralBytes(host) !== null) return null
  if (host.split('.').every((label) => NUMERIC_LABEL.test(label))) return null
  return classifyHostName(host) === 'public' ? { host, port } : null
}

/** The stored spelling: always `host:port`. */
export const formatEgressHost = ({ host, port }: EgressHost): string => `${host}:${port}`

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
 * (ip-address.ts) with nothing local allowed.
 */
export function isEgressAddressAllowed(
  address: string,
  platformSubnets: readonly IpSubnet[] = [],
): boolean {
  if (classifyIpAddress(address) !== 'public') return false
  const bytes = ipLiteralBytes(address)
  return bytes !== null && !platformSubnets.some((subnet) => inSubnet(bytes, subnet))
}
