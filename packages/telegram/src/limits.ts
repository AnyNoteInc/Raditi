/** Bot API limits (https://core.telegram.org/bots/api, https://core.telegram.org/bots/faq). */
export const TELEGRAM_LIMITS = {
  /** sendMessage text, characters after entity parsing. */
  messageTextMax: 4096,
  /** Media caption, characters. */
  captionMax: 1024,
  /** Inline keyboard callback_data, bytes. */
  callbackDataMaxBytes: 64,
  /** setWebhook secret_token: 1–256 characters of A-Z, a-z, 0-9, _ and -. */
  webhookSecretMax: 256,
  /** Deep link /start payload, characters of A-Z, a-z, 0-9, _ and -. */
  startPayloadMax: 64,
  /** Files a bot can download with getFile. */
  downloadMaxBytes: 20 * 1024 * 1024,
  /** Pacing: about 30 messages per second overall, 1 per second per chat, 20 per minute per group. */
  messagesPerSecond: 30,
  messagesPerChatPerSecond: 1,
  messagesPerGroupPerMinute: 20,
  /** One-time code that links a Telegram chat to an account signed in on the site. */
  linkCodeTtlMs: 15 * 60_000,
  linkCodeLength: 8,
} as const
