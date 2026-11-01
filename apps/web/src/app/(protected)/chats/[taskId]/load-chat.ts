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
 * The chat of a page, once per request, with its project when it has one. A chat of someone else,
 * one that does not exist and an address that is not an id end in the same «not found» page. The
 * page calls it: the layout above is not rendered again on navigation.
 */
export const loadChat = cache(async (taskId: string) => {
  // First the session: without one the visitor goes to the sign-in page, not to «unavailable».
  if ((await requireSession()) === UNAVAILABLE) return UNAVAILABLE
  if (!UUID.test(taskId)) notFound()
  try {
    return await (await getServerCaller()).task.get({ taskId })
  } catch (error) {
    unstable_rethrow(error)
    if (isNotFound(error)) notFound()
    console.error(`[web] chat lookup failed: ${errorMessage(error)}`)
    return UNAVAILABLE
  }
})
