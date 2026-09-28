import type { AppRouter } from '@repo/trpc'
import { isTRPCClientError, type TRPCLink } from '@trpc/client'
import { observable } from '@trpc/server/observable'

/**
 * Same code as CONSENT_REQUIRED in @repo/trpc: consentedProcedure answers it while the
 * current editions of the required documents are not accepted (152-FZ).
 */
export const CONSENT_REQUIRED = 'CONSENT_REQUIRED'
export const CONSENTS_PATH = '/onboarding/consents'

/** Whether a tRPC call failed because the user has to accept the documents first. */
export function isConsentRequired(error: unknown): boolean {
  return isTRPCClientError<AppRouter>(error) && error.data?.domainCode === CONSENT_REQUIRED
}

export interface BrowserLocation {
  pathname: string
  replace(url: string): void
}

/** Sends the browser to accept the documents; does nothing on the server or on that page. */
export function redirectToConsents(
  location: BrowserLocation | undefined = typeof window === 'undefined'
    ? undefined
    : window.location,
): void {
  if (!location || location.pathname === CONSENTS_PATH) return
  location.replace(CONSENTS_PATH)
}

/**
 * Watches every call (queries, mutations, subscriptions): on CONSENT_REQUIRED it redirects,
 * and the error still reaches the caller as before.
 */
export function consentRedirectLink(
  onConsentRequired: () => void = redirectToConsents,
): TRPCLink<AppRouter> {
  return () =>
    ({ next, op }) =>
      observable((observer) =>
        next(op).subscribe({
          next: (value) => observer.next(value),
          error: (error) => {
            if (isConsentRequired(error)) onConsentRequired()
            observer.error(error)
          },
          complete: () => observer.complete(),
        }),
      )
}
