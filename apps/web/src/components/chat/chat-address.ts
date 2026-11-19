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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The project `?project=<id>` names, when it is an id at all; whose it is the field learns later. */
export const projectOfSearch = (value: string | string[] | undefined): string | null =>
  typeof value === 'string' && UUID.test(value) ? value : null

/**
 * The project chosen by the pill of a new chat, written into the address it stands at — `/chats`
 * or `/chats/new` — so a reload keeps it (owner's request of 19.11.2026). The address is replaced,
 * not navigated to: the words and the files of the field stay.
 */
export function rememberProjectInAddress(projectId: string | null) {
  const address = new URL(window.location.href)
  if (projectId === null) address.searchParams.delete('project')
  else address.searchParams.set('project', projectId)
  if (address.href !== window.location.href)
    window.history.replaceState(null, '', `${address.pathname}${address.search}${address.hash}`)
}

/** «Расписание»: the scheduled tasks of the client (docs/plan/82-scheduled-tasks.md, Зп1). */
export const SCHEDULED_HREF = '/scheduled'

/** A scheduled task: the label of a chat of its run and the card of the feed lead to it. */
export const scheduledTaskHref = (scheduleId: string) => `${SCHEDULED_HREF}/${scheduleId}`
