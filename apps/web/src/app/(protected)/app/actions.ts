'use server'

import { auth } from '@repo/auth'
import { errorMessage } from '@repo/observability'
import { unstable_rethrow } from 'next/navigation'

import { getRequestHeaders } from '@/lib/session'

/** Ends the session; the caller then loads /sign-in afresh (SignOutButton). */
export async function signOut(): Promise<void> {
  try {
    // nextCookies() in @repo/auth clears the session cookie through Next's cookie store.
    await auth.api.signOut({ headers: await getRequestHeaders() })
  } catch (error) {
    unstable_rethrow(error)
    console.error(`[auth] sign-out failed: ${errorMessage(error)}`)
  }
}
