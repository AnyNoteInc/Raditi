import { z } from 'zod'

// The words of a new chat while the client goes to add a project (docs/plan/61-chats-first.md,
// §5.11): kept for this tab alone. Files stay behind. Storage may be closed to the page, and the
// words are then simply not kept. A tab outlives a session, so the words carry whose they are.

const KEY = 'raditi-new-chat-draft'

const keptDraft = z.object({ userId: z.string(), text: z.string() })

export function keepChatDraft(userId: string, text: string) {
  try {
    if (text === '') sessionStorage.removeItem(KEY)
    else sessionStorage.setItem(KEY, JSON.stringify({ userId, text }))
  } catch {
    // Nothing to do: the wizard opens all the same.
  }
}

/** The words this user kept, once: a draft comes back to one screen, and to no other user. */
export function takeChatDraft(userId: string): string | null {
  try {
    const kept = sessionStorage.getItem(KEY)
    sessionStorage.removeItem(KEY)
    if (kept === null) return null
    const draft = keptDraft.safeParse(JSON.parse(kept))
    return draft.success && draft.data.userId === userId ? draft.data.text : null
  } catch {
    return null
  }
}
