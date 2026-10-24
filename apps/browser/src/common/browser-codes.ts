import {
  browserTaskCodeNames,
  isDomainError,
  isPageBrowserError,
  type BrowserTaskCode,
} from '@repo/domain'

const codes: ReadonlySet<string> = new Set(browserTaskCodeNames)

/**
 * The fixed code (§3.7) of what an action of the browser raised: a code the adapter or the worker
 * gave passes as it is; the port's reasons become theirs; a timeout of the worker's own is the
 * page not answering in time; anything else — whatever a page or Playwright said — is a failed
 * action. Never a message: it may carry an address or a value of a field.
 */
export function browserCodeOf(error: unknown): BrowserTaskCode {
  if (isDomainError(error) && codes.has(error.code)) return error.code as BrowserTaskCode
  if (isPageBrowserError(error)) {
    if (error.reason === 'timeout') return 'BROWSER_TIMEOUT'
    if (error.reason === 'denied') return 'BROWSER_ACTION_DENIED'
    return 'BROWSER_SESSION_UNAVAILABLE'
  }
  if (error instanceof Error && error.name === 'TimeoutError') return 'BROWSER_TIMEOUT'
  return 'BROWSER_ACTION_FAILED'
}

/** The name of an error for the operator's log, never its message. */
export function errorName(error: unknown): string {
  if (isDomainError(error)) return error.code
  if (isPageBrowserError(error)) return `PageBrowserError:${error.reason}`
  if (error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name)) return error.name
  return typeof error
}
