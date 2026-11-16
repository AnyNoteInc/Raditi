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
  scheduleProjectTemplates,
  scheduleProjectTemplateSlugs,
  scheduleTemplatesOfProject,
  scheduleTemplateOf,
  scheduleTemplatePlaceholderRange,
  scheduleTemplates,
  scheduleTemplateSlugs,
} from './templates.ts'
import { scheduleText } from './text.ts'
import { scheduleTriggersSchema } from './triggers.ts'

describe('the templates of a project (docs/plan/84-projects.md, ПР19, 84.14)', () => {
  it('are three tasks the window would save, two of them of a repository', () => {
    expect(scheduleProjectTemplates.map((template) => template.slug)).toEqual([
      ...scheduleProjectTemplateSlugs,
    ])
    for (const template of scheduleProjectTemplates) {
      expect(scheduleNameSchema.safeParse(template.name).success).toBe(true)
      expect(scheduleInstructionsSchema.safeParse(template.instructions).success).toBe(true)
      expect(scheduleTriggersSchema.safeParse(template.triggers).success).toBe(true)
      expect(hasScheduleTemplatePlaceholder(template.instructions)).toBe(false)
      expect(scheduleTemplateOf(template.slug)).toBe(template)
    }
    expect(
      scheduleProjectTemplates.filter((t) => t.needs === 'repository').map((t) => t.slug),
    ).toEqual(['build-check', 'merge-requests'])
  })

  it('never ask a run without its client to open, accept or deploy', () => {
    const builds = scheduleTemplateOf('build-check')!.instructions
    expect(builds).toContain('исправь и подготовь изменения — запрос на слияние открою я сам')
    for (const template of scheduleProjectTemplates)
      expect(template.instructions).not.toMatch(/открой запрос|прими|выкат|разверн/iu)
  })

  it('are offered in a project, the repository ones only with a repository', () => {
    const without = scheduleTemplatesOfProject({ repository: false }).map((t) => t.slug)
    expect(without[0]).toBe('week-plan')
    expect(without).not.toContain('build-check')
    expect(without).toContain('currency-rates')
    const withRepo = scheduleTemplatesOfProject({ repository: true }).map((t) => t.slug)
    expect(withRepo.slice(0, 3)).toEqual(['build-check', 'merge-requests', 'week-plan'])
  })
})

describe('the templates of «Шаблоны» (§4.6, Зп58)', () => {
  it('are the six of the plan, each one a task the window would save', () => {
    expect([...scheduleTemplateSlugs]).toEqual([
      'currency-rates',
      'competitors',
      'site-check',
      'reviews',
      'post-ideas',
      'holidays',
    ])
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
      'currency-rates': 'По будням в 9:00',
      competitors: 'Еженедельно: понедельник, в 10:00',
      'site-check': 'По будням в 9:00',
      reviews: 'Еженедельно: понедельник, в 9:00',
      'post-ideas': 'Еженедельно: понедельник, в 9:00',
      holidays: 'Ежемесячно: 25-го числа, в 10:00',
    })
  })

  it('ask as the client asks in a chat, and speak to the client on «вы» in a hint', () => {
    for (const template of scheduleTemplates) {
      // «Найди…», «Пришли…»: the request of the client to the agent, as on the landing.
      expect(template.instructions).toMatch(/^[А-ЯЁ][а-яё]*[ий] /u)
      // None needs a project or a site's admin (Зп58).
      expect(`${template.instructions} ${template.hint ?? ''}`).not.toMatch(/проект|админк/iu)
      if (template.hint !== undefined) expect(template.hint).toMatch(/(?:^|\s)ваш/u)
    }
  })

  it('mark the places the client fills in, which have to be filled in (Зп59)', () => {
    const left = scheduleTemplates.filter((template) =>
      hasScheduleTemplatePlaceholder(template.instructions),
    )
    expect(left.map((template) => template.slug)).toEqual(['competitors', 'site-check', 'reviews'])
    expect(hasScheduleTemplatePlaceholder('Сайты: [Впишите адреса]')).toBe(true)
    expect(hasScheduleTemplatePlaceholder('Сайты: [впишите]')).toBe(true)
    expect(hasScheduleTemplatePlaceholder('Сайты: [адреса]')).toBe(false)
    const competitors = scheduleTemplateOf('competitors')!.instructions
    const range = scheduleTemplatePlaceholderRange(competitors)!
    expect(competitors.slice(range.start, range.end)).toBe('[впишите адреса сайтов]')
    const filled = `${competitors.slice(0, range.start)}kofe.ru, chai.ru${competitors.slice(range.end)}`
    expect(hasScheduleTemplatePlaceholder(filled)).toBe(false)
    expect(scheduleTemplatePlaceholderRange(filled)).toBeNull()
  })
})

describe('the state of a run (Зп5)', () => {
  it('has words for every state and every reason', () => {
    const states: ScheduledRunState[] = [
      { kind: 'pending' },
      { kind: 'running' },
      { kind: 'done' },
      { kind: 'waiting' },
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
        missedUntil: reason === 'missed' ? new Date('2026-11-16T11:00:00Z') : null,
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
    expect(scheduledRunStateText({ kind: 'failed' })).toBe('Не выполнена')
    expect(scheduledRunStateText({ kind: 'refused', reason: 'needs_tariff' })).toBe(
      'Не запустилась: нужен тариф',
    )
    expect(
      scheduledRunStateText({
        kind: 'skipped',
        reason: 'missed',
        missedCount: 3,
        missedUntil: null,
      }),
    ).toBe('Пропущено')
    expect(
      scheduledRunStateText({
        kind: 'skipped',
        reason: 'previous_running',
        missedCount: 0,
        missedUntil: null,
      }),
    ).toBe('Пропущено: предыдущий запуск ещё шёл')
    expect(scheduledRunStateText({ kind: 'stopped', cause: 'weekly_limit' })).toBe(
      'Остановилась: исчерпан недельный лимит',
    )
  })
})
