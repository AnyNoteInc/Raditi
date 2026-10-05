import 'server-only'

import { withTimeout } from '@repo/domain'
import { throttledLogger } from '@repo/observability'
import { unstable_rethrow } from 'next/navigation'

import type { ApplicationUser } from '@/components/application/user-avatar'
import { getSession } from '@/lib/session'

export type LandingViewer =
  | { status: 'authenticated'; user: ApplicationUser }
  | { status: 'guest' | 'unavailable'; user: null }

const reportFailure = throttledLogger((line) => console.error(line))

/** Public pages stay open; the client receives display fields, never the session or tokens. */
export async function getLandingViewer(): Promise<LandingViewer> {
  try {
    const session = await withTimeout(getSession(), 3_000, 'Landing session lookup timed out')
    if (!session) return { status: 'guest', user: null }
    return {
      status: 'authenticated',
      user: {
        name: session.user.name,
        lastName: session.user.lastName ?? null,
        email: session.user.email,
        image: session.user.image ?? null,
      },
    }
  } catch (error) {
    unstable_rethrow(error)
    reportFailure('landing session unavailable', error)
    return { status: 'unavailable', user: null }
  }
}
