import 'server-only'

import { errorMessage } from '@repo/observability'
import { notFound, unstable_rethrow } from 'next/navigation'
import { cache } from 'react'

import { requireSession, UNAVAILABLE } from '@/lib/access'
import { getServerCaller } from '@/trpc/server'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isNotFound = (error: unknown) =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error.code === 'NOT_FOUND' || error.code === 'BAD_REQUEST')

/**
 * The project of a page, once per request (docs/plan/84-projects.md, ПР6). Someone else's, a
 * deleted one, one that does not exist and an address that is not an id end in the same «not
 * found» page, as a chat does.
 */
export const loadProject = cache(async (projectId: string) => {
  const session = await requireSession()
  if (session === UNAVAILABLE) return UNAVAILABLE
  if (!UUID.test(projectId)) notFound()
  try {
    const project = await (await getServerCaller()).project.get({ projectId })
    return { project, user: session.user }
  } catch (error) {
    unstable_rethrow(error)
    if (isNotFound(error)) notFound()
    console.error(`[web] project lookup failed: ${errorMessage(error)}`)
    return UNAVAILABLE
  }
})
