// The addresses of «Чаты» (docs/plan/61-chats-first.md, К4).

export const CHATS_HREF = '/chats'
/** The last segment of the screen a chat starts from. */
export const NEW_CHAT_SEGMENT = 'new'
export const NEW_CHAT_HREF = `${CHATS_HREF}/${NEW_CHAT_SEGMENT}`

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const chatHref = (taskId: string) => `${CHATS_HREF}/${taskId}`

/** A new chat, with this project chosen in its picker when one is named. */
export const newChatHref = (projectId?: string | null) =>
  projectId ? `${NEW_CHAT_HREF}?project=${projectId}` : NEW_CHAT_HREF

/** The list of chats open on the folder of a project (К40). */
export const chatFolderHref = (projectId: string) => `${CHATS_HREF}?folder=${projectId}`

/**
 * Where an old address of the chat of a project leads, by what stands after `/chat`: the list, a
 * new chat of that project, or one chat. Anything else is no address: null.
 */
export function movedChatAddress(projectId: string, rest: readonly string[]): string | null {
  if (rest.length === 0) return CHATS_HREF
  if (rest.length > 1) return null
  const [segment = ''] = rest
  if (segment === NEW_CHAT_SEGMENT) return newChatHref(projectId)
  return UUID.test(segment) ? chatHref(segment) : null
}
