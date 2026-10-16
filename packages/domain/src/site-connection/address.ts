import { isProduction, type AppEnv } from '../app-env.ts'
import {
  classifySiteAddress,
  classifySiteHostName,
  isSiteAddressAllowed,
  siteAddressFamily,
} from '../policies/site-address.ts'

export interface LookedUpAddress {
  address: string
  family: 4 | 6
}

/** DNS as a port: the A and AAAA records of a name. No hosts file, cancellable by the signal. */
export type HostLookup = (name: string, signal: AbortSignal) => Promise<LookedUpAddress[]>

export class HostLookupError extends Error {
  readonly reason: 'not_found' | 'timeout'

  constructor(reason: 'not_found' | 'timeout') {
    super(`Host lookup: ${reason}`)
    this.name = 'HostLookupError'
    this.reason = reason
  }
}

/** Checks the name, not `instanceof`: works across duplicated module instances. */
export function isHostLookupError(error: unknown): error is HostLookupError {
  return error instanceof Error && error.name === 'HostLookupError'
}

declare const pinned: unique symbol

/** An address that passed the site-address rule. Only resolvePinnedAddress makes one. */
export interface PinnedAddress {
  /** The normalised host as typed: the TLS name when `isName`. */
  readonly host: string
  /** The literal to dial. */
  readonly address: string
  readonly family: 4 | 6
  readonly isName: boolean
  readonly [pinned]: true
}

export type PinnedAddressResult =
  | { ok: true; address: PinnedAddress }
  | { ok: false; reason: 'address_not_allowed' | 'host_not_found' | 'unreachable' }

function pin(host: string, address: string, family: 4 | 6, isName: boolean): PinnedAddressResult {
  return { ok: true, address: Object.freeze({ host, address, family, isName }) as PinnedAddress }
}

/**
 * The answer of the lookup, or a `timeout` as soon as the signal aborts: a lookup that does not
 * honour its signal must not hold the caller past the deadline. The lookup keeps running; its
 * late rejection is already handled by the race.
 */
async function lookupUntilAborted(
  lookup: HostLookup,
  name: string,
  signal: AbortSignal,
): Promise<LookedUpAddress[]> {
  if (signal.aborted) throw new HostLookupError('timeout')
  // Called before the listener exists: a lookup that throws leaves nothing on the signal.
  const answer = lookup(name, signal)
  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new HostLookupError('timeout'))
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([answer, aborted])
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}

/**
 * The address texts of an answer, each read once; null for an answer that is not a list of
 * records with one. The type promises the shape, but a caller has no `try` around the resolver.
 */
function answeredAddresses(answer: unknown): string[] | null {
  if (!Array.isArray(answer)) return null
  const addresses: string[] = []
  for (const record of answer as unknown[]) {
    const address = (record as Partial<LookedUpAddress> | null | undefined)?.address
    if (typeof address !== 'string') return null
    addresses.push(address)
  }
  return addresses
}

/**
 * Resolves a normalised host once and pins the one literal that every connection of the call
 * dials. An IP literal is classified and never looked up. A name the rule refuses is not looked
 * up either: in production single-label names and the local zones cannot be probed. Every
 * address of the answer must be allowed; in production a name with a non-public record answers
 * like a name that does not exist, so a check draws no map of internal names. Never rejects:
 * a lookup that throws, or answers with something else than a list of addresses, has failed.
 */
export async function resolvePinnedAddress(
  deps: { lookup: HostLookup; appEnv: AppEnv },
  host: string,
  signal: AbortSignal,
): Promise<PinnedAddressResult> {
  const { lookup, appEnv } = deps
  const literalFamily = siteAddressFamily(host)
  if (literalFamily !== 0) {
    return isSiteAddressAllowed(classifySiteAddress(host), appEnv)
      ? pin(host, host, literalFamily, false)
      : { ok: false, reason: 'address_not_allowed' }
  }
  if (!isSiteAddressAllowed(classifySiteHostName(host), appEnv))
    return { ok: false, reason: 'address_not_allowed' }
  // Loopback by definition (RFC 6761): no resolver is asked, so none can answer otherwise.
  if (/(?:^|\.)localhost$/i.test(host)) return pin(host, '127.0.0.1', 4, true)

  let addresses: string[] | null
  try {
    addresses = answeredAddresses(await lookupUntilAborted(lookup, host, signal))
  } catch (error) {
    const notFound = isHostLookupError(error) && error.reason === 'not_found'
    return { ok: false, reason: notFound ? 'host_not_found' : 'unreachable' }
  }
  if (addresses === null) return { ok: false, reason: 'unreachable' }
  if (addresses.length === 0) return { ok: false, reason: 'host_not_found' }

  // The family is read from the literal itself; what the lookup says about it is not trusted.
  const literals = addresses.map((address) => ({ address, family: siteAddressFamily(address) }))
  if (literals.some(({ address }) => !isSiteAddressAllowed(classifySiteAddress(address), appEnv)))
    return { ok: false, reason: isProduction(appEnv) ? 'host_not_found' : 'address_not_allowed' }
  const target =
    literals.find(({ family }) => family === 4) ?? literals.find(({ family }) => family === 6)
  // Every literal passed the rule above and so has a family; the type does not know it.
  if (!target || target.family === 0) return { ok: false, reason: 'host_not_found' }
  return pin(host, target.address, target.family, true)
}

/**
 * The identity a TLS client must check, always explicit: the name for a name, the literal for an IP literal.
 * Spread into every TLS option object (basic-ftp `secureOptions`, pg `ssl`, `https.request`). Without either
 * field Node checks the certificate against `localhost` when it is handed a ready socket: a leaf for
 * `localhost` would then verify for any IP. Pure; lives here so that both halves of
 * `@repo/site-connections` take it from the domain.
 */
export function tlsIdentity(address: PinnedAddress): { servername: string } | { host: string } {
  return address.isName ? { servername: address.host } : { host: address.address }
}
