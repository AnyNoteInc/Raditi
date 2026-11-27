import {
  VK_API_BASE_URL,
  VK_API_VERSION,
  vkErrorOf,
  vkUnreachable,
  type VkApi,
  type VkComment,
  type VkCommunityInfo,
  type VkPage,
  type VkPost,
} from '@repo/domain'
import { z } from 'zod'

// VK API over https (docs/plan/99-vk-community.md, ВК12): one POST per call, the key in the form
// body, never in the address, so no log of a proxy or of the request line holds it. Every answer is
// checked by zod; an error of VK becomes a refusal of the domain (`vkErrorOf`) without its words.

export type VkFetch = (url: string, init: RequestInit) => Promise<Response>

export interface VkHttpApiOptions {
  /** For tests and the stand's fake of api.vk.com. */
  baseUrl?: string
  timeoutMs?: number
  /** At most this many bytes of an answer are read: a larger one is a failure. */
  maxBodyBytes?: number
  /**
   * The least time between two calls of this object. VK allows a few calls a second for a key;
   * one process spaces all of its calls, a bit wider than that.
   */
  minIntervalMs?: number
  fetch?: VkFetch
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024
const DEFAULT_MIN_INTERVAL_MS = 350
const METHOD_PATTERN = /^[a-z]+\.[A-Za-z]+$/

const envelopeSchema = z.union([
  z.object({ response: z.unknown() }),
  z.object({ error: z.object({ error_code: z.number().int() }) }),
])

const counter = z.object({ count: z.number().int().nonnegative() }).optional()

const groupSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  screen_name: z.string(),
  is_closed: z.number().int(),
})
// 5.194 and later answer `{ groups: [...] }`; earlier — the array itself.
const groupsSchema = z.union([z.object({ groups: z.array(groupSchema) }), z.array(groupSchema)])

const permissionsSchema = z.object({
  permissions: z.array(z.object({ name: z.string() })),
})

const postSchema = z.object({
  id: z.number().int(),
  date: z.number().int(),
  text: z.string().default(''),
  is_pinned: z.number().int().optional(),
  attachments: z.array(z.unknown()).optional(),
  views: counter,
  likes: counter,
  reposts: counter,
  comments: counter,
})
const postsSchema = z.object({
  count: z.number().int().nonnegative(),
  items: z.array(postSchema),
})

const commentSchema = z.object({
  id: z.number().int(),
  from_id: z.number().int().default(0),
  date: z.number().int(),
  text: z.string().default(''),
  reply_to_comment: z.number().int().optional(),
  thread: z.object({ count: z.number().int().nonnegative() }).optional(),
})
const commentsSchema = z.object({
  count: z.number().int().nonnegative(),
  items: z.array(commentSchema),
})

const publishedSchema = z.object({ post_id: z.number().int().positive() })
const repliedSchema = z.object({ comment_id: z.number().int().positive() })

const dateOf = (seconds: number) => new Date(seconds * 1000)

export class VkHttpApi implements VkApi {
  readonly #baseUrl: string
  readonly #timeoutMs: number
  readonly #maxBodyBytes: number
  readonly #minIntervalMs: number
  readonly #fetch: VkFetch
  readonly #now: () => number
  readonly #sleep: (ms: number) => Promise<void>
  #next = 0

  constructor(options: VkHttpApiOptions = {}) {
    this.#baseUrl = options.baseUrl ?? VK_API_BASE_URL
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.#maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
    this.#minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init))
    this.#now = options.now ?? Date.now
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  async community(token: string, groupId?: number): Promise<VkCommunityInfo> {
    const answer = await this.#call(
      'groups.getById',
      token,
      groupId === undefined ? {} : { group_id: String(groupId) },
      groupsSchema,
    )
    const groups = Array.isArray(answer) ? answer : answer.groups
    const group = groups[0]
    if (group === undefined) throw vkErrorOf(100)
    return {
      groupId: group.id,
      name: group.name,
      screenName: group.screen_name,
      isClosed: group.is_closed !== 0,
    }
  }

  async tokenPermissions(token: string): Promise<string[]> {
    const answer = await this.#call('groups.getTokenPermissions', token, {}, permissionsSchema)
    return answer.permissions.map((permission) => permission.name)
  }

  async posts(
    token: string,
    groupId: number,
    page: { count: number; offset: number },
  ): Promise<VkPage<VkPost>> {
    const answer = await this.#call(
      'wall.get',
      token,
      {
        owner_id: String(-groupId),
        count: String(page.count),
        offset: String(page.offset),
        filter: 'owner',
      },
      postsSchema,
    )
    return {
      total: answer.count,
      items: answer.items.map((post) => ({
        id: post.id,
        date: dateOf(post.date),
        text: post.text,
        isPinned: post.is_pinned === 1,
        attachments: post.attachments?.length ?? 0,
        views: post.views?.count ?? 0,
        likes: post.likes?.count ?? 0,
        reposts: post.reposts?.count ?? 0,
        comments: post.comments?.count ?? 0,
      })),
    }
  }

  async comments(
    token: string,
    groupId: number,
    postId: number,
    page: { count: number; offset: number; commentId?: number },
  ): Promise<VkPage<VkComment>> {
    const answer = await this.#call(
      'wall.getComments',
      token,
      {
        owner_id: String(-groupId),
        post_id: String(postId),
        count: String(page.count),
        offset: String(page.offset),
        sort: 'asc',
        thread_items_count: '0',
        ...(page.commentId === undefined ? {} : { comment_id: String(page.commentId) }),
      },
      commentsSchema,
    )
    return {
      total: answer.count,
      items: answer.items.map((comment) => ({
        id: comment.id,
        fromId: comment.from_id,
        date: dateOf(comment.date),
        text: comment.text,
        replyToComment: comment.reply_to_comment ?? null,
        threadCount: comment.thread?.count ?? 0,
      })),
    }
  }

  async publishPost(
    token: string,
    groupId: number,
    post: { text: string; publishAt?: Date },
  ): Promise<{ postId: number }> {
    const answer = await this.#call(
      'wall.post',
      token,
      {
        owner_id: String(-groupId),
        from_group: '1',
        message: post.text,
        ...(post.publishAt === undefined
          ? {}
          : { publish_date: String(Math.floor(post.publishAt.getTime() / 1000)) }),
      },
      publishedSchema,
    )
    return { postId: answer.post_id }
  }

  async replyToComment(
    token: string,
    groupId: number,
    reply: { postId: number; commentId: number; text: string },
  ): Promise<{ commentId: number }> {
    const answer = await this.#call(
      'wall.createComment',
      token,
      {
        owner_id: String(-groupId),
        post_id: String(reply.postId),
        reply_to_comment: String(reply.commentId),
        from_group: String(groupId),
        message: reply.text,
      },
      repliedSchema,
    )
    return { commentId: answer.comment_id }
  }

  async #call<T>(
    method: string,
    token: string,
    params: Record<string, string>,
    schema: z.ZodType<T>,
  ): Promise<T> {
    if (!METHOD_PATTERN.test(method)) throw new Error(`Not a VK API method: ${method}`)
    await this.#pace()
    const body = new URLSearchParams({ ...params, access_token: token, v: VK_API_VERSION })
    let response: Response
    try {
      response = await this.#fetch(`${this.#baseUrl}${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(this.#timeoutMs),
      })
    } catch {
      // The cause may hold the request: never passed on.
      throw vkUnreachable()
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      throw response.status === 429 ? vkErrorOf(6) : vkUnreachable()
    }
    const text = await this.#read(response)
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      throw vkUnreachable()
    }
    const envelope = envelopeSchema.safeParse(json)
    if (!envelope.success) throw vkUnreachable()
    if ('error' in envelope.data) throw vkErrorOf(envelope.data.error.error_code)
    const parsed = schema.safeParse(envelope.data.response)
    if (!parsed.success) throw vkErrorOf(-1)
    return parsed.data
  }

  async #read(response: Response): Promise<string> {
    const reader = response.body?.getReader()
    if (reader === undefined) throw vkUnreachable()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > this.#maxBodyBytes) {
          await reader.cancel().catch(() => undefined)
          throw vkUnreachable()
        }
        chunks.push(value)
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'DomainError') throw error
      throw vkUnreachable()
    }
    return Buffer.concat(chunks).toString('utf8')
  }

  async #pace(): Promise<void> {
    const now = this.#now()
    const at = Math.max(now, this.#next)
    this.#next = at + this.#minIntervalMs
    if (at > now) await this.#sleep(at - now)
  }
}
