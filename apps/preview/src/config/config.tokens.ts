import type { DbConfig } from '@repo/db'
import type { AppEnv, PreviewAddress } from '@repo/domain'

import type { PreviewRelayRange } from './browser-relays.ts'

/** PreviewGatewayConfig of this process. */
export const PREVIEW_CONFIG = Symbol('PREVIEW_CONFIG')
/** The clock of the gateway (PreviewClock): Date.now, a test's own in tests. */
export const PREVIEW_CLOCK = Symbol('PREVIEW_CLOCK')

/** Milliseconds since the epoch: the expiry of a session and the age of a cache entry. */
export type PreviewClock = () => number

/**
 * The gateway of previews (docs/plan/53-chat-preview-release.md, Р19): the exact Host to the
 * upstream of its preview, one-time tickets and its own session cookie. Holds the session
 * secret: never log it.
 *
 * Next to its token rather than in config.ts, which re-exports it: the request path (gateway,
 * access, cookie) takes the configuration without reaching the parsing of the environment and
 * @repo/app-bootstrap behind it (preview-request-path).
 */
export interface PreviewGatewayConfig {
  appEnv: AppEnv
  port: number
  address: PreviewAddress
  sessionSecret: string
  /** APP_URL: `frame-ancestors` and the way back to the cabinet. */
  appUrl: string
  db: DbConfig
  /**
   * PREVIEW_BROWSER_RELAYS: the sources that may use the gateway as a forward proxy (the relays
   * of the agent's browser, Р21); empty — the forward proxy is off.
   */
  browserRelays: readonly PreviewRelayRange[]
  /**
   * PREVIEW_GATEWAY_HOST: the address it listens on; undefined — every address (production, in
   * its container). Loopback elsewhere unless set: a Linux stand names the Docker bridge's
   * gateway, where the relay of the agent's browser reaches the host (host.docker.internal).
   */
  host: string | undefined
  /**
   * The gateway of the stream of a task's browser (docs/plan/57-browser-tasks.md, Б12) on its
   * own listener; null — BROWSER_WORKER_URL and BROWSER_WORKER_TOKEN are unset: no listener.
   */
  browserStream: BrowserStreamConfig | null
  /**
   * The server of published pages (docs/plan/69-pages.md, Ст4) on its own listener; null —
   * PAGES_BASE_DOMAIN is unset: no listener.
   */
  pages: PagesListenerConfig | null
}

/** What the server of the pages reads (docs/plan/69-pages.md, Ст4, Ст13, Ст28). */
export interface PagesServerConfig {
  /** PAGES_BASE_DOMAIN. */
  baseDomain: string
  /** The port a page host carries in `Host` outside production (dev, stands); never in production. */
  publicPort?: number
  /** PAGES_COOKIE_SECRET: signs the cookie of a right password. */
  cookieSecret: string
  /** PAGES_ABUSE_EMAIL: the address the stubs name for complaints (Ст28); null — none named. */
  abuseEmail: string | null
}

/** The listener of the pages and what the server reads. Holds the cookie secret: never log it. */
export interface PagesListenerConfig extends PagesServerConfig {
  /** PAGES_PORT. */
  port: number
  /** PAGES_HOST, like PREVIEW_GATEWAY_HOST: loopback outside production unless set. */
  host: string | undefined
}

/** The stream gateway's listener and the worker it relays to. Holds the worker's token. */
export interface BrowserStreamConfig {
  /** BROWSER_STREAM_PORT. */
  port: number
  /** BROWSER_STREAM_HOST, like PREVIEW_GATEWAY_HOST: loopback outside production unless set. */
  host: string | undefined
  /** BROWSER_WORKER_URL: the worker's internal origin. */
  workerUrl: string
  /** BROWSER_WORKER_TOKEN: the bearer token of its stream. */
  workerToken: string
}
