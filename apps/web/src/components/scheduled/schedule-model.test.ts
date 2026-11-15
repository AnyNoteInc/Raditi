import { scheduleTemplateOf } from '@repo/domain/schedule'
import { describe, expect, it } from 'vitest'

import {
  addedTriggerDraft,
  canAddTrigger,
  chatDraftOf,
  formEdited,
  formNextRun,
  formOfSchedule,
  formOfTemplate,
  formProblems,
  frequenciesOf,
  hasProblems,
  GONE_PROJECTS,
  inProject,
  inScheduleTag,
  lastRunText,
  liveProjectId,
  matchesSearch,
  missedText,
  newScheduleForm,
  newTriggerDraft,
  nextRunText,
  onceDateFor,
  projectsOfSchedules,
  projectText,
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

  // F9: a deleted project is no live project (Зп22): its tasks go together, never by its name.
  it('puts the tasks of deleted projects in one group «Проект удалён»', () => {
    const own = scheduleItem({ id: 'e' })
    const none = scheduleItem({ id: 'f', project: null })
    const gone = (id: string, name: string) =>
      scheduleItem({
        id,
        project: { id: `0199a3f2-0000-8000-8000-00000000000${id}`, name, deleted: true },
      })
    const first = gone('1', 'Старый сайт')
    const second = gone('2', 'Другой старый')
    const items = [own, first, none, second]
    expect(projectsOfSchedules(items)).toEqual([
      { id: SITE_ID, name: 'Кофейня «Крошка»' },
      { id: GONE_PROJECTS, name: 'Проект удалён' },
      { id: null, name: null },
    ])
    expect(items.filter((item) => inProject(item, GONE_PROJECTS))).toEqual([first, second])
    expect(items.filter((item) => inProject(item, SITE_ID))).toEqual([own])
    expect(items.filter((item) => inProject(item, first.project!.id))).toEqual([])
    expect(items.map(projectText)).toEqual([
      'Кофейня «Крошка»',
      'Проект удалён',
      'Без проекта',
      'Проект удалён',
    ])
    expect(items.map(liveProjectId)).toEqual([SITE_ID, null, null, null])
  })

  // The window keeps the project of the task, so that a move from it is sent (`changeOf`).
  it('keeps a deleted project in the form of the task', () => {
    const schedule = scheduleDetail({
      project: { id: '0199a3f2-0000-8000-8000-000000000009', name: 'Старый', deleted: true },
    })
    expect(formOfSchedule(schedule, NOW).siteId).toBe('0199a3f2-0000-8000-8000-000000000009')
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
  const missed = (id: string, iso: string, missedCount: number, until: string | null = null) =>
    scheduleRun({
      id,
      dueAt: at(iso),
      state: {
        kind: 'skipped',
        reason: 'missed',
        missedCount,
        missedUntil: until === null ? null : at(until),
      },
      chat: null,
      startedAt: null,
    })

  const missedLine = (line: RunLine | undefined) => {
    if (line?.kind !== 'missed') throw new Error('not a line of missed runs')
    return line
  }

  it('puts missed runs in a row on one line, from the first of them to the end the newest kept', () => {
    const runs = [
      scheduleRun({ id: 'new', dueAt: at('2026-11-15T12:00:00.000Z') }),
      missed('m2', '2026-11-15T09:00:00.000Z', 3, '2026-11-15T11:00:00.000Z'),
      missed('m1', '2026-11-15T06:00:00.000Z', 1, '2026-11-15T06:00:00.000Z'),
      scheduleRun({ id: 'old', dueAt: at('2026-11-15T05:00:00.000Z') }),
    ]
    const lines = runLines(runs)
    expect(lines.map((line) => line.kind)).toEqual(['run', 'missed', 'run'])
    const line = missedLine(lines[1])
    expect(line.runs.map((run) => run.id)).toEqual(['m2', 'm1'])
    expect(line.from).toEqual(at('2026-11-15T06:00:00.000Z'))
    expect(line.to).toEqual(at('2026-11-15T11:00:00.000Z'))
    expect(line.count).toBe(4)
    // 9:00 and 14:00 in Moscow, one day.
    expect(missedText(line, MSK, NOW)).toBe('Пропущены запуски с 9:00 по 14:00')
  })

  it('names the days of a gap across midnight', () => {
    const night = missedLine(
      runLines([missed('m', '2026-11-14T20:00:00.000Z', 4, '2026-11-14T23:00:00.000Z')])[0],
    )
    expect(missedText(night, MSK, NOW)).toMatch(/^Пропущены запуски с .+, 23:00 по .+, 2:00$/)
  })

  it('says one missed moment as «Пропущено», and a gap without its end by how many', () => {
    expect(
      missedText(missedLine(runLines([missed('m', '2026-11-15T06:00:00.000Z', 1)])[0]), MSK, NOW),
    ).toBe('Пропущено')
    // A row written before the server kept the end: the schedule of the task now may not be the
    // one that missed them, so the end is never rebuilt from it (F24).
    const night = missedLine(runLines([missed('m', '2026-11-14T19:00:00.000Z', 21)])[0])
    expect(missedText(night, MSK, NOW)).toBe('Пропущен 21 запуск, начиная с 22:00')
    const many = missedLine(runLines([missed('m', '2026-11-14T19:00:00.000Z', 5)])[0])
    expect(missedText(many, MSK, NOW)).toBe('Пропущено 5 запусков, начиная с 22:00')
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

  // F28: a new block never meets the ones already there, so the window does not turn red at once.
  it('adds a block that keeps an hour from the others, five of them still valid', () => {
    let shown = form()
    for (let index = 0; index < 4; index += 1)
      shown = { ...shown, triggers: [...shown.triggers, addedTriggerDraft(shown, NOW)] }
    expect(triggersOfForm(shown)).toEqual([
      { kind: 'daily', time: '09:00' },
      { kind: 'daily', time: '12:00' },
      { kind: 'daily', time: '15:00' },
      { kind: 'daily', time: '18:00' },
      { kind: 'daily', time: '21:00' },
    ])
    expect(
      hasProblems(formProblems(shown, NOW, { submitted: true, templateNeedsProject: false })),
    ).toBe(false)
    expect(formNextRun(shown, NOW)).not.toBeNull()
  })

  it('takes the next free hour, and the plain 9:00 when none is', () => {
    const daily = (time: string) => ({ ...newTriggerDraft(MSK, NOW), time })
    // 23:00 + 3 is 2:00, which meets nothing: the clock wraps.
    expect(addedTriggerDraft(form({ triggers: [daily('23:00')] }), NOW).time).toBe('02:00')
    // 9:00 + 3 is 12:00, which meets 12:30, and so does 13:00: 14:00 keeps an hour from both.
    expect(addedTriggerDraft(form({ triggers: [daily('12:30'), daily('09:00')] }), NOW).time).toBe(
      '14:00',
    )
    // Schedules that already meet leave no hour: the window says why.
    const met = form({ triggers: [daily('09:00'), daily('09:30')] })
    expect(addedTriggerDraft(met, NOW).time).toBe('09:00')
    // «Один раз» takes its next date for the time, should the client switch to it: 12:00 now.
    expect(addedTriggerDraft(form({ triggers: [daily('09:00')] }), NOW).date).toBe('2026-11-16')
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

  // F27: a half-typed or cleared date is the block's own fault, not the rule of an hour.
  it.each(['', '0002-11-15', '0202-11-15'])(
    'wants the date of «Один раз» when the field holds %j, and no rule of an hour',
    (date) => {
      const once = { ...newTriggerDraft(MSK, NOW), frequency: 'once' as const, date }
      const problems = formProblems(form({ triggers: [once] }), NOW, options)
      expect(problems.triggers[once.key]).toBe('Укажите дату')
      expect(problems.schedule).toBeUndefined()
      expect(hasProblems(problems)).toBe(true)
      expect(formNextRun(form({ triggers: [once] }), NOW)).toBeNull()
    },
  )

  it('still says the rule of an hour of the other blocks beside a date not given', () => {
    const once = { ...newTriggerDraft(MSK, NOW), frequency: 'once' as const, date: '' }
    const a = { ...newTriggerDraft(MSK, NOW), time: '09:00' }
    const b = { ...newTriggerDraft(MSK, NOW), time: '09:30' }
    const problems = formProblems(form({ triggers: [a, b, once] }), NOW, options)
    expect(problems.schedule).toBe('Запуски одной задачи — не чаще раза в час')
    expect(problems.triggers[once.key]).toBe('Укажите дату')
  })

  // F31: the server checks a single run in the past only when the schedules change (Зп15, Зп24).
  it('lets a finished «Один раз» be renamed, and says its past once its schedules change', () => {
    const task = scheduleDetail({
      triggers: [{ kind: 'once', date: '2026-11-14', time: '09:00' }],
      enabled: false,
      pausedReason: 'completed',
    })
    const saved = formOfSchedule(task, NOW)
    const renamed = { ...saved, name: 'Проверка перед выпуском' }
    expect(hasProblems(formProblems(renamed, NOW, { ...options, submitted: true, saved }))).toBe(
      false,
    )
    const [draft] = saved.triggers
    if (draft === undefined) throw new Error('no block')
    const moved = { ...saved, triggers: [{ ...draft, time: '10:00' }] }
    expect(formProblems(moved, NOW, { ...options, saved }).triggers[draft.key]).toBe(
      'Это время уже прошло — выберите другое',
    )
    const rezoned = { ...saved, timezone: 'Asia/Novosibirsk' }
    expect(formProblems(rezoned, NOW, { ...options, saved }).triggers[draft.key]).toBe(
      'Это время уже прошло — выберите другое',
    )
    // A new task is always told.
    expect(formProblems(saved, NOW, options).triggers[draft.key]).toBe(
      'Это время уже прошло — выберите другое',
    )
  })

  // F26: one refusal of the server for the name and the words; the window tells the name by itself.
  it('tells a name that reads as a key under «Название», once saved', () => {
    const keyed = form({ name: 'Kx9mP2vLq7wZ' })
    expect(formProblems(keyed, NOW, options).name).toBeUndefined()
    expect(formProblems(keyed, NOW, { ...options, submitted: true }).name).toBe(
      'Похоже, в названии пароль или ключ — уберите его',
    )
    expect(
      formProblems(form({ name: 'Проверка сайта' }), NOW, { ...options, submitted: true }).name,
    ).toBeUndefined()
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

describe('what the client changed in the window', () => {
  it('counts the words, the schedules, the level and the notice — not the zone or the project', () => {
    const was = form()
    expect(formEdited({ ...was }, was)).toBe(false)
    expect(formEdited({ ...was, timezone: 'Asia/Novosibirsk', siteId: SITE_ID }, was)).toBe(false)
    expect(formEdited({ ...was, name: 'Другая' }, was)).toBe(true)
    expect(formEdited({ ...was, instructions: 'Другая' }, was)).toBe(true)
    expect(formEdited({ ...was, effort: 'max' }, was)).toBe(true)
    expect(formEdited({ ...was, notify: false }, was)).toBe(true)
    const [draft] = was.triggers
    if (draft === undefined) throw new Error('no block')
    expect(formEdited({ ...was, triggers: [{ ...draft, time: '10:00' }] }, was)).toBe(true)
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
