import { BlockList } from 'node:net'
import { ipLiteral } from '@repo/ip-address'

/**
 * PREVIEW_BROWSER_RELAYS (docs/plan/53-chat-preview-release.md, Р21): the addresses from which
 * the relays of the agent's browser may use the gateway of previews as an HTTP forward proxy.
 * Nobody else may: a visitor must not turn the gateway into an open proxy.
 */
export interface PreviewRelayRange {
  address: string
  prefix: number
  family: 'ipv4' | 'ipv6'
}

/** Outside production: this machine and Docker's bridges (Docker Desktop and Linux). */
export const DEV_PREVIEW_BROWSER_RELAYS = '127.0.0.1/32,::1/128,172.16.0.0/12'

/**
 * The blocks a production range must lie in as a whole — RFC 1918, IPv6 ULA and loopback, the
 * same as isPrivateAddress and isLoopbackAddress. A range is inside a block when its prefix is
 * at least the block's and its network address is in the block: 10.0.0.0/1 starts at a private
 * address but covers half the internet.
 */
const PRODUCTION_RELAY_BLOCKS: readonly PreviewRelayRange[] = [
  { address: '10.0.0.0', prefix: 8, family: 'ipv4' },
  { address: '172.16.0.0', prefix: 12, family: 'ipv4' },
  { address: '192.168.0.0', prefix: 16, family: 'ipv4' },
  { address: '127.0.0.0', prefix: 8, family: 'ipv4' },
  { address: 'fc00::', prefix: 7, family: 'ipv6' },
  { address: '::1', prefix: 128, family: 'ipv6' },
]

function withinPrivateBlock(range: PreviewRelayRange): boolean {
  return PRODUCTION_RELAY_BLOCKS.some((block) => {
    if (block.family !== range.family || range.prefix < block.prefix) return false
    const list = new BlockList()
    list.addSubnet(block.address, block.prefix, block.family)
    return list.check(range.address, range.family)
  })
}

/**
 * The ranges of the variable; production takes none by default (the forward proxy is off) and
 * only ranges that lie wholly in a private or loopback block. Problems name the variable,
 * never a value.
 */
export function parsePreviewRelays(
  raw: string | undefined,
  production: boolean,
): { ranges: PreviewRelayRange[]; problems: string[] } {
  const written = (raw ?? (production ? '' : DEV_PREVIEW_BROWSER_RELAYS)).trim()
  const ranges: PreviewRelayRange[] = []
  const problems = new Set<string>()
  if (written === '') return { ranges, problems: [] }
  for (const value of written.split(',').map((part) => part.trim())) {
    const [host = '', prefix = '', ...extra] = value.split('/')
    const address = ipLiteral(host)
    const family = address?.includes(':') ? ('ipv6' as const) : ('ipv4' as const)
    const bits = Number(prefix)
    if (
      address === undefined ||
      extra.length > 0 ||
      !/^\d{1,3}$/.test(prefix) ||
      bits > (family === 'ipv6' ? 128 : 32)
    ) {
      problems.add('PREVIEW_BROWSER_RELAYS: must be a comma-separated list of IP CIDRs')
      continue
    }
    const range = { address, prefix: bits, family }
    if (production && !withinPrivateBlock(range)) {
      problems.add(
        'PREVIEW_BROWSER_RELAYS: only private or loopback ranges in production (spec §19)',
      )
      continue
    }
    ranges.push(range)
  }
  return { ranges, problems: [...problems] }
}
