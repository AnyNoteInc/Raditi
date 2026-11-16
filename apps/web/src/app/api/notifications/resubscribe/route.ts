import { createCaller, createContext } from '@repo/trpc'

import { env } from '@/env'
import { chatServices } from '@/server/chat-services'
import { handleResubscribe } from '@/server/notification-resubscribe'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * The service worker replaced the Web Push subscription of this browser (docs/plan/82, Зп41):
 * `notification.replaceSubscription` moves the row of the old one to the new one, under the key of
 * now — only the signed-in user's own (Зп37). The body is read within MAX_RESUBSCRIBE_BODY_BYTES by
 * `handleResubscribe`.
 */
export function POST(request: Request): Promise<Response> {
  return handleResubscribe(request, {
    appUrl: () => env.web().appUrl,
    resubscribe: async (headers, body) =>
      createCaller(
        await createContext({ headers, chat: chatServices() }),
      ).notification.replaceSubscription(body as never),
  })
}
