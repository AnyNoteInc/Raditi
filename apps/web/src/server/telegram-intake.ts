import 'server-only'

import { readTelegramUpdate, verifyWebhookSecret } from '@repo/telegram'
import type { IntakeAnswer } from '@repo/trpc'
import type { TelegramIncoming } from '@repo/telegram'
import { z } from 'zod'

import { readBodyWithin } from './body-limit'

// The updates of the bot of the chat (docs/plan/80-telegram.md, §7): core reads them from Telegram
// and posts each here with the secret of the bot; so would Telegram itself, were the server
// reachable. 200 — the update is done or was done before, and core confirms it to Telegram; any
// other status — core tries the same update again.

/** An update of Telegram is a few kilobytes; a message is at most 4096 characters. */
export const MAX_TELEGRAM_BODY_BYTES = 256 * 1024

export interface TelegramIntakeRoute {
  /** null — the bot is off here: the route answers 404. */
  secret: string | null
  handle: (update: TelegramIncoming) => Promise<IntakeAnswer>
  /** Core found the topic of a chat gone: the client deleted it in Telegram. */
  topicGone?: (place: { chatId: string; threadId: number }) => Promise<unknown>
  logError?: (line: string) => void
}

/** The one event of core's own on this route (not a Telegram update). */
const topicGoneSchema = z.strictObject({
  raditi_topic_gone: z.strictObject({
    chat_id: z.string().regex(/^-?\d{1,20}$/),
    thread_id: z.number().int().positive(),
  }),
})

const json = (status: number, body: Record<string, unknown>) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } })

export async function handleTelegramIntake(
  request: Request,
  route: TelegramIntakeRoute,
): Promise<Response> {
  if (route.secret === null) return json(404, { ok: false })
  if (!verifyWebhookSecret(request.headers.get('x-telegram-bot-api-secret-token'), route.secret))
    return json(401, { ok: false })
  const body = await readBodyWithin(request, MAX_TELEGRAM_BODY_BYTES)
  if (body === null) return json(413, { ok: false })
  let parsed: unknown
  try {
    parsed = JSON.parse(body.toString('utf8'))
  } catch {
    return json(400, { ok: false })
  }
  const gone = topicGoneSchema.safeParse(parsed)
  if (gone.success) {
    if (route.topicGone === undefined) return json(404, { ok: false })
    try {
      await route.topicGone({
        chatId: gone.data.raditi_topic_gone.chat_id,
        threadId: gone.data.raditi_topic_gone.thread_id,
      })
      return json(200, { ok: true })
    } catch (error) {
      ;(route.logError ?? ((line) => console.error(line)))(
        `[telegram] topic gone failed: ${error instanceof Error ? error.name : 'Error'}`,
      )
      return json(503, { ok: false })
    }
  }
  const update = readTelegramUpdate(parsed)
  if (update === null) return json(400, { ok: false })
  try {
    const answer = await route.handle(update)
    return json(200, { ok: true, answer })
  } catch (error) {
    // The update and its words stay out of the log: the number of the update only.
    ;(route.logError ?? ((line) => console.error(line)))(
      `[telegram] update ${update.updateId} failed: ${error instanceof Error ? error.name : 'Error'}`,
    )
    return json(503, { ok: false })
  }
}
