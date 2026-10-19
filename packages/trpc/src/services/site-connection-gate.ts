import { DomainError, siteConnectionLimits } from '@repo/domain'

// The limits of the checks that reach a client's server (docs/plan/39-site-connection-wizard.md, default «д»):
// a check costs one unit, create and replaceAccess two, a user has checkUnitsPerWindow units per
// checkWindowMs; after refusedLoginsPerWindow refused logins at one (user, host, port) that endpoint is not
// tried again in the window; a user runs at most inFlightPerUser checks at once and the process at most
// inFlightPerProcess, a request waiting gateWaitMs for a free place before it is refused. In the memory of
// this process on purpose: with several replicas of web each counts its own — the limits keep the wizard
// from becoming a scanner or a password guesser, they are not a quota.

export interface GateEndpoint {
  host: string
  port: number
}

export interface GateRequest {
  userId: string
  units: number
  /** Where the checks of this request connect: refused while one of them is blocked. */
  endpoints: readonly GateEndpoint[]
}

interface Charge {
  at: number
  units: number
}

const charges = new Map<string, Charge[]>()
const refusedLogins = new Map<string, number[]>()
const userInFlight = new Map<string, number>()
let processInFlight = 0
const waiters = new Set<() => void>()

const checksLimited = () =>
  new DomainError('SITE_CHECKS_LIMITED', 'Too many site connection checks', 429)

const endpointKey = (userId: string, { host, port }: GateEndpoint) =>
  `${userId}\n${host.toLowerCase()}\n${port}`

/** What is still inside the window; an emptied entry leaves the map. */
function recent<T>(map: Map<string, T[]>, key: string, at: (item: T) => number, now: number): T[] {
  const kept = (map.get(key) ?? []).filter(
    (item) => now - at(item) < siteConnectionLimits.checkWindowMs,
  )
  if (kept.length === 0) map.delete(key)
  else map.set(key, kept)
  return kept
}

const unitsUsed = (userId: string, now: number) =>
  recent(charges, userId, (charge) => charge.at, now).reduce((sum, charge) => sum + charge.units, 0)

const isBlocked = (userId: string, endpoint: GateEndpoint, now: number) =>
  recent(refusedLogins, endpointKey(userId, endpoint), (at) => at, now).length >=
  siteConnectionLimits.refusedLoginsPerWindow

/** Throws SITE_CHECKS_LIMITED when the units of the window or a refused endpoint stop the request. */
function judge(request: GateRequest, now: number): void {
  if (unitsUsed(request.userId, now) + request.units > siteConnectionLimits.checkUnitsPerWindow)
    throw checksLimited()
  if (request.endpoints.some((endpoint) => isBlocked(request.userId, endpoint, now)))
    throw checksLimited()
}

function tryTake(userId: string): boolean {
  const mine = userInFlight.get(userId) ?? 0
  if (
    mine >= siteConnectionLimits.inFlightPerUser ||
    processInFlight >= siteConnectionLimits.inFlightPerProcess
  )
    return false
  userInFlight.set(userId, mine + 1)
  processInFlight += 1
  return true
}

function release(userId: string): void {
  const mine = (userInFlight.get(userId) ?? 1) - 1
  if (mine <= 0) userInFlight.delete(userId)
  else userInFlight.set(userId, mine)
  processInFlight = Math.max(0, processInFlight - 1)
  // In the order they came: the first waiter that fits takes the place.
  for (const waiter of [...waiters]) waiter()
}

/** A place among the checks in flight, or SITE_CHECKS_LIMITED after gateWaitMs without one. */
async function acquire(userId: string): Promise<void> {
  if (tryTake(userId)) return
  await new Promise<void>((resolve, reject) => {
    const attempt = () => {
      if (!tryTake(userId)) return
      done()
      resolve()
    }
    const timer = setTimeout(() => {
      done()
      reject(checksLimited())
    }, siteConnectionLimits.gateWaitMs)
    const done = () => {
      clearTimeout(timer)
      waiters.delete(attempt)
    }
    waiters.add(attempt)
  })
}

/**
 * Runs the checks of one request inside the limits; `run` holds a place in flight until it settles. The
 * units are charged once the request has a place — a request refused for want of one costs nothing — and
 * judged again then: other requests may have spent them while this one waited.
 */
export async function passSiteConnectionGate<T>(
  request: GateRequest,
  run: () => Promise<T>,
): Promise<T> {
  judge(request, Date.now())
  await acquire(request.userId)
  try {
    const now = Date.now()
    judge(request, now)
    const mine = charges.get(request.userId) ?? []
    mine.push({ at: now, units: request.units })
    charges.set(request.userId, mine)
    return await run()
  } finally {
    release(request.userId)
  }
}

/** A check of this endpoint ended in `auth_failed`. */
export function noteRefusedLogin(userId: string, endpoint: GateEndpoint): void {
  const key = endpointKey(userId, endpoint)
  const now = Date.now()
  refusedLogins.set(key, [...recent(refusedLogins, key, (at) => at, now), now])
}

/** Tests only: forgets every charge, refusal and place. Waiting requests time out as they would. */
export function resetSiteConnectionGate(): void {
  charges.clear()
  refusedLogins.clear()
  userInFlight.clear()
  processInFlight = 0
}
