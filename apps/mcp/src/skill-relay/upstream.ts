import type { LookupAddress } from 'node:dns'
import { lookup as dnsLookup } from 'node:dns/promises'

import {
  ipLiteral,
  isLoopbackAddress,
  publicAddressCheck,
  type RefusedSubnet,
} from '@repo/ip-address'

/** Why the relay did not reach a server; codes alone, as `auth_error` keeps them. */
export class RelayRefusal extends Error {
  constructor(readonly code: 'address_refused' | 'unreachable') {
    super(code)
  }
}

export type ResolveName = (host: string) => Promise<readonly LookupAddress[]>

const resolveAll: ResolveName = (host) => dnsLookup(host, { all: true, verbatim: true })

export interface UpstreamPolicy {
  refusedSubnets: readonly RefusedSubnet[]
  /** Outside production, for tests and stands: a loopback server is taken. */
  allowLoopback: boolean
  resolve?: ResolveName
}

/**
 * Where the relay connects for a server's address (docs/plan/80, §3.2, п. 4): the name is resolved
 * once per request and every address it has must be public — a name with one private address is
 * refused whole —, and the connection goes to the address that was checked, with the name as SNI
 * and as the name of the certificate. A resolver that answers differently on the next lookup
 * changes nothing: no second lookup is made.
 */
export function upstreamResolver(policy: UpstreamPolicy) {
  const isPublic = publicAddressCheck(policy.refusedSubnets)
  const allowed = (address: string) =>
    isPublic(address) || (policy.allowLoopback && isLoopbackAddress(address))
  const resolve = policy.resolve ?? resolveAll
  return async (url: URL): Promise<{ address: string; family: 4 | 6 }> => {
    const host = url.hostname.replace(/^\[(.*)\]$/, '$1')
    let addresses: readonly LookupAddress[]
    if (ipLiteral(host) !== undefined)
      addresses = [{ address: host, family: host.includes(':') ? 6 : 4 }]
    else {
      try {
        addresses = await resolve(host)
      } catch {
        throw new RelayRefusal('unreachable')
      }
    }
    if (addresses.length === 0) throw new RelayRefusal('unreachable')
    if (!addresses.every((entry) => allowed(entry.address)))
      throw new RelayRefusal('address_refused')
    const chosen = addresses[0]!
    return { address: chosen.address, family: chosen.family === 6 ? 6 : 4 }
  }
}
