import {
  FEED_REQUEST_TEXT_LIMIT,
  feedLimits,
  feedRequestPayloadSchema,
  feedText,
  hasVisibleText,
  looksLikeSecret,
  type FeedRequestPayload,
} from '@repo/domain'

import { taskTextEmpty, taskTextHasSecret, taskTextInvalid, taskTextTooLong } from './refusals.ts'

/**
 * The client's words on their way into the feed (`task.create`, `task.message`): refused in
 * the client's terms before anything is written — nothing to read, too long, a password or a
 * key (spec §7, «Лента для клиента»). The row's own schema then refuses what it cannot store.
 */
export function requestText(text: string): string {
  const trimmed = text.trim()
  if (!hasVisibleText(trimmed)) throw taskTextEmpty()
  if (trimmed.length > FEED_REQUEST_TEXT_LIMIT) throw taskTextTooLong()
  if (looksLikeSecret(trimmed)) throw taskTextHasSecret()
  return trimmed
}

/** The payload of a `feed.request`, checked before the transaction that writes it. */
export function requestPayload(payload: FeedRequestPayload): FeedRequestPayload {
  const parsed = feedRequestPayloadSchema.safeParse(payload)
  if (!parsed.success) throw taskTextInvalid()
  return parsed.data
}

/**
 * `tasks.title` from the first request: its first line with something to read, as the feed
 * would show it, spaces collapsed, at most 120 characters with an ellipsis. null — nothing to
 * show (the list then names the dialog by its status).
 */
export function dialogTitle(text: string): string | null {
  const line = feedText(text)
    .split('\n')
    .map((part) => part.replace(/\s+/gu, ' ').trim())
    .find((part) => hasVisibleText(part))
  if (line === undefined) return null
  if (line.length <= feedLimits.title) return line
  // Whole code points, so a pair of surrogates is never cut in two.
  let cut = ''
  for (const character of line) {
    if (cut.length + character.length > feedLimits.title - 1) break
    cut += character
  }
  return `${cut.trimEnd()}…`
}
