import { scheduleTemplateOf } from '@repo/domain/schedule'
import { describe, expect, it } from 'vitest'

import {
  canAddTrigger,
  chatDraftOf,
  formNextRun,
  formOfSchedule,
  formOfTemplate,
  formProblems,
  frequenciesOf,
  hasProblems,
  inScheduleTag,
  lastRunText,
  matchesSearch,
  missedText,
  newScheduleForm,
  newTriggerDraft,
  nextRunText,
  onceDateFor,
  runLines,
  scheduleStateText,
  sortSchedules,
  triggersOfForm,
  type RunLine,
  type ScheduleForm,
} from './schedule-model'
import { NOW, scheduleDetail, scheduleItem, scheduleRun, SITE_ID } from './testing'

const MSK = 'Europe/Moscow'
const at = (iso: string) => new Date(iso)
const site = (template: string) => {
  const found = scheduleTemplateOf(template)
  if (found === undefined) throw new Error(`no template ${template}`)
  return found
}
const form = (patch: Partial<ScheduleForm> = {}): ScheduleForm => ({
  ...newScheduleForm(MSK, NOW, 'high'),
  name: 'Проверка',
  instructions: 'Откройте сайт',
  ...patch,
})

describe('the filters, the search and the order of «Ваши» (Зп3)', () => {
  const on = scheduleItem({ id: 'a', name: 'Бета' })
  const paused = scheduleItem({ id: 'b', name: 'Альфа', enabled: false, nextRunAt: null })
  const completed = scheduleItem({
    id: 'c',
    name: 'Гамма',
    enabled: false,
    nextRunAt: null,
    pausedReason: 'completed',
  })
  const failed = scheduleItem({
    id: 'd',
    name: 'Дельта',
    nextRunAt: at('2026-11-15T10:00:00.000Z'),
    lastRun: scheduleRun({ state: { kind: 'refused', reason: 'no_credits' } }),
  })

  it('sorts a task by its state, «С ошибкой» by its last run', () => {
    expect(
      [on, paused, completed, failed].filter((item) => inScheduleTag(item, 'enabled')),
    ).toEqual([on, failed])
    expect(inScheduleTag(paused, 'paused')).toBe(true)
    expect(inScheduleTag(completed, 'paused')).toBe(false)
    expect(inScheduleTag(completed, 'completed')).toBe(true)
    expect(inScheduleTag(failed, 'failed')).toBe(true)
    expect(inScheduleTag(on, 'failed')).toBe(false)
  })

  it('finds by the name and by the instructions, without regard to case', () => {
    expect(matchesSearch(on, 'бЕта')).toBe(true)
    expect(matchesSearch(on, 'главную')).toBe(true)
    expect(matchesSearch(on, 'заявки')).toBe(false)
  })

  it('puts the nearest run first, tasks without one after them by name', () => {
    expect(sortSchedules([on, paused, completed, failed], 'next').map((item) => item.id)).toEqual([
      'd',
      'a',
      'b',
      'c',
    ])
    expect(sortSchedules([on, paused, completed], 'name').map((item) => item.id)).toEqual([
      'b',
      'a',
      'c',
    ])
  })
})

describe('the lines of a task (Зп5)', () => {
  it('says the next run, the pause, the end and why it stopped', () => {
    expect(scheduleStateText(scheduleItem(), NOW)).toBe('Следующий запуск: завтра в 9:00')
    expect(scheduleStateText(scheduleItem({ enabled: false, nextRunAt: null }), NOW)).toBe(
      'На паузе',
    )
    expect(
      scheduleStateText(
        scheduleItem({
          enabled: false,
          nextRunAt: null,
          pausedReason: 'completed',
          lastRunAt: at('2026-11-12T06:00:00.000Z'),
        }),
        NOW,
      ),
    ).toBe('Завершена 12 ноября')
    expect(
      scheduleStateText(
        scheduleItem({ enabled: false, nextRunAt: null, pausedReason: 'refused' }),
        NOW,
      ),
    ).toBe('Остановлена после трёх отказов подряд')
    expect(scheduleStateText(scheduleItem({ triggers: [], nextRunAt: null }), NOW)).toBe(
      'Запускается только вручную',
    )
  })

  it('names the zone of a task outside Moscow', () => {
    expect(
      scheduleStateText(
        scheduleItem({ timezone: 'Asia/Novosibirsk', nextRunAt: at('2026-11-16T02:00:00.000Z') }),
        NOW,
      ),
    ).toBe('Следующий запуск: завтра в 9:00 (по времени Новосибирска)')
  })

  it('says the latest run with its time', () => {
    expect(lastRunText(scheduleItem(), NOW)).toBeNull()
    expect(lastRunText(scheduleItem({ lastRun: scheduleRun() }), NOW)).toBe(
      'Выполнена · сегодня в 9:00',
    )
  })

  it('says «сегодня» and «завтра» of the window with the date', () => {
    expect(nextRunText(at('2026-11-16T06:00:00.000Z'), MSK, NOW)).toBe('завтра, 16 ноября, в 9:00')
    expect(nextRunText(at('2026-11-20T13:00:00.000Z'), MSK, NOW)).toBe(
      'пятница, 20 ноября, в 16:00',
    )
  })
})

describe('the runs of a task (Зп6)', () => {
  const hourly = [{ kind: 'hourly' as const, minute: 0 }]
  const missed = (id: string, iso: string, missedCount: number) =>
    scheduleRun({
      id,
      dueAt: at(iso),
      state: { kind: 'skipped', reason: 'missed', missedCount },
      chat: null,
      startedAt: null,
    })

  it('puts missed runs in a row on one line from the first to the last moment', () => {
    const runs = [
      scheduleRun({ id: 'new', dueAt: at('2026-11-15T12:00:00.000Z') }),
      missed('m2', '2026-11-15T09:00:00.000Z', 3),
      missed('m1', '2026-11-15T06:00:00.000Z', 1),
      scheduleRun({ id: 'old', dueAt: at('2026-11-15T05:00:00.000Z') }),
    ]
    const lines = runLines(runs, hourly, MSK)
    expect(lines.map((line) => line.kind)).toEqual(['run', 'missed', 'run'])
    const line = lines[1] as Extract<RunLine, { kind: 'missed' }>
    expect(line.runs.map((run) => run.id)).toEqual(['m2', 'm1'])
    // 9:00 in Moscow, and 12:00, 13:00, 14:00 for the three of the newer row.
    expect(missedText(line, MSK, NOW)).toBe('Пропущены запуски с 9:00 по 14:00')
  })

  it('says one missed moment as «Пропущено», and days when the line crosses one', () => {
    const one = runLines([missed('m', '2026-11-15T06:00:00.000Z', 1)], hourly, MSK)
    expect(missedText(one[0] as Extract<RunLine, { kind: 'missed' }>, MSK, NOW)).toBe('Пропущено')
    const night = runLines([missed('m', '2026-11-14T19:00:00.000Z', 4)], hourly, MSK)
    expect(missedText(night[0] as Extract<RunLine, { kind: 'missed' }>, MSK, NOW)).toBe(
      'Пропущены запуски с 14 ноября, 22:00 по 15 ноября, 1:00',
    )
  })
})

describe('the fields of the window (Зп7, Зп8)', () => {
  it('starts a new task every day at 9:00 in the zone it is given', () => {
    const fresh = newScheduleForm('Asia/Novosibirsk', NOW, 'max')
    expect(triggersOfForm(fresh)).toEqual([{ kind: 'daily', time: '09:00' }])
    expect(fresh.timezone).toBe('Asia/Novosibirsk')
    expect(fresh.effort).toBe('max')
    expect(fresh.notify).toBe(true)
  })

  it('keeps every schedule of a task and «Только вручную» as none', () => {
    const task = scheduleDetail({
      triggers: [
        { kind: 'weekly', time: '16:00', days: [1, 5] },
        { kind: 'monthly', time: '10:00', day: 31 },
        { kind: 'once', date: '2026-12-01', time: '08:30' },
      ],
    })
    expect(triggersOfForm(formOfSchedule(task, NOW))).toEqual(task.triggers)
    const manual = formOfSchedule(scheduleDetail({ triggers: [] }), NOW)
    expect(manual.triggers.map((draft) => draft.frequency)).toEqual(['manual'])
    expect(triggersOfForm(manual)).toEqual([])
    expect(formNextRun(manual, NOW)).toBeNull()
  })

  it('fills a template in, and its project only when there is just one', () => {
    const check = formOfTemplate(site('site-check'), MSK, NOW, SITE_ID)
    expect(check).toMatchObject({
      name: 'Проверка сайта',
      siteId: SITE_ID,
      effort: 'low',
      templateSlug: 'site-check',
    })
    expect(triggersOfForm(check)).toEqual([{ kind: 'weekdays', time: '09:00' }])
    expect(formOfTemplate(site('competitors'), MSK, NOW, SITE_ID).siteId).toBeNull()
  })

  it('offers «Каждый час» and «Только вручную» only alone, and five times at most', () => {
    expect(frequenciesOf(1)).toContain('hourly')
    expect(frequenciesOf(2)).not.toContain('hourly')
    expect(frequenciesOf(2)).not.toContain('manual')
    const five = form({ triggers: Array.from({ length: 5 }, () => newTriggerDraft(MSK, NOW)) })
    expect(canAddTrigger(five)).toBe(false)
    const hourly = form({ triggers: [{ ...newTriggerDraft(MSK, NOW), frequency: 'hourly' }] })
    expect(canAddTrigger(hourly)).toBe(false)
    expect(canAddTrigger(form())).toBe(true)
  })

  it('takes today for «Один раз» while the time is ahead, else tomorrow', () => {
    expect(onceDateFor('13:00', MSK, NOW)).toBe('2026-11-15')
    expect(onceDateFor('11:00', MSK, NOW)).toBe('2026-11-16')
  })
})

describe('what stops «Создать» (Зп8, Зп9, Зп11, Зп15)', () => {
  const options = { submitted: false, templateNeedsProject: false }

  it('says at once that a single run is in the past', () => {
    const draft = {
      ...newTriggerDraft(MSK, NOW),
      frequency: 'once' as const,
      date: '2026-11-15',
      time: '11:00',
    }
    const problems = formProblems(form({ triggers: [draft] }), NOW, options)
    expect(problems.triggers[draft.key]).toBe('Это время уже прошло — выберите другое')
    expect(hasProblems(problems)).toBe(true)
  })

  it('says at once that runs come closer than an hour', () => {
    const a = { ...newTriggerDraft(MSK, NOW), time: '09:00' }
    const b = { ...newTriggerDraft(MSK, NOW), time: '09:30' }
    expect(formProblems(form({ triggers: [a, b] }), NOW, options).schedule).toBe(
      'Запуски одной задачи — не чаще раза в час',
    )
    expect(formNextRun(form({ triggers: [a, b] }), NOW)).toBeNull()
  })

  it('wants a day of the week and the project of a template about a site', () => {
    const week = { ...newTriggerDraft(MSK, NOW), frequency: 'weekly' as const, days: [] }
    expect(formProblems(form({ triggers: [week] }), NOW, options).triggers[week.key]).toBe(
      'Выберите хотя бы один день',
    )
    expect(
      formProblems(form(), NOW, { submitted: false, templateNeedsProject: true }).project,
    ).toBe('Этому шаблону нужен проект — выберите его')
  })

  it('tells the empty name and instructions, and the place for the addresses, once saved', () => {
    const empty = form({ name: ' ', instructions: '' })
    expect(hasProblems(formProblems(empty, NOW, options))).toBe(false)
    expect(formProblems(empty, NOW, { ...options, submitted: true })).toMatchObject({
      name: 'Назовите задачу',
      instructions: 'Напишите, что сделать агенту',
    })
    const competitors = formOfTemplate(site('competitors'), MSK, NOW, null)
    expect(formProblems(competitors, NOW, { ...options, submitted: true }).instructions).toBe(
      'Впишите адреса сайтов конкурентов',
    )
  })
})

describe('the draft of «Настроить в чате» (Зп10)', () => {
  it('asks for help, with what the window holds', () => {
    expect(chatDraftOf(null)).toBe('Помогите настроить запланированную задачу')
    expect(chatDraftOf(form({ name: '', instructions: '' }))).toBe(
      'Помогите настроить запланированную задачу',
    )
    expect(chatDraftOf(form({ name: 'Проверка', instructions: 'Откройте сайт' }))).toBe(
      'Помогите настроить запланированную задачу «Проверка»: Откройте сайт; Ежедневно в 9:00',
    )
  })
})
