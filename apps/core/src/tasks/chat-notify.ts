import { Logger } from '@nestjs/common'
import type { PrismaClient } from '@repo/db'
import { isPushEndpoint, type ChatNotifyJob, type TaskStatus } from '@repo/domain'
import { enqueueNotification } from '@repo/notifications'

// A chat waits for its client after a pass (docs/plan/75-chat-input-output.md, ВВ6–ВВ11): the
// agent answered, asked, brought changes, failed or ran out of credits. When the job is due core
// tells the author of the chat — unless the chat went on meanwhile (the queue started the next
// pass) or the client looks at it now. Web Push goes to the browsers the client turned it on in;
// its payload is only the id of the notification, the service worker reads the words from the
// cabinet, so nothing of the chat crosses the push services, which are abroad (rule 1). A letter
// goes when letters are on, at most one in 30 minutes per chat, and says nothing of the chat but
// what happened.

/** The client looked at the chat this recently: no notification. */
export const PRESENCE_FRESH_MS = 60_000
/** At most one letter per chat and client in this time. */
export const LETTER_PAUSE_MS = 30 * 60_000

export type NotifyAnswer = 'sent' | 'seen' | 'moved_on' | 'skipped'

/** A browser of the client that takes Web Push. */
export interface PushTarget {
  endpoint: string
  p256dh: string
  auth: string
}

/** Sends one Web Push; `gone` — the browser dropped the subscription, it is forgotten. */
export interface PushSender {
  send(target: PushTarget, payload: string): Promise<'sent' | 'gone'>
}

export interface ChatNotifyDependencies {
  db: PrismaClient
  /** The public origin of the cabinet (APP_URL): the letter links to the chat under it. */
  appUrl: string
  /** null — Web Push is not configured (`WEB_PUSH_*`): letters still go. */
  push: PushSender | null
  logger?: { log(message: string): void; warn(message: string): void }
  now?: () => Date
}

const WAITING: readonly TaskStatus[] = ['awaiting_user', 'awaiting_approval']

export class ChatNotify {
  readonly #logger: { log(message: string): void; warn(message: string): void }
  readonly #now: () => Date

  constructor(private readonly deps: ChatNotifyDependencies) {
    this.#logger = deps.logger ?? new Logger('ChatNotify')
    this.#now = deps.now ?? (() => new Date())
  }

  async run(job: ChatNotifyJob): Promise<NotifyAnswer> {
    const { db } = this.deps
    const now = this.#now()
    const task = await db.task.findUnique({
      where: { id: job.taskId },
      select: { status: true, createdById: true, deletedAt: true, attempt: true, turnNo: true },
    })
    if (!task || task.deletedAt !== null || task.createdById === null)
      return this.#log(job, 'skipped')
    // The chat went on — its queue, words from another tab — or ended: there is nothing to wait for.
    if (
      !WAITING.includes(task.status) ||
      task.attempt !== job.attempt ||
      task.turnNo !== job.turnNo
    )
      return this.#log(job, 'moved_on')
    const userId = task.createdById
    const presence = await db.taskPresence.findUnique({
      where: { userId_taskId: { userId, taskId: job.taskId } },
      select: { seenAt: true },
    })
    if (presence && now.getTime() - presence.seenAt.getTime() < PRESENCE_FRESH_MS)
      return this.#log(job, 'seen')

    const [settings, user] = await Promise.all([
      db.notificationSetting.findUnique({ where: { userId } }),
      db.user.findUnique({ where: { id: userId }, select: { email: true, emailVerified: true } }),
    ])
    const pushOn = settings?.push ?? false
    const emailOn = settings?.email ?? true
    const notice = await db.chatNotification.create({
      data: { taskId: job.taskId, userId, kind: job.kind },
      select: { id: true },
    })

    let pushed = 0
    if (pushOn && this.deps.push) {
      const targets = await db.pushSubscription.findMany({
        where: { userId },
        select: { id: true, endpoint: true, p256dh: true, auth: true },
      })
      const payload = JSON.stringify({ id: notice.id })
      for (const target of targets) {
        // A subscription kept before the check, or written around it, is not sent to: core is
        // never a client of anything but a push service of a browser.
        if (!isPushEndpoint(target.endpoint)) {
          await db.pushSubscription.deleteMany({ where: { id: target.id } })
          continue
        }
        try {
          if ((await this.deps.push.send(target, payload)) === 'gone')
            await db.pushSubscription.deleteMany({ where: { id: target.id } })
          else {
            pushed++
            await db.pushSubscription.update({
              where: { id: target.id },
              data: { lastUsedAt: now },
            })
          }
        } catch (error) {
          // One browser that does not answer does not keep the others or the letter.
          this.#logger.warn(
            `chat_push_failed task=${job.taskId} reason=${error instanceof Error ? error.name : 'unknown'}`,
          )
        }
      }
    }

    let emailed = false
    if (emailOn && user?.emailVerified) {
      const recent = await db.chatNotification.count({
        where: {
          taskId: job.taskId,
          userId,
          emailed: true,
          createdAt: { gt: new Date(now.getTime() - LETTER_PAUSE_MS) },
        },
      })
      if (recent === 0) {
        await db.$transaction(async (tx) => {
          await enqueueNotification(
            'chat.waiting',
            {
              to: user.email,
              kind: job.kind,
              url: `${this.deps.appUrl}/chats/${job.taskId}`,
              settingsUrl: `${this.deps.appUrl}/settings`,
            },
            { db: tx, dedupeKey: `chat.waiting:${notice.id}` },
          )
          await tx.chatNotification.update({ where: { id: notice.id }, data: { emailed: true } })
        })
        emailed = true
      }
    }
    await db.chatNotification.update({ where: { id: notice.id }, data: { pushed } })
    return this.#log(job, pushed > 0 || emailed ? 'sent' : 'skipped')
  }

  #log(job: ChatNotifyJob, answer: NotifyAnswer): NotifyAnswer {
    this.#logger.log(`chat_notify task=${job.taskId} kind=${job.kind} answer=${answer}`)
    return answer
  }
}

/** Web Push by `web-push` with the VAPID keys of the platform; the subject is the cabinet. */
export async function webPushSender(keys: {
  publicKey: string
  privateKey: string
  subject: string
}): Promise<PushSender> {
  const webPush = await import('web-push')
  return {
    async send(target, payload) {
      try {
        await webPush.sendNotification(
          { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
          payload,
          {
            TTL: 3_600,
            urgency: 'normal',
            vapidDetails: {
              subject: keys.subject,
              publicKey: keys.publicKey,
              privateKey: keys.privateKey,
            },
          },
        )
        return 'sent'
      } catch (error) {
        const status = (error as { statusCode?: unknown }).statusCode
        if (status === 404 || status === 410) return 'gone'
        throw error
      }
    },
  }
}
