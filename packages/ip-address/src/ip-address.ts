import { BlockList, isIP } from 'node:net'

const loopbackRanges = new BlockList()
loopbackRanges.addSubnet('127.0.0.0', 8, 'ipv4')
loopbackRanges.addAddress('::1', 'ipv6')

const privateRanges = new BlockList()
privateRanges.addSubnet('10.0.0.0', 8, 'ipv4')
privateRanges.addSubnet('172.16.0.0', 12, 'ipv4')
privateRanges.addSubnet('192.168.0.0', 16, 'ipv4')
privateRanges.addSubnet('fc00::', 7, 'ipv6')

/**
 * The canonical form of an IP address literal: no brackets, IPv6 compressed and lower-case, an
 * IPv4-mapped address as plain IPv4. undefined for a name or anything else.
 */
export function ipLiteral(host: string): string | undefined {
  const bare = host.replace(/^\[(.*)\]$/, '$1')
  const family = isIP(bare)
  if (family === 4) return bare
  if (family !== 6) return undefined
  // Zone ids (fe80::1%eth0) do not parse: such an address is never a private one here.
  const v6 = URL.parse(`http://[${bare}]`)?.hostname.slice(1, -1)
  const mapped = v6 && /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v6)
  if (!mapped) return v6
  const [high, low] = [Number.parseInt(mapped[1]!, 16), Number.parseInt(mapped[2]!, 16)]
  return [high >> 8, high & 255, low >> 8, low & 255].join('.')
}

/**
 * An RFC 1918 or IPv6 ULA address literal (spec §19). A name is never private here: what it
 * resolves to is not checked, so plain HTTP goes only to a literal address.
 */
export function isPrivateAddress(host: string): boolean {
  const literal = ipLiteral(host)
  return (
    literal !== undefined && privateRanges.check(literal, literal.includes(':') ? 'ipv6' : 'ipv4')
  )
}

/** A loopback address literal: 127.0.0.0/8 or ::1 (and ::ffff:127.x.y.z). Never a name. */
export function isLoopbackAddress(host: string): boolean {
  const literal = ipLiteral(host)
  return (
    literal !== undefined && loopbackRanges.check(literal, literal.includes(':') ? 'ipv6' : 'ipv4')
  )
}

// Not public unicast: the same lists as the egress proxy of a sandbox (infra/sandbox/client-
// egress.mjs, `addressCheck`). Global unicast IPv6 is 2000::/3 without Teredo, documentation
// and 6to4, which carry or stand for another address.
const nonPublicIpv4: readonly [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]
const nonPublicIpv6: readonly [string, number][] = [
  ['2001::', 32],
  ['2001:db8::', 32],
  ['2002::', 16],
]

/** A subnet a caller refuses besides the non-public ones: the platform's own. */
export interface RefusedSubnet {
  address: string
  prefix: number
  family: 4 | 6
}

/**
 * Whether a server of the internet may be connected to at this address: a literal of public
 * unicast in none of `refused`. A name is never public here — resolve it, then check each address.
 */
export function publicAddressCheck(
  refused: readonly RefusedSubnet[] = [],
): (host: string) => boolean {
  const blocked = new BlockList()
  for (const [network, prefix] of nonPublicIpv4) blocked.addSubnet(network, prefix, 'ipv4')
  for (const [network, prefix] of nonPublicIpv6) blocked.addSubnet(network, prefix, 'ipv6')
  for (const subnet of refused)
    blocked.addSubnet(subnet.address, subnet.prefix, subnet.family === 4 ? 'ipv4' : 'ipv6')
  const public6 = new BlockList()
  public6.addSubnet('2000::', 3, 'ipv6')
  return (host) => {
    const literal = ipLiteral(host)
    if (literal === undefined) return false
    if (!literal.includes(':')) return !blocked.check(literal, 'ipv4')
    return public6.check(literal, 'ipv6') && !blocked.check(literal, 'ipv6')
  }
}

/**
 * Subnets as the platform names them in its configuration (`SANDBOX_EGRESS_REFUSED_SUBNETS`):
 * `10.10.0.0/16,fd00::/8`. null for a list with anything else in it.
 */
export function parseRefusedSubnets(text: string): RefusedSubnet[] | null {
  const subnets: RefusedSubnet[] = []
  for (const item of text
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)) {
    const match = /^([^/]+)\/(\d{1,3})$/.exec(item)
    const address = match && ipLiteral(match[1]!)
    if (!match || address === undefined || address === null) return null
    const family = address.includes(':') ? 6 : 4
    const prefix = Number(match[2])
    if (prefix > (family === 4 ? 32 : 128)) return null
    subnets.push({ address, prefix, family })
  }
  return subnets
}
