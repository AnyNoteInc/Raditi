import { Inject, Injectable } from '@nestjs/common'
import { previewTimings } from '@repo/domain'

import { PREVIEW_CLOCK, PREVIEW_CONFIG, type PreviewClock } from '../config/config.tokens.ts'
import type { PreviewGatewayConfig } from '../config/config.ts'
import { previewCookieClaims, verifyPreviewCookie } from '../cookie/preview-cookie.ts'
import { previewGatewayLimits } from '../gateway/limits.ts'
import { PREVIEW_ACCESS_STORE } from './access.tokens.ts'
import type {
  EnterInput,
  PreviewAccessStore,
  PreviewRoute,
  PreviewSessionRecord,
} from './preview-access.ts'
import { TtlCache } from './ttl-cache.ts'

/**
 * What the gateway of previews knows of previews and their sessions (Р19): the row of a host and
 * of a session, reused for a few seconds, and the check of membership and the site, made again
 * at most a minute later and once for requests that wait for it together.
 */
@Injectable()
export class PreviewSessions {
  readonly #store: PreviewAccessStore
  readonly #sessionSecret: string
  readonly #now: PreviewClock
  readonly #routes: TtlCache<string, PreviewRoute | null>
  readonly #sessions: TtlCache<string, PreviewSessionRecord | null>
  readonly #rechecks = new Map<string, Promise<boolean>>()

  constructor(
    @Inject(PREVIEW_ACCESS_STORE) store: PreviewAccessStore,
    @Inject(PREVIEW_CONFIG) config: PreviewGatewayConfig,
    @Inject(PREVIEW_CLOCK) now: PreviewClock,
  ) {
    this.#store = store
    this.#sessionSecret = config.sessionSecret
    this.#now = now
    const { cacheMs, cacheEntries } = previewGatewayLimits
    this.#routes = new TtlCache(cacheMs, cacheEntries, this.#now)
    this.#sessions = new TtlCache(cacheMs, cacheEntries, this.#now)
  }

  async route(hostname: string): Promise<PreviewRoute | null> {
    const cached = this.#routes.get(hostname)
    if (cached !== undefined) return cached
    const route = await this.#store.route(hostname)
    this.#routes.set(hostname, route)
    return route
  }

  /**
   * The session of a request on this preview, by its Cookie header: a cookie whose MAC matches
   * its row, a row that is neither revoked nor expired, of the preview's current access epoch,
   * of the kind this way in takes, and whose membership and site were checked within the last
   * minute.
   */
  async session(
    cookie: string | undefined,
    route: PreviewRoute,
    relayed: boolean,
  ): Promise<PreviewSessionRecord | null> {
    for (const claim of previewCookieClaims(cookie)) {
      const session = await this.#sessionRecord(claim.sessionId)
      if (
        session === null ||
        session.previewId !== route.id ||
        !verifyPreviewCookie(this.#sessionSecret, claim, session, route.hostname) ||
        session.revokedAt !== null ||
        session.expiresAt.getTime() <= this.#now() ||
        session.accessEpoch !== route.accessEpoch ||
        session.kind !== (relayed ? 'browser' : 'user')
      )
        continue
      if (await this.#fresh(session)) return session
    }
    return null
  }

  /** Spends a ticket (PreviewAccessStore.enter); the session it opens is known at once. */
  async enter(input: EnterInput): Promise<PreviewSessionRecord | null> {
    const session = await this.#store.enter(input)
    if (session !== null) this.#sessions.set(session.id, session)
    return session
  }

  async #sessionRecord(id: string): Promise<PreviewSessionRecord | null> {
    const cached = this.#sessions.get(id)
    if (cached !== undefined) return cached
    const session = await this.#store.session(id)
    this.#sessions.set(id, session)
    return session
  }

  /** Membership and the site, checked again at most a minute ago (Р19). */
  async #fresh(session: PreviewSessionRecord): Promise<boolean> {
    const checked = session.checkedAt?.getTime()
    if (
      checked !== undefined &&
      this.#now() - checked < previewTimings.membershipCheckSeconds * 1_000
    )
      return true
    let running = this.#rechecks.get(session.id)
    if (running === undefined) {
      running = this.#store
        .recheck(session.id)
        .then((result) => {
          if (result === null) {
            this.#sessions.set(session.id, { ...session, revokedAt: new Date(this.#now()) })
            return false
          }
          this.#sessions.update(session.id, (record) =>
            record === null ? record : { ...record, checkedAt: result.checkedAt },
          )
          return true
        })
        .finally(() => this.#rechecks.delete(session.id))
      this.#rechecks.set(session.id, running)
    }
    return running
  }
}
