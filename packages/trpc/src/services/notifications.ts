import type { PrismaClient } from '@repo/db'
import {
  DomainError,
  isNotificationKind,
  notificationTitle,
  scheduledReadyHint,
  scheduledRunReasonText,
  scheduledRunReasons,
  taskPageNotificationKinds,
  type NoticeLimitCause,
  type NotificationKind,
  type ScheduledRunReason,
} from '@repo/domain'

// «Уведомления» of the settings and the browsers that take Web Push (docs/plan/74-chat-input-
// output.md, ВВ8, ВВ10); the presence in a chat its feed marks (ВВ7); the words a service worker
// shows for a push (ВВ8). Only the user's own rows are read and written.

/** Marked at most this often: the feed reads every few seconds. */
const PRESENCE_EVERY_SECONDS = 30

export interface NotificationSettings {
  push: boolean
  email: boolean
}

/**
 * The settings, how many browsers of the user take Web Push and — when the page names its own
 * browser by its subscription — how many others do (docs/plan/82-scheduled-tasks.md, Зп37: «Ещё в
 * N браузерах»; the switch is of this browser).
 */
export async function readNotificationSettings(
  db: PrismaClient,
  userId: string,
  endpoint?: string,
): Promise<NotificationSettings & { browsers: number; otherBrowsers: number }> {
  const [row, browsers, here] = await Promise.all([
    db.notificationSetting.findUnique({ where: { userId } }),
    db.pushSubscription.count({ where: { userId } }),
    endpoint === undefined
      ? Promise.resolve(0)
      : db.pushSubscription.count({ where: { userId, endpoint } }),
  ])
  return {
    push: row?.push ?? false,
    email: row?.email ?? true,
    browsers,
    otherBrowsers: browsers - here,
  }
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

/** The subscription a browser gives (`PushSubscription.toJSON()`), flattened. */
export interface BrowserSubscription {
  endpoint: string
  p256dh: string
  auth: string
}

/**
 * A browser of the user takes Web Push: its subscription is kept (the same endpoint once — a
 * browser another user had is theirs no more) with the public VAPID key it was made under
 * (docs/plan/82-scheduled-tasks.md, Зп41: a 403 of a push service drops only a subscription of
 * another key), and «В браузере» is on.
 */
export async function subscribeBrowser(
  db: PrismaClient,
  userId: string,
  subscription: BrowserSubscription,
  vapidKey: string | null = null,
): Promise<{ subscribed: true }> {
  await db.$transaction(async (tx) => {
    await tx.pushSubscription.upsert({
      where: { endpoint: subscription.endpoint },
      create: { userId, ...subscription, vapidKey },
      update: { userId, p256dh: subscription.p256dh, auth: subscription.auth, vapidKey },
    })
    await tx.notificationSetting.upsert({
      where: { userId },
      create: { userId, push: true },
      update: { push: true },
    })
  })
  return { subscribed: true }
}

/**
 * The client turned push on again in a browser whose subscription was made under another VAPID key
 * (docs/plan/82-scheduled-tasks.md, Зп37): the press is the consent, so the new subscription is
 * kept for the user, under the key of now, and the old one of this user goes. An old one of
 * another user, or none, is left alone.
 */
export async function resubscribeBrowser(
  db: PrismaClient,
  userId: string,
  change: { oldEndpoint: string | null; subscription: BrowserSubscription },
  vapidKey: string | null = null,
): Promise<{ resubscribed: true }> {
  const { oldEndpoint, subscription } = change
  await db.$transaction(async (tx) => {
    if (oldEndpoint !== null && oldEndpoint !== subscription.endpoint)
      await tx.pushSubscription.deleteMany({ where: { userId, endpoint: oldEndpoint } })
    await tx.pushSubscription.upsert({
      where: { endpoint: subscription.endpoint },
      create: { userId, ...subscription, vapidKey },
      update: { userId, p256dh: subscription.p256dh, auth: subscription.auth, vapidKey },
    })
  })
  return { resubscribed: true }
}

/**
 * The browser replaced its subscription by itself (`pushsubscriptionchange` of the service worker,
 * Зп41): the row of the old one moves to the new one — its owner, not whoever is signed in now.
 * The service worker posts with the session the browser holds at that moment, which may be another
 * account's on a shared computer: that account never turned push on here (Зп37: a row is there only
 * where the client turned push on in this browser), so nothing is made for it, and the owner's row
 * — another user's — is left to the push service to end. Moved only when the old row is the
 * signed-in user's; `false` — nothing changed.
 */
export async function replaceBrowserSubscription(
  db: PrismaClient,
  userId: string,
  change: { oldEndpoint: string | null; subscription: BrowserSubscription },
  vapidKey: string | null = null,
): Promise<{ replaced: boolean }> {
  const { oldEndpoint, subscription } = change
  if (oldEndpoint === null) return { replaced: false }
  return db.$transaction(async (tx) => {
    const old = await tx.pushSubscription.findUnique({
      where: { endpoint: oldEndpoint },
      select: { userId: true },
    })
    if (old === null || old.userId !== userId) return { replaced: false }
    if (oldEndpoint !== subscription.endpoint)
      await tx.pushSubscription.delete({ where: { endpoint: oldEndpoint } })
    await tx.pushSubscription.upsert({
      where: { endpoint: subscription.endpoint },
      create: { userId, ...subscription, vapidKey },
      update: { userId, p256dh: subscription.p256dh, auth: subscription.auth, vapidKey },
    })
    return { replaced: true }
  })
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

/** What a notice is opened by: its title, its second line and the path of the cabinet. */
export interface NotificationWords {
  title: string
  body: string
  url: string
}

const reasonOf = (reason: string | null): ScheduledRunReason | null =>
  (scheduledRunReasons as readonly string[]).includes(reason ?? '')
    ? (reason as ScheduledRunReason)
    : null

/** Why a task stopped by itself, in the words of its second line (Зп38). */
function pausedWords(task: { pausedReason: string | null; lastRefusalReason: string | null }) {
  switch (task.pausedReason) {
    case 'refused': {
      const reason = reasonOf(task.lastRefusalReason)
      return reason === null ? 'три отказа подряд' : scheduledRunReasonText[reason]
    }
    case 'not_accepted':
      return 'задачи пока не принимаются'
    default:
      return null
  }
}

/**
 * What stopped the pass a notice of the kind `limit` tells of, by the row of its feed (Зп38): the
 * platform's question about credits, or a failure for the weekly limit. The newest of them for the
 * turn of the notice, else of the chat; undefined — neither, the title names no cause.
 */
async function limitCause(
  db: PrismaClient,
  taskId: string,
  turnNo: number | null,
): Promise<NoticeLimitCause | undefined> {
  const rows = await db.taskEvent.findMany({
    where: { taskId, type: { in: ['feed.question', 'feed.failure'] } },
    orderBy: { id: 'desc' },
    take: 20,
    select: { type: true, payload: true },
  })
  const causes = rows.flatMap((row): { turn: number | null; cause: NoticeLimitCause | null }[] => {
    const payload = (row.payload ?? {}) as Record<string, unknown>
    const turn = typeof payload.turn === 'number' ? payload.turn : null
    if (row.type === 'feed.question' && payload.kind === 'ceiling') {
      const credits = payload.reason === 'credits' || payload.reason === 'gift'
      return [{ turn, cause: credits ? 'credits' : null }]
    }
    if (row.type === 'feed.failure' && payload.code === 'usage_limit') {
      const week = (payload.window as { kind?: unknown } | undefined)?.kind === 'week'
      return [{ turn, cause: week ? 'weekly_limit' : null }]
    }
    return []
  })
  const of = turnNo === null ? undefined : causes.find((row) => row.turn === turnNo)
  return (of ?? causes[0])?.cause ?? undefined
}

/**
 * The words of a notification, for the service worker that got its id by Web Push (ВВ8): only the
 * user it was sent to reads it. A notice of a pass of a chat with its client by it says what the
 * agent did; one of a pass of a run of a scheduled task without its client, or of the task itself
 * — it did not start, it paused, it missed a run —, says it of the task, with its name for the
 * second line (docs/plan/82-scheduled-tasks.md, Зп38). core marks the notices of a run by its task
 * only while the pass goes without the client (`passUnattended`). A chat opens its chat; a notice
 * of the task itself opens the page of the task.
 */
export async function readChatNotification(
  db: PrismaClient,
  userId: string,
  id: string,
): Promise<NotificationWords> {
  const row = await db.chatNotification.findFirst({
    where: { id, userId },
    select: {
      kind: true,
      turnNo: true,
      task: { select: { id: true, title: true } },
      scheduledTask: {
        select: {
          id: true,
          name: true,
          deletedAt: true,
          pausedReason: true,
          lastRefusalReason: true,
        },
      },
      scheduledRun: { select: { reason: true, name: true } },
    },
  })
  if (row === null) throw new DomainError('NOT_FOUND', 'No such notification', 404)
  const kind: NotificationKind = isNotificationKind(row.kind) ? row.kind : 'answered'
  const schedule = row.scheduledTask
  if (schedule === null) {
    if (row.task === null) throw new DomainError('NOT_FOUND', 'No such notification', 404)
    return {
      title: notificationTitle(kind),
      body: row.task.title ?? 'Чат',
      url: `/chats/${row.task.id}`,
    }
  }
  const cause =
    kind === 'limit' && row.task !== null
      ? await limitCause(db, row.task.id, row.turnNo)
      : undefined
  const name =
    schedule.deletedAt === null ? schedule.name : (row.scheduledRun?.name ?? schedule.name)
  let why: string | null = null
  if (kind === 'not_started') {
    const reason = reasonOf(row.scheduledRun?.reason ?? null)
    why = reason === null ? null : scheduledRunReasonText[reason]
  } else if (kind === 'paused') why = pausedWords(schedule)
  else if (kind === 'ready') why = scheduledReadyHint
  const ofTask = (taskPageNotificationKinds as readonly string[]).includes(kind)
  const url =
    !ofTask && row.task !== null
      ? `/chats/${row.task.id}`
      : schedule.deletedAt === null
        ? `/scheduled/${schedule.id}`
        : '/scheduled'
  return {
    title: notificationTitle(kind, { scheduled: true, ...(cause ? { cause } : {}) }),
    body: why === null ? name : `${name} — ${why}`,
    url,
  }
}
