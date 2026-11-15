import { Logger } from '@nestjs/common'
import { enqueueTelegramSend, type PrismaClient } from '@repo/db'
import {
  isPushEndpoint,
  notificationPushPayloadSchema,
  urgentNotificationKinds,
  withTimeout,
  type NotificationKind,
} from '@repo/domain'
import { enqueueNotification } from '@repo/notifications'

// The channels of a notice (docs/plan/75-chat-input-output.md, ВВ6–ВВ11; docs/plan/82-scheduled-
// tasks.md, Зп37–Зп41): one row of `chat_notifications`, then Web Push to every browser the client
// turned it on in, a letter and a message of the bot. The row is written once — a repeat of the
// job finds it and sends nothing (`ON CONFLICT DO NOTHING`). A push carries no word of the client
// — the id of the notice, the path it opens, its kind and its tag; the service worker reads the
// words from the cabinet, so nothing of the chat crosses the push services, which are abroad
// (rule 1). A letter says nothing but what happened, at most one in 30 minutes per chat or per
// scheduled task. ChatNotify and ScheduleNotify decide what to tell; this sends it.

/** At most one letter per chat — or per scheduled task — and client in this time. */
export const LETTER_PAUSE_MS = 30 * 60_000
/** A push service that does not answer in this time is given up for this notice (Зп41). */
export const PUSH_TIMEOUT_MS = 10_000
/** How long a push service keeps a notice for a browser that is off (Зп41). */
export const PUSH_TTL_SECONDS = 24 * 60 * 60
/** The subject of VAPID when APP_URL is not https (dev): the push services refuse http (Зп41). */
export const VAPID_FALLBACK_SUBJECT = 'https://raditi.ru'

/** A browser of the client that takes Web Push. */
export interface PushTarget {
  endpoint: string
  p256dh: string
  auth: string
}

export interface PushOptions {
  urgency: 'normal' | 'high'
  ttlSeconds: number
}

/**
 * What a push service answered: `gone` — the browser dropped the subscription (404, 410);
 * `forbidden` — 403, which a service also answers to a fault of the sender (Зп41).
 */
export type PushAnswer = 'sent' | 'gone' | 'forbidden'

/** Sends one Web Push signed with the VAPID key of the platform. */
export interface PushSender {
  /** The public VAPID key it signs with: a 403 drops a subscription made under another one. */
  readonly publicKey: string
  send(target: PushTarget, payload: string, options: PushOptions): Promise<PushAnswer>
}

/** What a notice is of and where it leads. */
export interface Notice {
  /** Who is told: the author of the chat, the creator of the task. */
  userId: string
  kind: NotificationKind
  /** The pass of a chat it tells of; null — a notice of a scheduled task itself. */
  chat: { taskId: string; attempt: number; turnNo: number } | null
  /** The scheduled task it is of (a pass without its client, or the task itself), and its run. */
  schedule: { id: string; runId: string | null } | null
  /** The path of the cabinet it opens: the chat, or the page of the task. */
  path: string
  /** Whether a letter may tell of it at all (Зп39). */
  letter: boolean
  /** What the bot says, and the name of its one button; null — the bot says nothing. */
  telegram: { text: string; button: string } | null
}

/** `sent` — some channel took it; `skipped` — none did; `repeated` — told before, nothing sent. */
export type DeliveryAnswer = 'sent' | 'skipped' | 'repeated'

export interface NotificationDeliveryDependencies {
  db: Pick<
    PrismaClient,
    | '$transaction'
    | 'chatNotification'
    | 'channelIdentity'
    | 'notificationSetting'
    | 'outboxEvent'
    | 'pushSubscription'
    | 'task'
    | 'user'
  >
  /** The public origin of the cabinet (APP_URL): letters and the bot link under it. */
  appUrl: string
  /** null — Web Push is not configured (`WEB_PUSH_*`): letters and the bot still go. */
  push: PushSender | null
  logger?: { log(message: string): void; warn(message: string): void }
  now?: () => Date
}

const URGENT: ReadonlySet<NotificationKind> = new Set(urgentNotificationKinds)

export class NotificationDelivery {
  readonly #logger: { log(message: string): void; warn(message: string): void }
  readonly #now: () => Date

  constructor(private readonly deps: NotificationDeliveryDependencies) {
    this.#logger = deps.logger ?? new Logger('NotificationDelivery')
    this.#now = deps.now ?? (() => new Date())
  }

  async deliver(notice: Notice): Promise<DeliveryAnswer> {
    const { db } = this.deps
    const now = this.#now()
    // One row a kind per pass and per run: a repeat of the job inserts nothing and sends nothing.
    const [row] = await db.chatNotification.createManyAndReturn({
      data: [
        {
          userId: notice.userId,
          kind: notice.kind,
          taskId: notice.chat?.taskId ?? null,
          attempt: notice.chat?.attempt ?? null,
          turnNo: notice.chat?.turnNo ?? null,
          scheduledTaskId: notice.schedule?.id ?? null,
          scheduledRunId: notice.schedule?.runId ?? null,
        },
      ],
      skipDuplicates: true,
      select: { id: true },
    })
    if (!row) return 'repeated'
    const [settings, user] = await Promise.all([
      db.notificationSetting.findUnique({ where: { userId: notice.userId } }),
      db.user.findUnique({
        where: { id: notice.userId },
        select: { email: true, emailVerified: true },
      }),
    ])
    // One channel that fails keeps neither the others nor the count: the row is written once, and
    // a repeat of the job would send nothing.
    const pushed = await this.#channel('push', 0, () => this.#push(notice, row.id, now))
    const emailed =
      notice.letter &&
      (settings?.email ?? true) &&
      user?.emailVerified === true &&
      (await this.#channel('letter', false, () => this.#letter(notice, row.id, user.email, now)))
    const told =
      (settings?.telegram ?? true) &&
      (await this.#channel('telegram', false, () => this.#telegram(notice, row.id)))
    await db.chatNotification.update({ where: { id: row.id }, data: { pushed } })
    return pushed > 0 || emailed || told ? 'sent' : 'skipped'
  }

  async #channel<T>(name: string, none: T, send: () => Promise<T>): Promise<T> {
    try {
      return await send()
    } catch (error) {
      this.#logger.warn(
        `notice_channel_failed channel=${name} reason=${error instanceof Error ? error.name : 'unknown'}`,
      )
      return none
    }
  }

  /**
   * Every browser the client turned Web Push on in (Зп37): its row exists only there. All at once,
   * each within PUSH_TIMEOUT_MS; one that does not answer does not keep the others (Зп41).
   */
  async #push(notice: Notice, id: string, now: Date): Promise<number> {
    const { db, push } = this.deps
    if (!push) return 0
    const targets = await db.pushSubscription.findMany({
      where: { userId: notice.userId },
      select: { id: true, endpoint: true, p256dh: true, auth: true, vapidKey: true },
    })
    if (targets.length === 0) return 0
    const payload = JSON.stringify(
      notificationPushPayloadSchema.parse({
        id,
        path: notice.path,
        kind: notice.kind,
        scheduled: notice.schedule !== null,
        // A newer run of the task replaces the notice of the one before it (Зп40).
        tag: notice.schedule ? `schedule:${notice.schedule.id}` : `chat:${notice.chat?.taskId}`,
      }),
    )
    const options: PushOptions = {
      urgency: URGENT.has(notice.kind) ? 'high' : 'normal',
      ttlSeconds: PUSH_TTL_SECONDS,
    }
    const results = await Promise.allSettled(
      targets.map((target) => this.#pushOne(push, target, payload, options, now)),
    )
    return results.filter((result) => result.status === 'fulfilled' && result.value).length
  }

  async #pushOne(
    push: PushSender,
    target: PushTarget & { id: string; vapidKey: string | null },
    payload: string,
    options: PushOptions,
    now: Date,
  ): Promise<boolean> {
    const { db } = this.deps
    // A subscription kept before the check, or written around it, is not sent to: core is
    // never a client of anything but a push service of a browser.
    if (!isPushEndpoint(target.endpoint)) {
      await db.pushSubscription.deleteMany({ where: { id: target.id } })
      return false
    }
    let answer: PushAnswer
    try {
      answer = await withTimeout(
        push.send(target, payload, options),
        PUSH_TIMEOUT_MS,
        'The push service did not answer in time',
      )
    } catch (error) {
      this.#logger.warn(
        `chat_push_failed reason=${error instanceof Error ? error.name : 'unknown'}`,
      )
      return false
    }
    if (answer === 'gone') {
      await db.pushSubscription.deleteMany({ where: { id: target.id } })
      return false
    }
    if (answer === 'forbidden') {
      // A subscription made under another VAPID key is dead for good; under this one a 403 may be
      // a fault of ours (Apple answers it too), and the browser is kept.
      if (target.vapidKey !== null && target.vapidKey !== push.publicKey)
        await db.pushSubscription.deleteMany({ where: { id: target.id } })
      else this.#logger.warn('chat_push_forbidden: the push service refused the VAPID signature')
      return false
    }
    await db.pushSubscription.updateMany({ where: { id: target.id }, data: { lastUsedAt: now } })
    return true
  }

  /** A letter with a link only (ВВ9): at most one in LETTER_PAUSE_MS per chat or scheduled task. */
  async #letter(notice: Notice, id: string, to: string, now: Date): Promise<boolean> {
    const { db, appUrl } = this.deps
    const recent = await db.chatNotification.count({
      where: {
        userId: notice.userId,
        emailed: true,
        createdAt: { gt: new Date(now.getTime() - LETTER_PAUSE_MS) },
        ...(notice.schedule
          ? { scheduledTaskId: notice.schedule.id }
          : { taskId: notice.chat?.taskId ?? null }),
      },
    })
    if (recent > 0) return false
    await db.$transaction(async (tx) => {
      await enqueueNotification(
        'chat.waiting',
        {
          to,
          kind: notice.kind,
          ...(notice.schedule ? { scheduled: true } : {}),
          url: `${appUrl}${notice.path}`,
          settingsUrl: `${appUrl}/settings`,
        },
        { db: tx, dedupeKey: `chat.waiting:${id}` },
      )
      await tx.chatNotification.update({ where: { id }, data: { emailed: true } })
    })
    return true
  }

  /**
   * The third channel (docs/plan/80-telegram.md, Т8): the bot tells a client who linked Telegram.
   * A chat bound to Telegram gets its rows there anyway.
   */
  async #telegram(notice: Notice, id: string): Promise<boolean> {
    const { db, appUrl } = this.deps
    if (!notice.telegram) return false
    const identity = await db.channelIdentity.findUnique({
      where: { userId_channel: { userId: notice.userId, channel: 'telegram' } },
      select: { externalId: true },
    })
    if (!identity) return false
    if (notice.chat) {
      const chat = await db.task.findUnique({
        where: { id: notice.chat.taskId },
        select: { chatSession: { select: { channel: true } } },
      })
      if (chat?.chatSession?.channel === 'telegram') return false
    }
    return enqueueTelegramSend(
      db,
      {
        chatId: identity.externalId,
        text: notice.telegram.text,
        buttons: [[{ text: notice.telegram.button, url: `${appUrl}${notice.path}` }]],
      },
      `notify:${id}`,
    )
  }
}

/** The subject of VAPID (Зп41): the cabinet when it is https, else the platform's own site. */
export const vapidSubjectOf = (appUrl: string): string =>
  appUrl.startsWith('https://') ? appUrl : VAPID_FALLBACK_SUBJECT

/** Web Push by `web-push` with the VAPID keys of the platform (Зп41). */
export async function webPushSender(keys: {
  publicKey: string
  privateKey: string
  /** APP_URL: the subject of VAPID when it is https. */
  appUrl: string
}): Promise<PushSender> {
  const webPush = await import('web-push')
  const subject = vapidSubjectOf(keys.appUrl)
  return {
    publicKey: keys.publicKey,
    async send(target, payload, options) {
      try {
        await webPush.sendNotification(
          { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
          payload,
          {
            TTL: options.ttlSeconds,
            urgency: options.urgency,
            timeout: PUSH_TIMEOUT_MS,
            vapidDetails: { subject, publicKey: keys.publicKey, privateKey: keys.privateKey },
          },
        )
        return 'sent'
      } catch (error) {
        const status = (error as { statusCode?: unknown }).statusCode
        if (status === 404 || status === 410) return 'gone'
        if (status === 403) return 'forbidden'
        throw error
      }
    },
  }
}

/**
 * The channels of the process: Web Push when its VAPID keys are set (`config.webPush`), letters
 * and the bot always. TasksModule and SchedulesModule build one each, over the same rows.
 */
export async function notificationDeliveryOf(
  db: NotificationDeliveryDependencies['db'],
  config: {
    billing: { appUrl: string }
    webPush: { publicKey: string; privateKey: string } | null
  },
): Promise<NotificationDelivery> {
  const appUrl = config.billing.appUrl
  return new NotificationDelivery({
    db,
    appUrl,
    push: config.webPush ? await webPushSender({ ...config.webPush, appUrl }) : null,
    logger: new Logger('NotificationDelivery'),
  })
}
