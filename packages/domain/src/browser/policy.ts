import type {
  BrowserCheckpointRef,
  BrowserCommitAction,
  BrowserVerificationPlan,
} from './checkpoint.ts'
import type { BrowserController } from './session.ts'

/**
 * Where a chat's browser starts and what it may not open or send (docs/plan/57-browser-tasks.md,
 * Б21). Since projects went (docs/plan/83-remove-projects.md) every session is the open web
 * (`OPEN_WEB_POLICY`); the shape stays the seam a policy would plug into. `pageDenied` is checked on
 * every navigation of a page, `requestDenied` on every request it makes; `by` — who holds the
 * browser, absent — the agent.
 */
export interface BrowserTaskPolicy {
  /** With one leading `/`. */
  startPath: string
  /** Hosts the pages load from besides their own: `host` or `host:port`. */
  extraHosts: readonly string[]
  requestDenied(request: BrowserPageRequest, by?: BrowserController): boolean
  pageDenied(path: string, by?: BrowserController): boolean
}

/** One request of a page of the browser, as the policy sees it. */
export interface BrowserPageRequest {
  /** Path with its query. */
  path: string
  method: string
  /** The body of a form or XHR as the page sends it; null — none or not text. */
  postData: string | null
}

/** What a session asks about the objects of its chat (Б22): none on the open web. */
export interface BrowserObjects {
  browserCheckpointOf(url: string): BrowserCheckpointRef | null
  browserCommitAction(role: string, name: string, pageUrl?: string): BrowserCommitAction | null
  browserVerification(ref: BrowserCheckpointRef): BrowserVerificationPlan
}

/** Raised by a browser adapter for what the caller turns into a fixed code; never a page's message. */
export const pageBrowserFailures = [
  /** The element is not there, or the expectation did not come true in time. */
  'timeout',
  /** The page went to another origin, or the policy refused where it went. */
  'denied',
  /** The browser or its connection is gone. */
  'closed',
] as const
export type PageBrowserFailure = (typeof pageBrowserFailures)[number]

export class PageBrowserError extends Error {
  readonly reason: PageBrowserFailure

  constructor(reason: PageBrowserFailure) {
    super(`Page browser: ${reason}`)
    this.name = 'PageBrowserError'
    this.reason = reason
  }
}

/** Checks the name, not `instanceof`: works across duplicated module instances. */
export function isPageBrowserError(error: unknown): error is PageBrowserError {
  return error instanceof Error && error.name === 'PageBrowserError'
}
