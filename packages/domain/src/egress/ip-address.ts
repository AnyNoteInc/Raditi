/**
 * Which addresses and names are public — spec §12, first the rule of a client's site, now of the
 * egress of a sandbox and of a browser session (egress-hosts.ts, browser/hosts.ts). Pure: own
 * parsing of IP literals, no resolver. `public` is a public unicast address or name; `local` is
 * loopback, a private network or a local zone; null is never reachable.
 */
export type AddressClass = 'public' | 'local'

type Octets = [number, number, number, number]

const DOTTED_QUAD = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/
const HEX_GROUP = /^[0-9a-f]{1,4}$/i

/** Four decimal octets without leading zeros: `127.1` and `0177.0.0.1` are not literals here. */
function parseIpv4(text: string): Octets | null {
  const match = DOTTED_QUAD.exec(text)
  if (!match) return null
  const octets = match.slice(1).map(Number)
  return octets.every((octet) => octet <= 255) ? (octets as Octets) : null
}

/** Groups of one side of `::`; the last piece of the address may be an embedded dotted quad. */
function parseIpv6Groups(part: string, mayEndWithIpv4: boolean): number[] | null {
  if (part === '') return []
  const pieces = part.split(':')
  const groups: number[] = []
  for (const [index, piece] of pieces.entries()) {
    if (mayEndWithIpv4 && index === pieces.length - 1 && piece.includes('.')) {
      const quad = parseIpv4(piece)
      if (!quad) return null
      groups.push(quad[0] * 256 + quad[1], quad[2] * 256 + quad[3])
    } else if (HEX_GROUP.test(piece)) {
      groups.push(Number.parseInt(piece, 16))
    } else {
      return null
    }
  }
  return groups
}

/** The eight 16-bit groups of an IPv6 literal without brackets or zone. */
function parseIpv6(text: string): number[] | null {
  const halves = text.split('::')
  if (halves.length > 2) return null
  const [first = '', second] = halves
  if (second === undefined) {
    const groups = parseIpv6Groups(first, true)
    return groups?.length === 8 ? groups : null
  }
  const left = parseIpv6Groups(first, false)
  const right = parseIpv6Groups(second, true)
  // `::` stands for at least one group of zeros.
  if (!left || !right || left.length + right.length > 7) return null
  return [...left, ...new Array<number>(8 - left.length - right.length).fill(0), ...right]
}

function classifyIpv4([a, b, c]: Octets): AddressClass | null {
  // Loopback and RFC 1918.
  if (a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168))
    return 'local'
  // Never a site: "this network", shared address space, link-local (cloud metadata), IETF
  // protocol assignments, benchmarking, multicast, reserved and broadcast.
  if (
    a === 0 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  )
    return null
  return 'public'
}

function classifyIpv6(groups: readonly number[]): AddressClass | null {
  const [first = 0, second = 0] = groups
  // `::1` and unique local addresses, fc00::/7.
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return 'local'
  if ((first & 0xfe00) === 0xfc00) return 'local'
  // Global unicast is 2000::/3 without Teredo (2001::/32), documentation (2001:db8::/32) and
  // 6to4 (2002::/16), which carry or stand for another address. Everything else is never a
  // site: `::`, link-local, multicast, IPv4-mapped `::ffff:…`, NAT64 `64:ff9b::/96`.
  if ((first & 0xe000) !== 0x2000) return null
  if (first === 0x2001 && (second === 0 || second === 0x0db8)) return null
  if (first === 0x2002) return null
  return 'public'
}

/** An IPv4 dotted quad or an IPv6 literal without brackets or zone. Anything else is null. */
export function classifyIpAddress(address: string): AddressClass | null {
  const octets = parseIpv4(address)
  if (octets) return classifyIpv4(octets)
  const groups = parseIpv6(address)
  return groups ? classifyIpv6(groups) : null
}

const HOST_LABEL = /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i
const NEVER_ZONES = /(?:^|\.)(?:invalid|onion)$/i
const LOCAL_ZONES = /(?:^|\.)(?:localhost|local|internal|test|lan|home)$/i

/** A DNS name by the rule of spec §12. Never resolves. */
export function classifyHostName(name: string): AddressClass | null {
  const labels = name.split('.')
  if (
    name.length > 253 ||
    !labels.every((label) => HOST_LABEL.test(label)) ||
    // The last label of a name has a letter: `1.2.3` and `0x7f.1` are not names.
    !/[a-z]/i.test(labels.at(-1) ?? '') ||
    NEVER_ZONES.test(name)
  )
    return null
  // One label resolves through a search list, and the zones below never leave a local network.
  return labels.length === 1 || LOCAL_ZONES.test(name) ? 'local' : 'public'
}

/**
 * The bytes of an IPv4 dotted quad (4) or an IPv6 literal without brackets or zone (16); null
 * for anything else. For prefix matching (the egress proxy's platform subnets).
 */
export function ipLiteralBytes(address: string): number[] | null {
  const octets = parseIpv4(address)
  if (octets) return [...octets]
  const groups = parseIpv6(address)
  return groups ? groups.flatMap((group) => [group >> 8, group & 0xff]) : null
}
