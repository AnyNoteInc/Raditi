import { getSessionFromHeaders } from '@repo/auth'
import { prisma } from '@repo/db'
import { isDomainError } from '@repo/domain'
import { readChatNotification } from '@repo/trpc'
import { z } from 'zod'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ids = z.uuid()

/**
 * The words of a notification the service worker got the id of by Web Push
 * (docs/plan/75-chat-input-output.md, ВВ8): the push itself carries nothing of the chat. Only the
 * signed-in user it was sent to reads it; the cookie of the session comes with the request of the
 * worker, which runs on the origin of the cabinet.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const headers = { 'cache-control': 'no-store', 'content-type': 'application/json' }
  const id = ids.safeParse((await params).id)
  if (!id.success) return new Response('{}', { status: 404, headers })
  const session = await getSessionFromHeaders(request.headers)
  if (!session) return new Response('{}', { status: 401, headers })
  try {
    const words = await readChatNotification(prisma, session.user.id, id.data)
    return new Response(JSON.stringify(words), { status: 200, headers })
  } catch (error) {
    if (isDomainError(error) && error.code === 'NOT_FOUND')
      return new Response('{}', { status: 404, headers })
    throw error
  }
}
