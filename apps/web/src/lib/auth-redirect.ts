import 'server-only'

import { errorMessage } from '@repo/observability'
import { redirect, unstable_rethrow } from 'next/navigation'

import { DEFAULT_AFTER_SIGN_IN } from './safe-redirect'
import { getSession } from './session'

async function isSignedIn(): Promise<boolean> {
  try {
    return (await getSession()) !== null
  } catch (error) {
    unstable_rethrow(error)
    // The form still renders; signing in reports its own error if the database is down.
    console.error(`[auth] session lookup failed: ${errorMessage(error)}`)
    return false
  }
}

/**
 * Sends a signed-in user from a signed-out-only page (sign-in, sign-up, reset request, email
 * confirmation) on to `target`. Pages call it, not the (auth) layout: a layout does not know its
 * URL or re-render on client navigation, and the new-password page must stay open to anyone
 * holding a reset link.
 */
export async function redirectIfSignedIn(target: string = DEFAULT_AFTER_SIGN_IN): Promise<void> {
  if (await isSignedIn()) redirect(target)
}
