import { createCaller, createContext } from '@repo/trpc'

import { env } from '@/env'
import { chatServices } from '@/server/chat-services'
import { handleResubscribe } from '@/server/notification-resubscribe'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * The service worker replaced the Web Push subscription of this browser (docs/plan/82, Зп41):
 * `notification.resubscribe` keeps the new one under the key of now. The body is read within
 * MAX_RESUBSCRIBE_BODY_BYTES by `handleResubscribe`.
 */
export function POST(request: Request): Promise<Response> {
  return handleResubscribe(request, {
    appUrl: () => env.web().appUrl,
    resubscribe: async (headers, body) =>
      createCaller(await createContext({ headers, chat: chatServices() })).notification.resubscribe(
        body as never,
      ),
  })
}
