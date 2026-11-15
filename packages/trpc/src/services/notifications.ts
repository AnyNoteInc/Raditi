import type { PrismaClient } from '@repo/db'
import { DomainError } from '@repo/domain'

// «Уведомления» of the settings and the browsers that take Web Push (docs/plan/74-chat-input-
// output.md, ВВ8, ВВ10); the presence in a chat its feed marks (ВВ7); the words a service worker
// shows for a push (ВВ8). Only the user's own rows are read and written.

/** Marked at most this often: the feed reads every few seconds. */
const PRESENCE_EVERY_SECONDS = 30

export interface NotificationSettings {
  push: boolean
  email: boolean
}

export async function readNotificationSettings(
  db: PrismaClient,
  userId: string,
): Promise<NotificationSettings & { browsers: number }> {
  const [row, browsers] = await Promise.all([
    db.notificationSetting.findUnique({ where: { userId } }),
    db.pushSubscription.count({ where: { userId } }),
  ])
  return { push: row?.push ?? false, email: row?.email ?? true, browsers }
}

export async function writeNotificationSettings(
  db: PrismaClient,
  userId: string,
  change: Partial<NotificationSettings>,
): Promise<NotificationSettings> {
  const row = await db.notificationSetting.upsert({
    where: { userId },
    create: { userId, push: change.push ?? false, email: change.email ?? true },
    update: change,
  })
  return { push: row.push, email: row.email }
}

/**
 * A browser of the user takes Web Push: its subscription is kept (the same endpoint once — a
 * browser another user had is theirs no more) and «В браузере» is on.
 */
export async function subscribeBrowser(
  db: PrismaClient,
  userId: string,
  subscription: { endpoint: string; p256dh: string; auth: string },
): Promise<{ subscribed: true }> {
  await db.$transaction(async (tx) => {
    await tx.pushSubscription.upsert({
      where: { endpoint: subscription.endpoint },
      create: { userId, ...subscription },
      update: { userId, p256dh: subscription.p256dh, auth: subscription.auth },
    })
    await tx.notificationSetting.upsert({
      where: { userId },
      create: { userId, push: true },
      update: { push: true },
    })
  })
  return { subscribed: true }
}

/** The browser gave its subscription up, or the client turned notifications off in it. */
export async function unsubscribeBrowser(
  db: PrismaClient,
  userId: string,
  endpoint: string,
): Promise<{ unsubscribed: true }> {
  await db.pushSubscription.deleteMany({ where: { userId, endpoint } })
  return { unsubscribed: true }
}

/**
 * The client looks at the chat (ВВ7): the feed marks it, at most every 30 seconds. Only a chat and
 * a user that are there are marked, and the mark never fails the feed: a chat deleted while its
 * page reads it, or a mark that loses a race, is simply not marked — the worst is one notification
 * more.
 */
export async function markPresence(db: PrismaClient, userId: string, taskId: string) {
  try {
    await db.$executeRaw`
      INSERT INTO task_presence (user_id, task_id, seen_at)
      SELECT u.id, t.id, now() FROM users u, tasks t
      WHERE u.id = ${userId}::uuid AND t.id = ${taskId}::uuid AND t.deleted_at IS NULL
      ON CONFLICT (user_id, task_id) DO UPDATE SET seen_at = EXCLUDED.seen_at
      WHERE task_presence.seen_at < EXCLUDED.seen_at - make_interval(secs => ${PRESENCE_EVERY_SECONDS})`
  } catch {
    // Best effort: a lost mark costs a notification, a failed feed would cost the page.
  }
}

/** The words of a notification, for the service worker that got its id by Web Push. */
const titles = {
  answered: 'Агент ответил',
  question: 'Агент задал вопрос',
  ready: 'Изменения готовы',
  failed: 'Агент не смог закончить работу',
  limit: 'Работа агента остановилась',
} as const

export async function readChatNotification(
  db: PrismaClient,
  userId: string,
  id: string,
): Promise<{ title: string; body: string; url: string }> {
  const row = await db.chatNotification.findFirst({
    where: { id, userId },
    select: { kind: true, task: { select: { id: true, title: true } } },
  })
  if (!row) throw new DomainError('NOT_FOUND', 'No such notification', 404)
  const title = titles[row.kind as keyof typeof titles] ?? titles.answered
  return { title, body: row.task.title ?? 'Чат', url: `/chats/${row.task.id}` }
}
