import { describe, expect, it } from 'vitest'

import { isDomainError } from '../errors.ts'
import { queueNames } from '../ports/job-queue.ts'
import { chatNotifyJobSchema, chatNotifyKinds } from '../tasks/agent-turn-job.ts'
import { FEED_REQUEST_TEXT_LIMIT } from '../tasks/client-feed-text.ts'
import {
  scheduleChangeLimitReached,
  scheduleForbidden,
  scheduleInPast,
  scheduleLimitReached,
  scheduleNotFound,
  scheduleRunBusy,
  scheduleTemplatePlaceholder,
  scheduleTooOften,
} from './errors.ts'
import { scheduleLimits } from './limits.ts'
import {
  isNotificationKind,
  notificationKinds,
  notificationPushPayloadSchema,
  notificationTitle,
  scheduledNoticeTitle,
  scheduleNotifySwitchKinds,
  taskPageNotificationKinds,
  urgentNotificationKinds,
} from './notices.ts'
import {
  clientRefusalReasons,
  isClientRefusalReason,
  SCHEDULE_INTAKE_PATH,
  SCHEDULE_QUEUE,
  scheduledRunReasons,
  scheduledRunReasonText,
  scheduledRunStatuses,
  scheduledRunTriggers,
  scheduleIntakeRequestSchema,
  scheduleIntakeResponseSchema,
  schedulePausedReasons,
  schedulePausedReasonText,
  scheduleStartDedupeKey,
  scheduleStartJobSchema,
} from './runs.ts'

const runId = '018f3b2e-7c4a-7b1c-9d2e-3f4a5b6c7df1'

describe('the bounds', () => {
  it('are the numbers of the plan', () => {
    expect(scheduleLimits).toEqual({
      activePerWorkspace: 20,
      triggersPerTask: 5,
      nameMax: 80,
      instructionsMax: FEED_REQUEST_TEXT_LIMIT,
      changesPerTurn: 5,
      catchUpHours: 6,
      startAttempts: 8,
      pendingSweepMinutes: 75,
      refusalsToPause: 3,
      manualRunGapMs: 60_000,
      onceMinMinutes: 5,
      onceMaxMinutes: 43_200,
    })
    expect(Object.isFrozen(scheduleLimits)).toBe(true)
  })
})

describe('the runs', () => {
  it('have their triggers, statuses and reasons', () => {
    expect(scheduledRunTriggers).toEqual(['schedule', 'manual'])
    expect(scheduledRunStatuses).toEqual(['pending', 'started', 'refused', 'skipped'])
    expect(Object.keys(scheduledRunReasonText)).toEqual([...scheduledRunReasons])
    expect(schedulePausedReasons).toEqual([
      'completed',
      'project_gone',
      'member_gone',
      'not_accepted',
      'refused',
    ])
    expect(Object.keys(schedulePausedReasonText)).toEqual([...schedulePausedReasons])
  })

  it('say why a run did not start in the words of the cabinet', () => {
    expect(scheduledRunReasonText.no_credits).toBe('не хватило кредитов')
    expect(scheduledRunReasonText.weekly_limit).toBe('исчерпан недельный лимит')
    expect(scheduledRunReasonText.member_gone).toBe('у вас больше нет прав в этом проекте')
    expect(scheduledRunReasonText.previous_running).toBe('предыдущий запуск ещё шёл')
    expect(scheduledRunReasonText.platform).toBe('сбой платформы')
    expect(schedulePausedReasonText.refused).toBe('Остановлена после трёх отказов подряд')
    for (const text of Object.values(scheduledRunReasonText)) expect(text).toMatch(/^[а-яё]/u)
  })

  it('count refusals of the client only for a pause', () => {
    expect(clientRefusalReasons).toEqual([
      'no_credits',
      'needs_tariff',
      'weekly_limit',
      'daily_limit',
      'project_unavailable',
      'consent',
    ])
    expect(isClientRefusalReason('consent')).toBe(true)
    expect(isClientRefusalReason('platform')).toBe(false)
    expect(isClientRefusalReason('credits_held')).toBe(false)
  })
})

describe('core and web about a run', () => {
  it('pass its id only', () => {
    expect(scheduleIntakeRequestSchema.parse({ runId })).toEqual({ runId })
    expect(scheduleIntakeRequestSchema.safeParse({ runId, text: 'слова' }).success).toBe(false)
    expect(scheduleIntakeRequestSchema.safeParse({ runId: 'run' }).success).toBe(false)
    expect(scheduleStartJobSchema.parse({ runId })).toEqual({ runId })
    expect(scheduleStartDedupeKey({ runId })).toBe(`schedule.start:${runId}`)
    expect(SCHEDULE_INTAKE_PATH).toBe('/api/webhooks/scheduled-runs')
  })

  it('go through the queue `schedules` of core', () => {
    expect(queueNames).toContain(SCHEDULE_QUEUE)
  })

  it('answer with the chat of the run or why there is none', () => {
    const taskId = '018f3b2e-7c4a-7b1c-9d2e-3f4a5b6c7df2'
    expect(scheduleIntakeResponseSchema.parse({ outcome: 'started', taskId })).toEqual({
      outcome: 'started',
      taskId,
    })
    expect(
      scheduleIntakeResponseSchema.parse({ outcome: 'refused', reason: 'no_credits' }),
    ).toEqual({ outcome: 'refused', reason: 'no_credits' })
    expect(scheduleIntakeResponseSchema.parse({ outcome: 'skipped', reason: 'paused' })).toEqual({
      outcome: 'skipped',
      reason: 'paused',
    })
    expect(scheduleIntakeResponseSchema.safeParse({ outcome: 'started' }).success).toBe(false)
    expect(
      scheduleIntakeResponseSchema.safeParse({ outcome: 'refused', reason: 'tired' }).success,
    ).toBe(false)
    expect(
      scheduleIntakeResponseSchema.safeParse({ outcome: 'started', taskId, reason: 'paused' })
        .success,
    ).toBe(false)
  })
})

describe('the errors', () => {
  it('carry their codes, statuses and the words of the client', () => {
    const cases = [
      [scheduleNotFound(), 'SCHEDULE_NOT_FOUND', 404, 'Задачи уже нет'],
      [
        scheduleForbidden(),
        'SCHEDULE_FORBIDDEN',
        403,
        'Менять запланированные задачи может владелец или администратор, создавший её',
      ],
      [
        scheduleLimitReached(),
        'SCHEDULE_LIMIT',
        409,
        'Включено 20 задач — больше нельзя. Приостановите или удалите одну',
      ],
      [
        scheduleChangeLimitReached(),
        'SCHEDULE_CHANGE_LIMIT',
        409,
        'За один ответ можно изменить не больше 5 запланированных задач',
      ],
      [scheduleTooOften(), 'SCHEDULE_TOO_OFTEN', 400, 'Запуски одной задачи — не чаще раза в час'],
      [scheduleInPast(), 'SCHEDULE_IN_PAST', 400, 'Это время уже прошло — выберите другое'],
      [
        scheduleTemplatePlaceholder(),
        'SCHEDULE_TEMPLATE_PLACEHOLDER',
        400,
        'Впишите адреса сайтов конкурентов',
      ],
      [scheduleRunBusy(), 'SCHEDULE_RUN_BUSY', 409, 'Задача уже выполняется'],
    ] as const
    for (const [error, code, status, message] of cases) {
      expect(isDomainError(error)).toBe(true)
      expect(error.code).toBe(code)
      expect(error.httpStatus).toBe(status)
      expect(error.message).toBe(message)
    }
    expect(scheduleLimitReached().details).toEqual({ limit: 20 })
    expect(scheduleChangeLimitReached().details).toEqual({ limit: 5 })
    expect(scheduleChangeLimitReached(1).message).toBe(
      'За один ответ можно изменить не больше 1 запланированной задачи',
    )
  })
})

describe('the notices', () => {
  it('add three kinds of a task to the five of a chat, which stay as they were', () => {
    expect(chatNotifyKinds).toEqual(['answered', 'question', 'ready', 'failed', 'limit'])
    expect(notificationKinds).toEqual([
      'answered',
      'question',
      'ready',
      'failed',
      'limit',
      'not_started',
      'paused',
      'missed',
    ])
    expect(
      chatNotifyJobSchema.safeParse({ taskId: runId, kind: 'paused', attempt: 1, turnNo: 0 })
        .success,
    ).toBe(false)
    expect(isNotificationKind('missed')).toBe(true)
    expect(isNotificationKind('reminder')).toBe(false)
  })

  it('title a scheduled run in the words of the plan', () => {
    expect(notificationKinds.map((kind) => scheduledNoticeTitle(kind))).toEqual([
      'Запланированная задача выполнена',
      'Запланированной задаче нужен ваш ответ',
      'Запланированная задача: изменения готовы',
      'Запланированная задача не выполнена',
      'Запланированная задача остановилась',
      'Запланированная задача не запустилась',
      'Запланированная задача приостановлена',
      'Запланированная задача пропустила запуск',
    ])
    expect(scheduledNoticeTitle('limit', 'credits')).toBe(
      'Запланированная задача остановилась: закончились кредиты',
    )
    expect(scheduledNoticeTitle('limit', 'weekly_limit')).toBe(
      'Запланированная задача остановилась: исчерпан недельный лимит',
    )
  })

  it('title a chat with its client by it as before', () => {
    expect(chatNotifyKinds.map((kind) => notificationTitle(kind))).toEqual([
      'Агент ответил',
      'Агент задал вопрос',
      'Изменения готовы',
      'Агент не смог закончить работу',
      'Работа агента остановилась',
    ])
    expect(notificationTitle('answered', { scheduled: true })).toBe(
      'Запланированная задача выполнена',
    )
    // A kind of a task is the task's in any case.
    expect(notificationTitle('paused')).toBe('Запланированная задача приостановлена')
  })

  it('say which kinds the switch of a task turns off, which are urgent, which open the task', () => {
    expect(scheduleNotifySwitchKinds).toEqual(['answered', 'ready'])
    expect(urgentNotificationKinds).toEqual(['failed', 'not_started', 'paused'])
    expect(taskPageNotificationKinds).toEqual(['not_started', 'paused', 'missed'])
  })

  it('push ids, a path and a tag, no words', () => {
    const payload = {
      id: runId,
      path: `/scheduled/${runId}`,
      kind: 'paused',
      scheduled: true,
      tag: `schedule:${runId}`,
    }
    expect(notificationPushPayloadSchema.parse(payload)).toEqual(payload)
    expect(notificationPushPayloadSchema.safeParse({ ...payload, title: 'Отчёт' }).success).toBe(
      false,
    )
    for (const path of ['//evil.example', 'https://evil.example/', '/chats/<script>', 'chats'])
      expect(notificationPushPayloadSchema.safeParse({ ...payload, path }).success, path).toBe(
        false,
      )
  })
})
