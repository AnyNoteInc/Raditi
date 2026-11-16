import { describe, expect, it } from 'vitest'

import {
  feedScheduleChangeText,
  feedScheduleChangeTitle,
  feedScheduleLeftReasonText,
  feedScheduleLeftText,
} from '../tasks/client-feed-labels.ts'
import { feedRowSchema, readFeedRow, type FeedItem } from '../tasks/client-feed.ts'
import { feedMarkdown, feedRowMarkdown } from '../tasks/feed-markdown.ts'
import {
  feedScheduleChangePayloadSchema,
  feedScheduleLeftPayloadSchema,
  scheduleChangeActions,
  scheduleLeftReasons,
} from './feed.ts'
import { scheduleLimits } from './limits.ts'

const change = {
  v: 1,
  action: 'created',
  scheduleId: '018f3b2e-7c4a-7b1c-9d2e-3f4a5b6c7de1',
  name: 'Проверка сайта',
  instructions: 'Открой сайт kofe.ru и пройди главную.\nФормы не отправляй.',
  triggers: [{ kind: 'weekdays', time: '09:00' }],
  timezone: 'Europe/Moscow',
  nextRunAt: '2026-11-16T06:00:00.000Z',
  effort: 'low',
  notify: true,
} as const
const left = { v: 1, action: 'create', name: 'Курс валют', reason: 'limit' } as const

const { v: _v, ...shownChange } = change

describe('feed.schedule_change', () => {
  it('is written and read back as it was, every action', () => {
    for (const action of scheduleChangeActions) {
      const payload = { ...change, action }
      expect(feedRowSchema.parse({ type: 'feed.schedule_change', payload })).toEqual({
        type: 'feed.schedule_change',
        payload,
      })
      expect(readFeedRow('feed.schedule_change', JSON.parse(JSON.stringify(payload)))).toEqual({
        type: 'feed.schedule_change',
        ...shownChange,
        action,
      })
    }
  })

  it('refuses schedules the window would refuse, a secret in the words and a zone not known', () => {
    const refused = (patch: Record<string, unknown>) =>
      feedScheduleChangePayloadSchema.safeParse({ ...change, ...patch }).success
    expect(
      refused({
        triggers: [
          { kind: 'daily', time: '09:00' },
          { kind: 'daily', time: '09:30' },
        ],
      }),
    ).toBe(false)
    expect(refused({ instructions: 'Пароль от админки: Xk9#mQ2$vL7!pR4@' })).toBe(false)
    expect(refused({ timezone: 'Mars/Olympus' })).toBe(false)
    expect(refused({ nextRunAt: 'завтра в 9:00' })).toBe(false)
    expect(refused({ effort: 'medium' })).toBe(false)
    expect(refused({ extra: true })).toBe(false)
    expect(refused({ nextRunAt: null, triggers: [] })).toBe(true)
  })

  it('reads what a newer writer may have stored as the less it knows', () => {
    const read = (patch: Record<string, unknown>) =>
      readFeedRow('feed.schedule_change', { ...change, ...patch })
    expect(read({ action: 'archived' })).toMatchObject({ action: 'updated' })
    expect(read({ effort: 'medium' })).toMatchObject({ effort: 'high' })
    expect(read({ triggers: [{ kind: 'yearly', time: '09:00' }] })).toMatchObject({
      type: 'feed.schedule_change',
      triggers: null,
    })
    expect(read({ timezone: 'Mars/Olympus' })).toMatchObject({ timezone: 'Europe/Moscow' })
    expect(read({ nextRunAt: '2026-11-16T09:00:00+03:00' })).toMatchObject({
      nextRunAt: '2026-11-16T09:00:00+03:00',
    })
    // A key this code does not know is dropped: the row reads as the rest of it.
    expect(read({ extra: true })).toEqual({ type: 'feed.schedule_change', ...shownChange })
    expect(read({ scheduleId: 'задача' })).toEqual({ type: 'unreadable' })
    expect(readFeedRow('feed.schedule_change', { ...change, v: 2 })).toEqual({ type: 'newer' })
  })
})

describe('feed.schedule_left', () => {
  it('is written and read back as it was, with a name or without', () => {
    for (const payload of [left, { ...left, name: null, action: 'delete', reason: 'not_found' }]) {
      expect(feedScheduleLeftPayloadSchema.parse(payload)).toEqual(payload)
      const { v: _version, ...shown } = payload
      expect(readFeedRow('feed.schedule_left', payload)).toEqual({
        type: 'feed.schedule_left',
        ...shown,
      })
    }
  })

  it('reads an action and a reason it does not know as the less they say', () => {
    expect(readFeedRow('feed.schedule_left', { ...left, reason: 'quota' })).toMatchObject({
      reason: 'failed',
    })
    expect(readFeedRow('feed.schedule_left', { ...left, action: 'move' })).toMatchObject({
      action: 'update',
    })
  })
})

describe('the words of the rows', () => {
  it('titles the card of a change by its action', () => {
    expect(Object.values(feedScheduleChangeTitle)).toEqual([
      'Запланированная задача создана',
      'Запланированная задача изменена',
      'Запланированная задача приостановлена',
      'Запланированная задача возобновлена',
      'Запланированная задача удалена',
    ])
    expect(feedScheduleChangeText({ action: 'paused', name: 'Отчёт' })).toBe(
      'Запланированная задача приостановлена: «Отчёт»',
    )
  })

  it('tells why a change did not come true', () => {
    const texts = scheduleLeftReasons.map((reason) => feedScheduleLeftText({ reason }))
    expect(texts).toEqual([
      'Задачу не удалось сохранить: нет прав в этом рабочем пространстве',
      'Задачу не удалось сохранить: включено 20 задач — больше нельзя',
      'Задачу не удалось сохранить: задачи уже нет',
      'Задачу не удалось сохранить: в инструкции нельзя оставлять пароли и ключи',
      'Задачу не удалось сохранить: в названии нельзя оставлять пароли и ключи',
      'Задачу не удалось сохранить: расписание не подходит',
      'Задачу не удалось сохранить: в инструкции остался текст в квадратных скобках',
      'Задачу не удалось сохранить: ответ агента оборвался',
    ])
    // The labels import types only: the number is written in the words and held here.
    expect(feedScheduleLeftReasonText.limit).toContain(String(scheduleLimits.activePerWorkspace))
  })
})

describe('the rows in the export of a chat', () => {
  const row = (type: string, payload: Record<string, unknown>): FeedItem =>
    ({
      ...(readFeedRow(type, payload) as object),
      id: '7',
      at: '2026-11-15T10:00:00.000Z',
    }) as FeedItem

  it('tells the task: its name, schedule, next run and words', () => {
    const text = feedMarkdown({
      title: 'Расписание',
      rows: [row('feed.schedule_change', change)],
      withSite: false,
    })
    expect(text).toContain('Запланированная задача создана')
    expect(text).toContain('«Проверка сайта»')
    expect(text).toContain('По будням в 9:00. Следующий запуск: завтра в 9:00.')
    expect(text).toContain(
      'Инструкция:\n\nОткрой сайт kofe.ru и пройди главную.\nФормы не отправляй.',
    )
  })

  it('tells a deleted task by its name only', () => {
    const text = feedRowMarkdown(
      row('feed.schedule_change', { ...change, action: 'deleted', nextRunAt: null }),
      false,
    )
    expect(text).toBe('**Запланированная задача удалена**\n\n«Проверка сайта»')
  })

  it('tells a schedule it cannot read without its words', () => {
    const text = feedRowMarkdown(
      row('feed.schedule_change', {
        ...change,
        triggers: [{ kind: 'yearly' }],
        nextRunAt: null,
      }),
      false,
    )
    expect(text).not.toContain('По будням')
    expect(text).toContain('Инструкция:')
  })

  it('tells a change that did not come true', () => {
    expect(feedRowMarkdown(row('feed.schedule_left', left), false)).toBe(
      'Задачу не удалось сохранить: включено 20 задач — больше нельзя',
    )
  })
})
