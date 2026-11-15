import { z } from 'zod'

import { chatNotifyKinds, type ChatNotifyKind } from '../tasks/agent-turn-job.ts'

/**
 * Notifications of chats and of scheduled tasks (docs/plan/82-scheduled-tasks.md, Зп38–Зп41):
 * the five kinds of a pass that waits for its client (`chat.notify`, unchanged) and three of a
 * scheduled task itself — it did not start, it paused, it missed a run.
 */

export const notificationKinds = [...chatNotifyKinds, 'not_started', 'paused', 'missed'] as const
export type NotificationKind = (typeof notificationKinds)[number]

export const isNotificationKind = (kind: string): kind is NotificationKind =>
  (notificationKinds as readonly string[]).includes(kind)

/** What stopped a pass at its limit, by the row of its feed: credits or the weekly limit. */
export type NoticeLimitCause = 'credits' | 'weekly_limit'

/** The title of a pass of a chat with its client by it (ВВ8), as the cabinet has said it. */
const chatTitles: Readonly<Record<ChatNotifyKind, string>> = Object.freeze({
  answered: 'Агент ответил',
  question: 'Агент задал вопрос',
  ready: 'Изменения готовы',
  failed: 'Агент не смог закончить работу',
  limit: 'Работа агента остановилась',
})

/**
 * The title of a notice of a scheduled task (Зп38): of a pass without the client, or of the task
 * itself. The second line of the push is the name of the task.
 */
export function scheduledNoticeTitle(kind: NotificationKind, cause?: NoticeLimitCause): string {
  switch (kind) {
    case 'answered':
      return 'Запланированная задача выполнена'
    case 'question':
      return 'Запланированной задаче нужен ваш ответ'
    case 'ready':
      return 'Запланированная задача: изменения готовы'
    case 'failed':
      return 'Запланированная задача не выполнена'
    case 'limit':
      return cause === 'credits'
        ? 'Запланированная задача остановилась: закончились кредиты'
        : cause === 'weekly_limit'
          ? 'Запланированная задача остановилась: исчерпан недельный лимит'
          : 'Запланированная задача остановилась'
    case 'not_started':
      return 'Запланированная задача не запустилась'
    case 'paused':
      return 'Запланированная задача приостановлена'
    case 'missed':
      return 'Запланированная задача пропустила запуск'
  }
}

/**
 * The title of any notice: a pass without the client of a scheduled run, a notice of a task — in
 * the words of Зп38; a pass of a chat with its client by it — as before.
 */
export function notificationTitle(
  kind: NotificationKind,
  options: { scheduled: boolean; cause?: NoticeLimitCause } = { scheduled: false },
): string {
  if (options.scheduled || !(chatNotifyKinds as readonly string[]).includes(kind))
    return scheduledNoticeTitle(kind, options.cause)
  return chatTitles[kind as ChatNotifyKind]
}

/** The kinds the switch «Уведомлять, когда задача выполнится» of a task turns off (Зп39). */
export const scheduleNotifySwitchKinds = [
  'answered',
  'ready',
] as const satisfies readonly NotificationKind[]

/** The kinds sent with `urgency: high` (Зп41). */
export const urgentNotificationKinds = [
  'failed',
  'not_started',
  'paused',
] as const satisfies readonly NotificationKind[]

/** The kinds that open the page of the task, not the chat of its run (Зп38). */
export const taskPageNotificationKinds = [
  'not_started',
  'paused',
  'missed',
] as const satisfies readonly NotificationKind[]

/**
 * What a push carries (Зп40): `{ id, path, kind, scheduled, tag, at }` — the id of the
 * notification, the path of the cabinet it opens, its kind, whether it is of a scheduled task, the
 * tag a newer run replaces it by, and when the cabinet made it (ms since the epoch): a push that
 * arrives late never replaces a newer notice under the same tag. No word of the client: the push
 * services are abroad (rule 1).
 */
export const notificationPushPayloadSchema = z.strictObject({
  id: z.uuid(),
  path: z
    .string()
    .max(200)
    .regex(/^\/(?!\/)[A-Za-z0-9/_-]*$/, 'a path of the cabinet'),
  kind: z.enum(notificationKinds),
  scheduled: z.boolean(),
  tag: z.string().regex(/^(?:schedule|chat):[0-9a-f-]{36}$/),
  at: z.int().positive(),
})
export type NotificationPushPayload = z.infer<typeof notificationPushPayloadSchema>
