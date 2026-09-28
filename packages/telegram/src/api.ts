import { z } from 'zod'

import { TELEGRAM_LIMITS } from './limits.ts'
import { createTelegramTransport, type TelegramFetch, type TelegramRequestInit } from './proxy.ts'

export type TelegramApiResult<T> =
  | { ok: true; result: T }
  | {
      ok: false
      description: string
      errorCode?: number
      /** Set on 429: seconds to wait before the next call. */
      retryAfterSec?: number
    }

export interface TelegramBotApiOptions {
  token: string
  /** Egress proxy (TELEGRAM_PROXY_URL); empty means a direct connection. */
  proxyUrl?: string
  /** For tests or a local Bot API server. */
  baseUrl?: string
  timeoutMs?: number
  fetch?: TelegramFetch
}

export interface InlineKeyboardButton {
  text: string
  callback_data?: string
  url?: string
}

export interface SendMessageOptions {
  /** Plain text by default; with 'HTML' the caller escapes <, > and &. */
  parseMode?: 'HTML'
  /** Link previews are off unless asked for. */
  linkPreview?: boolean
  inlineKeyboard?: InlineKeyboardButton[][]
  replyToMessageId?: number
}

export const DEFAULT_ALLOWED_UPDATES = ['message', 'callback_query', 'my_chat_member'] as const

const botUserSchema = z.object({
  id: z.number(),
  is_bot: z.boolean(),
  first_name: z.string(),
  username: z.string().optional(),
})
export type TelegramBotUser = z.infer<typeof botUserSchema>

const sentMessageSchema = z.object({ message_id: z.number() })

const webhookInfoSchema = z.object({
  url: z.string(),
  pending_update_count: z.number(),
  last_error_date: z.number().optional(),
  last_error_message: z.string().optional(),
  allowed_updates: z.array(z.string()).optional(),
})
export type TelegramWebhookInfo = z.infer<typeof webhookInfoSchema>

const envelopeSchema = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  description: z.string().optional(),
  error_code: z.number().optional(),
  parameters: z.object({ retry_after: z.number().optional() }).optional(),
})

const TOKEN_PATTERN = /^\d+:[A-Za-z0-9_-]+$/
const METHOD_PATTERN = /^[A-Za-z]+$/
const DEFAULT_TIMEOUT_MS = 10_000

export interface TelegramBotApi {
  /** Any Bot API method; the result is validated with `schema`. */
  call<T>(
    method: string,
    body: Record<string, unknown> | undefined,
    schema: z.ZodType<T>,
  ): Promise<TelegramApiResult<T>>
  getMe(): Promise<TelegramApiResult<TelegramBotUser>>
  setWebhook(
    url: string,
    secretToken: string,
    opts?: { allowedUpdates?: readonly string[]; dropPendingUpdates?: boolean },
  ): Promise<TelegramApiResult<boolean>>
  deleteWebhook(opts?: { dropPendingUpdates?: boolean }): Promise<TelegramApiResult<boolean>>
  getWebhookInfo(): Promise<TelegramApiResult<TelegramWebhookInfo>>
  sendMessage(
    chatId: number | string,
    text: string,
    opts?: SendMessageOptions,
  ): Promise<TelegramApiResult<{ message_id: number }>>
}

/**
 * Minimal Bot API client. The token is part of every request URL (Bot API contract), so it
 * lives only in this closure and failures surface as err.name or Telegram's own
 * description, never as a message or URL that could carry it into logs.
 */
export function createTelegramBotApi(options: TelegramBotApiOptions): TelegramBotApi {
  if (!TOKEN_PATTERN.test(options.token)) throw new TypeError('Invalid Telegram bot token')
  const token = options.token
  const baseUrl = (options.baseUrl ?? 'https://api.telegram.org').replace(/\/+$/, '')
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const transport = createTelegramTransport(options.proxyUrl, options.fetch)

  async function call<T>(
    method: string,
    body: Record<string, unknown> | undefined,
    schema: z.ZodType<T>,
  ): Promise<TelegramApiResult<T>> {
    if (!METHOD_PATTERN.test(method)) return { ok: false, description: 'Invalid method name' }
    const init: TelegramRequestInit = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    }
    if (transport.dispatcher) init.dispatcher = transport.dispatcher

    let res: Response
    try {
      res = await transport.fetch(`${baseUrl}/bot${token}/${method}`, init)
    } catch (err) {
      return { ok: false, description: err instanceof Error ? err.name : 'FetchError' }
    }

    let json: unknown
    try {
      json = await res.json()
    } catch {
      // Non-JSON body (proxy or HTML error page): the status only, never the body or URL.
      return { ok: false, description: `HTTP ${res.status}`, errorCode: res.status }
    }
    const envelope = envelopeSchema.safeParse(json)
    if (!envelope.success) {
      return { ok: false, description: `HTTP ${res.status}`, errorCode: res.status }
    }
    const e = envelope.data
    if (!e.ok) {
      const failure: TelegramApiResult<T> = {
        ok: false,
        description: e.description ?? `HTTP ${res.status}`,
        errorCode: e.error_code ?? res.status,
      }
      if (e.parameters?.retry_after !== undefined) failure.retryAfterSec = e.parameters.retry_after
      return failure
    }
    const result = schema.safeParse(e.result)
    if (!result.success) return { ok: false, description: 'Unexpected Telegram response' }
    return { ok: true, result: result.data }
  }

  return {
    call,

    getMe() {
      return call('getMe', undefined, botUserSchema)
    },

    setWebhook(url, secretToken, opts = {}) {
      return call(
        'setWebhook',
        {
          url,
          secret_token: secretToken,
          allowed_updates: opts.allowedUpdates ?? DEFAULT_ALLOWED_UPDATES,
          drop_pending_updates: opts.dropPendingUpdates ?? false,
        },
        z.boolean(),
      )
    },

    deleteWebhook(opts = {}) {
      return call(
        'deleteWebhook',
        opts.dropPendingUpdates === undefined
          ? undefined
          : { drop_pending_updates: opts.dropPendingUpdates },
        z.boolean(),
      )
    },

    getWebhookInfo() {
      return call('getWebhookInfo', undefined, webhookInfoSchema)
    },

    async sendMessage(chatId, text, opts = {}) {
      if (text.length === 0 || text.length > TELEGRAM_LIMITS.messageTextMax) {
        return {
          ok: false,
          description: `Message text must be 1–${TELEGRAM_LIMITS.messageTextMax} characters`,
        }
      }
      const body: Record<string, unknown> = {
        chat_id: chatId,
        text,
        link_preview_options: { is_disabled: !(opts.linkPreview ?? false) },
      }
      if (opts.parseMode) body.parse_mode = opts.parseMode
      if (opts.inlineKeyboard) body.reply_markup = { inline_keyboard: opts.inlineKeyboard }
      if (opts.replyToMessageId !== undefined) {
        body.reply_parameters = { message_id: opts.replyToMessageId }
      }
      return call('sendMessage', body, sentMessageSchema)
    },
  }
}
