'use client'

import type { FeedRow } from './chat-types'

// The client's earlier requests for the arrows of the field (docs/plan/75-chat-input-output.md,
// ВВ23). In a chat they are its own requests from the feed; on «Новый чат» — the last ones this
// browser sent, kept in `localStorage` per user. A blocked storage means no history, not an error.

const KEY = 'raditi-prompt-history'
export const PROMPT_HISTORY_LIMIT = 50

/** The words of the client's requests in this feed, the newest first, a repeat once. */
export function requestHistoryOf(rows: readonly FeedRow[]): string[] {
  const texts: string[] = []
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index]
    if (row?.type !== 'feed.request' || !('text' in row) || typeof row.text !== 'string') continue
    if (row.text.trim() === '' || texts.includes(row.text)) continue
    texts.push(row.text)
    if (texts.length === PROMPT_HISTORY_LIMIT) break
  }
  return texts
}

function keyOf(userId: string) {
  return `${KEY}:${userId}`
}

/** The requests this browser sent for the user, the newest first. */
export function readPromptHistory(userId: string): string[] {
  try {
    const kept: unknown = JSON.parse(window.localStorage.getItem(keyOf(userId)) ?? '[]')
    return Array.isArray(kept)
      ? kept
          .filter((item): item is string => typeof item === 'string')
          .slice(0, PROMPT_HISTORY_LIMIT)
      : []
  } catch {
    return []
  }
}

/** Keeps a sent request at the head of the history; the same words move up instead of twice. */
export function rememberPrompt(userId: string, text: string): void {
  if (text.trim() === '') return
  try {
    const next = [text, ...readPromptHistory(userId).filter((item) => item !== text)].slice(
      0,
      PROMPT_HISTORY_LIMIT,
    )
    window.localStorage.setItem(keyOf(userId), JSON.stringify(next))
  } catch {
    // Nothing to keep it in: the history of this browser stays as it was.
  }
}
