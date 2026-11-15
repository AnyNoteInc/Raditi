import { z } from 'zod'

// What the bot of the chat reads of an update (docs/plan/80-telegram.md): a message of a private
// chat — its words, a voice, a photo, a document, its topic — and a press of a button. Anything
// else is an update to skip. Unknown fields are dropped, so a newer Bot API does not break it.

const userSchema = z.object({
  id: z.number().int(),
  is_bot: z.boolean().optional(),
  username: z.string().max(64).optional(),
  first_name: z.string().optional(),
  language_code: z.string().optional(),
})

const chatSchema = z.object({ id: z.number().int(), type: z.string() })

const fileSchema = z.object({
  file_id: z.string().min(1).max(256),
  file_unique_id: z.string().optional(),
  file_size: z.number().int().nonnegative().optional(),
})

const messageSchema = z.object({
  message_id: z.number().int(),
  date: z.number().int(),
  chat: chatSchema,
  from: userSchema.optional(),
  /** A topic of a private chat with topics (Bot API 9.3) or of a forum. */
  message_thread_id: z.number().int().positive().optional(),
  is_topic_message: z.boolean().optional(),
  text: z.string().optional(),
  caption: z.string().optional(),
  voice: fileSchema
    .extend({ duration: z.number().int().nonnegative(), mime_type: z.string().optional() })
    .optional(),
  audio: fileSchema
    .extend({
      duration: z.number().int().nonnegative().optional(),
      mime_type: z.string().optional(),
      file_name: z.string().optional(),
    })
    .optional(),
  /** Sizes of one photo, smallest first. */
  photo: z
    .array(fileSchema.extend({ width: z.number().int(), height: z.number().int() }))
    .optional(),
  document: fileSchema
    .extend({ file_name: z.string().optional(), mime_type: z.string().optional() })
    .optional(),
  forum_topic_created: z.object({ name: z.string() }).optional(),
})
export type TelegramMessage = z.infer<typeof messageSchema>

const callbackSchema = z.object({
  id: z.string(),
  from: userSchema,
  data: z.string().optional(),
  message: z
    .object({
      message_id: z.number().int(),
      chat: chatSchema,
      message_thread_id: z.number().int().positive().optional(),
    })
    .optional(),
})
export type TelegramPress = z.infer<typeof callbackSchema>

const incomingSchema = z.object({
  update_id: z.number().int().nonnegative(),
  message: messageSchema.optional(),
  callback_query: callbackSchema.optional(),
})

/** One update as the bot reads it. */
export type TelegramIncoming =
  | { updateId: number; kind: 'message'; message: TelegramMessage }
  | { updateId: number; kind: 'press'; press: TelegramPress }
  | { updateId: number; kind: 'other' }

/**
 * Reads one update; null — not an update at all (no `update_id`). A message of a group, of a
 * channel or from a bot is `other`: the bot of the chat answers only people in private chats.
 */
export function readTelegramUpdate(body: unknown): TelegramIncoming | null {
  const parsed = incomingSchema.safeParse(body)
  if (!parsed.success) {
    const id = z.object({ update_id: z.number().int().nonnegative() }).safeParse(body)
    return id.success ? { updateId: id.data.update_id, kind: 'other' } : null
  }
  const update = parsed.data
  const message = update.message
  if (
    message &&
    message.chat.type === 'private' &&
    message.from &&
    !message.from.is_bot &&
    carriesWords(message)
  )
    return { updateId: update.update_id, kind: 'message', message }
  const press = update.callback_query
  if (press && (press.message === undefined || press.message.chat.type === 'private'))
    return { updateId: update.update_id, kind: 'press', press }
  return { updateId: update.update_id, kind: 'other' }
}

/**
 * A message the client wrote: words, a voice or a file. A service message — a topic created,
 * renamed or closed — carries none and is skipped without an answer.
 */
const carriesWords = (message: TelegramMessage): boolean =>
  (message.text ?? message.caption ?? '').trim() !== '' ||
  message.voice !== undefined ||
  message.audio !== undefined ||
  (message.photo?.length ?? 0) > 0 ||
  message.document !== undefined

/** The words of a message: its text, or the caption of its file. */
export const messageWords = (message: TelegramMessage): string =>
  (message.text ?? message.caption ?? '').trim()

/** A command at the start of a message: `/start CODE` → `{ name: 'start', arg: 'CODE' }`. */
export function messageCommand(message: TelegramMessage): { name: string; arg: string } | null {
  const text = message.text?.trim()
  if (!text?.startsWith('/')) return null
  const match = /^\/([a-z_]{1,32})(?:@[A-Za-z0-9_]{1,64})?(?:\s+([\s\S]*))?$/u.exec(text)
  if (!match) return null
  return { name: match[1]!, arg: (match[2] ?? '').trim() }
}
