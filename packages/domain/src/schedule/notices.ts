import { z } from 'zod'

import { chatNotifyKinds, type ChatNotifyKind } from '../tasks/agent-turn-job.ts'

/**
 * Notifications of chats and of scheduled tasks (docs/plan/82-scheduled-tasks.md, Зп38–Зп41):
 * the five kinds of a pass that waits for its client (`chat.notify`, unchanged) and three of a
 * scheduled task itself — it did not start, it paused, it missed a run.
 */

/**
 * Notices of artifacts (docs/plan/88-artifacts.md, Ар54): someone opened one to you, a new comment
 * in a thread of all, the agent answered your note, another person changed yours. A letter and a
 * push name neither the artifact nor its words — only what happened, with a link to the cabinet.
 */
export const artifactNoticeKinds = [
  'artifact_shared',
  'artifact_comment',
  'artifact_agent_reply',
  'artifact_changed',
] as const
export type ArtifactNoticeKind = (typeof artifactNoticeKinds)[number]

/**
 * A notice of a connected VK community (docs/plan/99-vk-community.md, slice 99.6): a new comment
 * came. Neither its words nor its author go anywhere (spec §11) — only that it came, with the link
 * to the section of the community.
 */
export const VK_COMMENT_NOTICE = 'vk_comment'

export const notificationKinds = [
  ...chatNotifyKinds,
  'not_started',
  'paused',
  'missed',
  ...artifactNoticeKinds,
  VK_COMMENT_NOTICE,
] as const
export type NotificationKind = (typeof notificationKinds)[number]

export const isNotificationKind = (kind: string): kind is NotificationKind =>
  (notificationKinds as readonly string[]).includes(kind)

export const isArtifactNoticeKind = (kind: string): kind is ArtifactNoticeKind =>
  (artifactNoticeKinds as readonly string[]).includes(kind)

/** The title of a notice of an artifact: ours only, no title or words of anyone (Ар54). */
export const artifactNoticeTitles: Readonly<Record<ArtifactNoticeKind, string>> = Object.freeze({
  artifact_shared: 'С вами поделились артефактом',
  artifact_comment: 'Новый комментарий в артефакте',
  artifact_agent_reply: 'Агент ответил на заметку',
  artifact_changed: 'Ваш артефакт изменили',
})

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
      // A run in a project with a repository that left changes in the chat's branch (plan 84,
      // §10, «Открытое — закрыто (17.11.2026)»); nothing went out — the client sends them.
      return 'Запланированная задача подготовила изменения'
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
    case VK_COMMENT_NOTICE:
      return 'Новый комментарий в группе ВКонтакте'
    default:
      return artifactNoticeTitles[kind]
  }
}

/** What the client does with the changes a run prepared: the second half of its notice. */
export const scheduledReadyHint = 'посмотрите и отправьте в ветку'

/** The words of the bot of a run that prepared changes (`ready`): no word of the client but the name. */
export const scheduledReadyText = (name: string): string =>
  `Задача «${name}» подготовила изменения — ${scheduledReadyHint}.`

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
  tag: z.string().regex(/^(?:schedule|chat|artifact|vk):[0-9a-f-]{36}$/),
  at: z.int().positive(),
})
export type NotificationPushPayload = z.infer<typeof notificationPushPayloadSchema>
