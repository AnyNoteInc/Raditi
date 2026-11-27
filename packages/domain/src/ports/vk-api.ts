/**
 * VK API port (docs/plan/99-vk-community.md, §1, §3). The adapter (`@repo/vk`) calls api.vk.com
 * with the key it is given and throws the refusals of `vk/errors.ts` (`vkErrorOf`): never VK's
 * own words. A key is an argument of each call, never kept by the adapter: the caller reads it from
 * Vault for this call alone. Which key a method takes is VK's rule (§1): the key of a community
 * (`group`), the service key of Raditi's app (`service`).
 */

/** A community as `groups.getById` names it. */
export interface VkCommunityInfo {
  /** Positive: the wall of a community is its id with a minus. */
  groupId: number
  name: string
  screenName: string
  /** Closed or private: its wall is not read by the service key. */
  isClosed: boolean
}

export interface VkPostCounters {
  views: number
  likes: number
  reposts: number
  comments: number
}

export interface VkPost extends VkPostCounters {
  id: number
  date: Date
  text: string
  isPinned: boolean
  /** A post with photos, a video, a link: the agent says the post has more than text. */
  attachments: number
}

export interface VkComment {
  id: number
  /** A user (positive) or a community (negative). */
  fromId: number
  date: Date
  text: string
  /** The comment this one answers, in a thread. */
  replyToComment: number | null
  /** Answers in its thread. */
  threadCount: number
}

export interface VkPage<T> {
  /** How many there are, of which `items` is a page. */
  total: number
  items: T[]
}

export interface VkApi {
  /** The community of a community key (no id) — or the named one by any key. */
  community(token: string, groupId?: number): Promise<VkCommunityInfo>
  /** The rights of a community key (`groups.getTokenPermissions`): `wall`, `manage` and so on. */
  tokenPermissions(token: string): Promise<string[]>
  /** The wall of a community, newest first (`wall.get`): service key. */
  posts(
    token: string,
    groupId: number,
    page: { count: number; offset: number },
  ): Promise<VkPage<VkPost>>
  /** The comments of a post, oldest first (`wall.getComments`): service key. */
  comments(
    token: string,
    groupId: number,
    postId: number,
    page: { count: number; offset: number; commentId?: number },
  ): Promise<VkPage<VkComment>>
  /** Publishes on the wall from the community (`wall.post`, `from_group=1`): community key. */
  publishPost(
    token: string,
    groupId: number,
    post: { text: string; publishAt?: Date },
  ): Promise<{ postId: number }>
  /** Replies to a comment from the community (`wall.createComment`): community key. */
  replyToComment(
    token: string,
    groupId: number,
    reply: { postId: number; commentId: number; text: string },
  ): Promise<{ commentId: number }>
}

/** The address of a post for the client and the agent. */
export const vkPostUrl = (groupId: number, postId: number): string =>
  `https://vk.com/wall-${groupId}_${postId}`

/** The address of a comment: the post with its reply open. */
export const vkCommentUrl = (groupId: number, postId: number, commentId: number): string =>
  `${vkPostUrl(groupId, postId)}?reply=${commentId}`
