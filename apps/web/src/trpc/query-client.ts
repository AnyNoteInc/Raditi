import { QueryClient } from '@tanstack/react-query'

import { isConsentRequired } from './consent-redirect'

/** One retry, as before; none when the documents must be accepted first. */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  return failureCount < 1 && !isConsentRequired(error)
}

export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: 30_000, retry: shouldRetryQuery },
    },
  })
}

let browserQueryClient: { userId: string; client: QueryClient } | undefined

/**
 * A fresh client per server render; one shared client per user in the browser. Sign-in and
 * sign-out reload the page anyway; the user id also covers a session changed in another tab,
 * so cached data of one account never shows up for another.
 */
export function getQueryClient(userId: string): QueryClient {
  if (typeof window === 'undefined') return makeQueryClient()
  if (browserQueryClient?.userId !== userId) {
    browserQueryClient = { userId, client: makeQueryClient() }
  }
  return browserQueryClient.client
}
