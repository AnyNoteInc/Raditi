// A store of the gateway in memory for its tests: the rows of PostgresPreviewAccess as maps, and
// how often each method was asked. Only for *.test.ts files.
import { randomBytes } from 'node:crypto'

import type { PreviewSessionKind } from '@repo/domain'

import type {
  EnterInput,
  PreviewAccessStore,
  PreviewRoute,
  PreviewSessionRecord,
} from '../access/preview-access.ts'
import { previewTicketHash } from '../cookie/preview-cookie.ts'

export interface Ticket {
  previewId: string
  userId: string | null
  kind: PreviewSessionKind
  expiresAt: number
  usedAt: number | null
}

/** A store in memory, with the semantics of PostgresPreviewAccess. */
export class MemoryAccess implements PreviewAccessStore {
  readonly routes = new Map<string, PreviewRoute>()
  readonly tickets = new Map<string, Ticket>()
  readonly sessions = new Map<string, PreviewSessionRecord>()
  /** Users who are members of the site's workspace. */
  readonly members = new Set<string>(['user-1'])
  readonly calls = { route: 0, enter: 0, session: 0, recheck: 0 }
  #next = 1

  private readonly now: () => number

  constructor(now: () => number) {
    this.now = now
  }

  addRoute(hostname: string, patch: Partial<PreviewRoute> = {}): PreviewRoute {
    const route: PreviewRoute = {
      id: `preview-${hostname.slice(19, 25)}`,
      siteId: 'site-1',
      hostname,
      status: 'ready',
      revision: 1,
      accessEpoch: 0,
      upstream: null,
      ...patch,
    }
    this.routes.set(hostname, route)
    return route
  }

  ticket(
    route: PreviewRoute,
    kind: PreviewSessionKind = 'user',
    patch: Partial<Ticket> = {},
  ): string {
    const token = randomBytes(32).toString('base64url')
    this.tickets.set(previewTicketHash(token), {
      previewId: route.id,
      userId: kind === 'user' ? 'user-1' : null,
      kind,
      expiresAt: this.now() + 60_000,
      usedAt: null,
      ...patch,
    })
    return token
  }

  async route(hostname: string): Promise<PreviewRoute | null> {
    this.calls.route++
    const route = this.routes.get(hostname)
    return route && route.status !== 'destroyed' ? { ...route } : null
  }

  async enter(input: EnterInput): Promise<PreviewSessionRecord | null> {
    this.calls.enter++
    const ticket = this.tickets.get(input.tokenHash)
    if (
      !ticket ||
      ticket.previewId !== input.previewId ||
      ticket.kind !== input.kind ||
      ticket.usedAt !== null ||
      ticket.expiresAt <= this.now()
    )
      return null
    ticket.usedAt = this.now()
    if (ticket.kind === 'user' && !this.members.has(ticket.userId ?? '')) return null
    const route = [...this.routes.values()].find((one) => one.id === input.previewId)!
    const id = `01960000-0000-7000-8000-${String(this.#next++).padStart(12, '0')}`
    const session: PreviewSessionRecord = {
      id,
      previewId: input.previewId,
      userId: ticket.userId,
      kind: ticket.kind,
      accessEpoch: route.accessEpoch,
      expiresAt: new Date(this.now() + 12 * 3_600_000),
      revokedAt: null,
      checkedAt: new Date(this.now()),
    }
    this.sessions.set(id, session)
    return { ...session }
  }

  async session(id: string): Promise<PreviewSessionRecord | null> {
    this.calls.session++
    const session = this.sessions.get(id)
    return session ? { ...session } : null
  }

  async recheck(sessionId: string): Promise<{ checkedAt: Date } | null> {
    this.calls.recheck++
    const session = this.sessions.get(sessionId)!
    if (session.kind === 'browser' || this.members.has(session.userId ?? '')) {
      session.checkedAt = new Date(this.now())
      return { checkedAt: session.checkedAt }
    }
    session.revokedAt = new Date(this.now())
    return null
  }
}
