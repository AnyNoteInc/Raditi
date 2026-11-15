// The addresses of «Чаты» (docs/plan/61-chats-first.md, К4).

export const CHATS_HREF = '/chats'
/** The last segment of the screen a chat starts from. */
export const NEW_CHAT_SEGMENT = 'new'
export const NEW_CHAT_HREF = `${CHATS_HREF}/${NEW_CHAT_SEGMENT}`

export const chatHref = (taskId: string) => `${CHATS_HREF}/${taskId}`

/** A new chat, with this project chosen in its picker when one is named. */
export const newChatHref = () => NEW_CHAT_HREF
