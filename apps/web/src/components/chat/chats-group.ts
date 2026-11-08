// How the list of chats is shown (docs/plan/61-chats-first.md, К23): one list, the default, or
// folders of projects. The choice is a cookie, so the first paint is right.

export const chatsGroups = ['list', 'projects'] as const
export type ChatsGroup = (typeof chatsGroups)[number]

export const CHATS_GROUP_COOKIE = 'raditi-chats-group'

/** The choice from the cookie; anything else is the default. */
export const parseChatsGroup = (value: string | undefined | null): ChatsGroup =>
  value === 'projects' ? 'projects' : 'list'

/** A year, the whole site: a choice of layout, nothing personal. */
export function rememberChatsGroup(group: ChatsGroup) {
  document.cookie = `${CHATS_GROUP_COOKIE}=${group}; path=/; max-age=31536000; samesite=lax`
}
