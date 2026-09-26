import 'server-only'

import type { Session } from '@repo/auth'
import { redirect, unstable_rethrow } from 'next/navigation'
import { cache } from 'react'

import { describeError } from '@/server/errors'
import { getServerCaller } from '@/trpc/server'

import { REQUEST_PATH_HEADER } from './request-path'
import { safeRedirectTarget } from './safe-redirect'
import { getRequestHeaders, getSession } from './session'

/** The database (or auth) did not answer: the caller shows ServiceUnavailable. */
export const UNAVAILABLE = 'unavailable' as const

function logFailure(what: string, error: unknown) {
  // Next's own control flow (dynamic rendering bailout, redirect) is not a failure.
  unstable_rethrow(error)
  console.error(`[web] ${what} failed: ${describeError(error)}`)
}

/**
 * The signed-in session, or a redirect to the sign-in page that brings the user back here.
 * Returns UNAVAILABLE instead of throwing when the session cannot be looked up. Layouts and
 * pages render side by side, so both call it; it runs once per request.
 */
export const requireSession = cache(async (): Promise<Session | typeof UNAVAILABLE> => {
  let session: Session | null
  try {
    session = await getSession()
  } catch (error) {
    logFailure('session lookup', error)
    return UNAVAILABLE
  }
  if (!session) {
    const path = (await getRequestHeaders()).get(REQUEST_PATH_HEADER)
    redirect(`/sign-in?next=${encodeURIComponent(safeRedirectTarget(path))}`)
  }
  return session
})

/**
 * Whether the current editions of all required documents are accepted (152-FZ): without them
 * the cabinet sends the user to /onboarding/consents. UNAVAILABLE when it cannot be checked.
 */
export const hasRequiredConsents = cache(async (): Promise<boolean | typeof UNAVAILABLE> => {
  try {
    const consents = await (await getServerCaller()).consent.list()
    return consents.every((consent) => !consent.required || consent.accepted)
  } catch (error) {
    logFailure('consent check', error)
    return UNAVAILABLE
  }
})
