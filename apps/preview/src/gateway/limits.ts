import { previewTimings } from '@repo/domain'

/** What the gateway of previews allows (Р19): its server, proxy, websockets and caches. */
export const previewGatewayLimits = Object.freeze({
  /** A body a visitor sends to the site: a form, a media upload in the admin of the copy. */
  requestBodyBytes: 32 * 1024 * 1024,
  /** All the headers of one request; Node's own default is 16 KiB. */
  headerBytes: 32 * 1024,
  /** The headers of a request arrive within this, the whole request within the next. */
  headersTimeoutMs: 30_000,
  requestTimeoutMs: 120_000,
  /** The site answers (or sends more of its answer) within this, or the gateway gives up. */
  upstreamIdleMs: 60_000,
  /** A websocket with no traffic either way this long is closed. */
  websocketIdleMs: 10 * 60_000,
  /**
   * How often an open websocket is checked again — its preview, session, membership and site
   * (Р19). A quarter of the membership interval: a tunnel never runs a minute and a quarter
   * past a membership that ended.
   */
  tunnelCheckMs: (previewTimings.membershipCheckSeconds * 1_000) / 4,
  /** What the gateway read from the database is reused this long (Р19: at most 5 s). */
  cacheMs: 5_000,
  cacheEntries: 10_000,
})
