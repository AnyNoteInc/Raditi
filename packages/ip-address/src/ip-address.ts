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
