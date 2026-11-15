import type { DbConfig } from '@repo/db'
import type { AppEnv } from '@repo/domain'

/** PreviewConfig of this process. */
export const PREVIEW_CONFIG = Symbol('PREVIEW_CONFIG')
/** The clock of the app: Date.now, a test's own in tests. */
export const PREVIEW_CLOCK = Symbol('PREVIEW_CLOCK')

/** Milliseconds since the epoch. */
export type PreviewClock = () => number

/**
 * The preview app (docs/plan/83-remove-projects.md, БП2): the published pages of the workspaces
 * (docs/plan/69-pages.md, Ст4) and the stream of a chat's browser (docs/plan/57-browser-tasks.md,
 * Б12), each on its own listener; the gateway of previews is gone with the projects. At least one
 * listener is configured. Next to its token rather than in config.ts, which re-exports it: the
 * request path takes the configuration without reaching the parsing of the environment.
 */
export interface PreviewConfig {
  appEnv: AppEnv
  /** APP_URL: the Origin of the cabinet a stream of a browser comes from. */
  appUrl: string
  db: DbConfig
  /**
   * The gateway of the stream of a chat's browser on its own listener; null —
   * BROWSER_WORKER_URL and BROWSER_WORKER_TOKEN are unset: no listener.
   */
  browserStream: BrowserStreamConfig | null
  /** The server of published pages on its own listener; null — PAGES_BASE_DOMAIN is unset. */
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
  /** PAGES_HOST: the address it listens on; loopback outside production unless set. */
  host: string | undefined
}

/** The stream gateway's listener and the worker it relays to. Holds the worker's token. */
export interface BrowserStreamConfig {
  /** BROWSER_STREAM_PORT. */
  port: number
  /** BROWSER_STREAM_HOST: the address it listens on; loopback outside production unless set. */
  host: string | undefined
  /** BROWSER_WORKER_URL: the worker's internal origin. */
  workerUrl: string
  /** BROWSER_WORKER_TOKEN: the bearer token of its stream. */
  workerToken: string
}
