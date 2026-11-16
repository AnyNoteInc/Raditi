// The addresses of «Чаты» (docs/plan/61-chats-first.md, К4).

export const CHATS_HREF = '/chats'
/** The last segment of the screen a chat starts from. */
export const NEW_CHAT_SEGMENT = 'new'
export const NEW_CHAT_HREF = `${CHATS_HREF}/${NEW_CHAT_SEGMENT}`

export const chatHref = (taskId: string) => `${CHATS_HREF}/${taskId}`

/**
 * A new chat, with this project chosen in its picker when one is named (docs/plan/84-projects.md,
 * ПР30).
 */
export const newChatHref = (projectId: string | null = null) =>
  projectId === null ? NEW_CHAT_HREF : `${NEW_CHAT_HREF}?project=${encodeURIComponent(projectId)}`

/** «Расписание»: the scheduled tasks of the client (docs/plan/82-scheduled-tasks.md, Зп1). */
export const SCHEDULED_HREF = '/scheduled'

/** A scheduled task: the label of a chat of its run and the card of the feed lead to it. */
export const scheduledTaskHref = (scheduleId: string) => `${SCHEDULED_HREF}/${scheduleId}`
