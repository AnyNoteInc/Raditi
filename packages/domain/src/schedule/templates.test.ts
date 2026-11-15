import { describe, expect, it } from 'vitest'

import { reasoningEffortSchema } from '../llm/model-class.ts'
import { scheduleInstructionsSchema, scheduleNameSchema } from './fields.ts'
import { scheduledRunReasons } from './runs.ts'
import {
  scheduledRunStateKinds,
  scheduledRunStateSchema,
  scheduledRunStateText,
  type ScheduledRunState,
} from './run-states.ts'
import {
  hasScheduleTemplatePlaceholder,
  SCHEDULE_TEMPLATE_PLACEHOLDER,
  scheduleTemplateOf,
  scheduleTemplates,
  scheduleTemplateSlugs,
} from './templates.ts'
import { scheduleText } from './text.ts'
import { scheduleTriggersSchema } from './triggers.ts'

describe('the templates of «Шаблоны» (§4.6)', () => {
  it('are the six of the plan, each one a task the window would save', () => {
    expect(scheduleTemplates.map((template) => template.slug)).toEqual([...scheduleTemplateSlugs])
    for (const template of scheduleTemplates) {
      expect(template.slug.length).toBeLessThanOrEqual(40)
      expect(scheduleNameSchema.safeParse(template.name).success).toBe(true)
      expect(scheduleInstructionsSchema.safeParse(template.instructions).success).toBe(true)
      expect(scheduleTriggersSchema.safeParse(template.triggers).success).toBe(true)
      expect(reasoningEffortSchema.safeParse(template.effort).success).toBe(true)
      expect(scheduleTemplateOf(template.slug)).toBe(template)
    }
    expect(scheduleTemplateOf('nothing')).toBeUndefined()
  })

  it('run as the plan says: weekdays, weekly and monthly in Moscow', () => {
    const text = Object.fromEntries(
      scheduleTemplates.map((template) => [
        template.slug,
        scheduleText(template.triggers, 'Europe/Moscow'),
      ]),
    )
    expect(text).toEqual({
      'site-check': 'По будням в 9:00',
      'leads-digest': 'По будням в 8:00',
      'news-ideas': 'Еженедельно: понедельник, в 9:00',
      'site-week': 'Еженедельно: пятница, в 16:00',
      competitors: 'Еженедельно: понедельник, в 10:00',
      'seo-check': 'Ежемесячно: 1-го числа, в 10:00',
    })
  })

  it('leave only «Конкуренты» with the place for addresses, which has to be filled in (Зп9)', () => {
    const left = scheduleTemplates.filter((template) =>
      hasScheduleTemplatePlaceholder(template.instructions),
    )
    expect(left.map((template) => template.slug)).toEqual(['competitors'])
    expect(hasScheduleTemplatePlaceholder('Сайты: [Впишите адреса]')).toBe(true)
    expect(
      hasScheduleTemplatePlaceholder(
        scheduleTemplateOf('competitors')!.instructions.replace(
          SCHEDULE_TEMPLATE_PLACEHOLDER,
          'kofe.ru, chai.ru',
        ),
      ),
    ).toBe(false)
  })
})

describe('the state of a run (Зп5)', () => {
  it('has words for every state and every reason', () => {
    const states: ScheduledRunState[] = [
      { kind: 'pending' },
      { kind: 'running' },
      { kind: 'done' },
      { kind: 'waiting' },
      { kind: 'ready' },
      { kind: 'failed' },
      { kind: 'stopped', cause: 'credits' },
      { kind: 'stopped', cause: 'weekly_limit' },
      { kind: 'stopped', cause: null },
      { kind: 'chat_deleted' },
      ...scheduledRunReasons.map((reason) => ({ kind: 'refused' as const, reason })),
      ...scheduledRunReasons.map((reason) => ({
        kind: 'skipped' as const,
        reason,
        missedCount: 1,
      })),
    ]
    for (const state of states) {
      expect(scheduledRunStateSchema.parse(state)).toEqual(state)
      expect(scheduledRunStateText(state)).toMatch(/^[А-ЯЁ][^.]*$/u)
    }
    expect(new Set(states.map((state) => state.kind))).toEqual(new Set(scheduledRunStateKinds))
  })

  it('says the words of the plan', () => {
    expect(scheduledRunStateText({ kind: 'done' })).toBe('Выполнена')
    expect(scheduledRunStateText({ kind: 'waiting' })).toBe('Ждёт вашего ответа')
    expect(scheduledRunStateText({ kind: 'ready' })).toBe('Изменения готовы')
    expect(scheduledRunStateText({ kind: 'failed' })).toBe('Не выполнена')
    expect(scheduledRunStateText({ kind: 'refused', reason: 'needs_tariff' })).toBe(
      'Не запустилась: нужен тариф',
    )
    expect(scheduledRunStateText({ kind: 'skipped', reason: 'missed', missedCount: 3 })).toBe(
      'Пропущено',
    )
    expect(
      scheduledRunStateText({ kind: 'skipped', reason: 'previous_running', missedCount: 0 }),
    ).toBe('Пропущено: предыдущий запуск ещё шёл')
    expect(scheduledRunStateText({ kind: 'stopped', cause: 'weekly_limit' })).toBe(
      'Остановилась: исчерпан недельный лимит',
    )
  })
})
