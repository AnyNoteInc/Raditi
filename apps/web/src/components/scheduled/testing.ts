import type { ScheduleDetail, ScheduleItem, ScheduleRun } from './schedule-model'

// Answers of `schedule.list` and `schedule.get` for the component tests: the tasks of the kofeinya
// «Крошка». «Now» is Sunday, 15 November 2026, 12:00 in Moscow.

export const NOW = new Date('2026-11-15T09:00:00.000Z')
export const SCHEDULE_ID = '019f2a00-0000-7000-8000-000000000001'
export const SITE_ID = '019f2a00-0000-7000-8000-0000000000a1'
export const CHAT_ID = '019f2a00-0000-7000-8000-0000000000c1'

export function scheduleRun(patch: Partial<ScheduleRun> = {}): ScheduleRun {
  return {
    id: '019f2a00-0000-7000-8000-0000000000e1',
    dueAt: new Date('2026-11-15T06:00:00.000Z'),
    trigger: 'schedule',
    state: { kind: 'done' },
    chat: { id: CHAT_ID, title: 'Проверка сайта' },
    createdAt: new Date('2026-11-15T06:00:00.000Z'),
    startedAt: new Date('2026-11-15T06:00:05.000Z'),
    ...patch,
  }
}

export function scheduleItem(patch: Partial<ScheduleItem> = {}): ScheduleItem {
  return {
    id: SCHEDULE_ID,
    name: 'Проверка сайта',
    instructions: 'Откройте сайт и пройдите главную и важные страницы.',
    effort: 'low',
    triggers: [{ kind: 'weekdays', time: '09:00' }],
    timezone: 'Europe/Moscow',
    enabled: true,
    notify: true,
    pausedReason: null,
    lastRefusalReason: null,
    // Monday, 16 November, 9:00 in Moscow.
    nextRunAt: new Date('2026-11-16T06:00:00.000Z'),
    lastRunAt: null,
    createdVia: 'manual',
    templateSlug: null,
    project: { id: SITE_ID, name: 'Кофейня «Крошка»' },
    createdAt: new Date('2026-11-10T09:00:00.000Z'),
    updatedAt: new Date('2026-11-10T09:00:00.000Z'),
    lastRun: null,
    ...patch,
  }
}

export function scheduleDetail(
  patch: Partial<ScheduleDetail> = {},
  runs: ScheduleRun[] = [],
): ScheduleDetail {
  return { ...scheduleItem(patch), runs, ...patch }
}
