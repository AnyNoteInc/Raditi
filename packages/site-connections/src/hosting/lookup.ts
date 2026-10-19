// A copy of src/lookup.ts of the site connection wizard (plan 39, not merged into this branch yet):
// the deploy job resolves the hosting and the site the same way. The merge keeps one of the two.
import { Resolver } from 'node:dns'

import {
  HostLookupError,
  siteConnectionLimits,
  type HostLookup,
  type LookedUpAddress,
} from '@repo/domain'

/** What the lookup takes of node:dns `Resolver`; a test hands in a scripted one. */
export interface ResolverLike {
  resolve4(
    name: string,
    callback: (error: NodeJS.ErrnoException | null, addresses: string[]) => void,
  ): void
  resolve6(
    name: string,
    callback: (error: NodeJS.ErrnoException | null, addresses: string[]) => void,
  ): void
  /** Ends every query of this resolver; their callbacks fire with ECANCELLED. */
  cancel(): void
}

/** NXDOMAIN, and a name that has no record of the asked type. Every other code is a failed lookup. */
const NOT_FOUND = new Set(['ENOTFOUND', 'ENODATA'])

/**
 * DNS through c-ares (`dns.Resolver`), never `getaddrinfo`: no hosts file, no search domains of the
 * machine, and a query that can be cancelled. Each lookup asks A and AAAA at once on its own
 * resolver (2 tries of dnsMs / 2 each) and is bounded by dnsMs as a whole and by the caller's
 * signal: whichever comes first cancels both queries.
 */
export function createHostLookup(options: { servers?: readonly string[] } = {}): HostLookup {
  const { servers } = options
  // Once at creation, so a wrong list stops the process that configured it, not its first check.
  if (servers) new Resolver().setServers([...servers])
  return createLookupWith(() => {
    const resolver = new Resolver({ timeout: siteConnectionLimits.dnsMs / 2, tries: 2 })
    if (servers) resolver.setServers([...servers])
    return resolver
  })
}

type FamilyAnswer = string[] | 'none'

/**
 * Both families must answer — records or "none" — before the lookup does: a family that failed
 * fails it, because the address rule (resolvePinnedAddress) must see every record of the name. An
 * answer with records of neither family is `not_found`; a failure or the deadline is `timeout`.
 */
export function createLookupWith(makeResolver: () => ResolverLike): HostLookup {
  return (name, signal) =>
    new Promise<LookedUpAddress[]>((resolve, reject) => {
      if (signal.aborted) {
        reject(new HostLookupError('timeout'))
        return
      }
      const resolver = makeResolver()
      const answers: { 4?: FamilyAnswer; 6?: FamilyAnswer } = {}
      let settled = false

      const settle = (outcome: LookedUpAddress[] | HostLookupError) => {
        if (settled) return
        settled = true
        clearTimeout(deadline)
        signal.removeEventListener('abort', onAbort)
        // Harmless once both queries answered; otherwise it ends the one still running.
        resolver.cancel()
        if (outcome instanceof HostLookupError) reject(outcome)
        else resolve(outcome)
      }
      const onAbort = () => settle(new HostLookupError('timeout'))
      const deadline = setTimeout(onAbort, siteConnectionLimits.dnsMs)
      deadline.unref()
      signal.addEventListener('abort', onAbort, { once: true })

      const answered = (family: 4 | 6) => (error: NodeJS.ErrnoException | null, list: string[]) => {
        if (settled) return
        if (error && !NOT_FOUND.has(error.code ?? '')) {
          settle(new HostLookupError('timeout'))
          return
        }
        answers[family] = error || !Array.isArray(list) ? 'none' : list
        const v4 = answers[4]
        const v6 = answers[6]
        if (v4 === undefined || v6 === undefined) return
        const found: LookedUpAddress[] = [
          ...(v4 === 'none' ? [] : v4.map((address) => ({ address, family: 4 as const }))),
          ...(v6 === 'none' ? [] : v6.map((address) => ({ address, family: 6 as const }))),
        ]
        settle(found.length === 0 ? new HostLookupError('not_found') : found)
      }

      try {
        resolver.resolve4(name, answered(4))
        resolver.resolve6(name, answered(6))
      } catch {
        // c-ares refuses some names synchronously (an empty label, say): no such name here.
        settle(new HostLookupError('not_found'))
      }
    })
}
