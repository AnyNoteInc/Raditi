import { prisma } from '@repo/db'
import { handleTelegramUpdate } from '@repo/trpc'

import { env } from '@/env'
import { chatServices } from '@/server/chat-services'
import { handleTelegramIntake } from '@/server/telegram-intake'
import { telegramMedia } from '@/server/telegram-media'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** The updates of the bot of the chat, posted by core (docs/plan/80-telegram.md). */
export function POST(request: Request): Promise<Response> {
  const telegram = env.telegram()
  return handleTelegramIntake(request, {
    secret: telegram?.webhookSecret ?? null,
    handle: async (update) => {
      const chat = chatServices()
      if (chat === null) throw new Error('Dialogs are not set up')
      return handleTelegramUpdate(
        { db: prisma, chat, appUrl: env.web().appUrl, media: telegram && telegramMedia(telegram) },
        update,
      )
    },
  })
}
