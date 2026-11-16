import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import {
  resolveScheduleToolTriggers,
  scheduleChangingToolNames,
  scheduleCreateArgumentsSchema,
  scheduleDeleteArgumentsSchema,
  scheduleListArgumentsSchema,
  scheduleToolArgumentSchemas,
  scheduleToolNames,
  scheduleToolTriggersSchema,
  scheduleUpdateArgumentsSchema,
} from './tools.ts'
import { isScheduleTooOftenIssue, scheduleTriggersSchema } from './triggers.ts'

const id = '018f3b2e-7c4a-7b1c-9d2e-3f4a5b6c7de1'
const other = '018f3b2e-7c4a-7b1c-9d2e-3f4a5b6c7de2'

const create = {
  name: 'Курс валют',
  instructions: 'Пришли курс доллара, евро и юаня по ЦБ на сегодня.',
  triggers: [{ kind: 'weekdays', time: '09:00' }],
  confirmedByClient: true,
} as const

describe('schedule_create', () => {
  it('takes a task the client confirmed, with or without the optional fields', () => {
    expect(scheduleCreateArgumentsSchema.safeParse(create).success).toBe(true)
    expect(
      scheduleCreateArgumentsSchema.safeParse({
        ...create,
        effort: 'max',
        timezone: 'Asia/Novosibirsk',
        notify: false,
        triggers: [],
      }).success,
    ).toBe(true)
  })

  it('needs the confirmation of the client and refuses a key it does not know', () => {
    expect(
      scheduleCreateArgumentsSchema.safeParse({ ...create, confirmedByClient: false }).success,
    ).toBe(false)
    const { confirmedByClient: _confirmed, ...unconfirmed } = create
    expect(scheduleCreateArgumentsSchema.safeParse(unconfirmed).success).toBe(false)
    expect(scheduleCreateArgumentsSchema.safeParse({ ...create, workspaceId: id }).success).toBe(
      false,
    )
    expect(scheduleCreateArgumentsSchema.safeParse({ ...create, extra: true }).success).toBe(false)
    expect(scheduleCreateArgumentsSchema.safeParse({ ...create, effort: 'medium' }).success).toBe(
      false,
    )
  })

  it('checks the name and the words', () => {
    for (const name of ['', ' Проверка', 'Проверка\nсайта', 'а'.repeat(81)])
      expect(scheduleCreateArgumentsSchema.safeParse({ ...create, name }).success, name).toBe(false)
    expect(
      scheduleCreateArgumentsSchema.safeParse({ ...create, name: 'а'.repeat(80) }).success,
    ).toBe(true)
    for (const instructions of ['', '   ', 'a\u0007b', 'а'.repeat(4001)])
      expect(scheduleCreateArgumentsSchema.safeParse({ ...create, instructions }).success).toBe(
        false,
      )
    expect(
      scheduleCreateArgumentsSchema.parse({ ...create, instructions: '  Слова\n\tс отступом  ' })
        .instructions,
    ).toBe('Слова\n\tс отступом')
  })

  it('takes a single run some minutes from now, from 5 minutes to 30 days', () => {
    const once = (inMinutes: number) =>
      scheduleCreateArgumentsSchema.safeParse({
        ...create,
        triggers: [{ kind: 'once', inMinutes }],
      }).success
    expect(once(5)).toBe(true)
    expect(once(43_200)).toBe(true)
    expect(once(4)).toBe(false)
    expect(once(43_201)).toBe(false)
    expect(once(15.5)).toBe(false)
    // A single run from now and a date at once is neither.
    expect(
      scheduleCreateArgumentsSchema.safeParse({
        ...create,
        triggers: [{ kind: 'once', inMinutes: 15, date: '2026-11-20', time: '09:00' }],
      }).success,
    ).toBe(false)
  })

  it('takes a single run from now only in the tools, not as a stored schedule', () => {
    expect(scheduleTriggersSchema.safeParse([{ kind: 'once', inMinutes: 15 }]).success).toBe(false)
  })
})

describe('the project of a task set up in a chat (docs/plan/84-projects.md, ПР19)', () => {
  it('is this chat, none, or left out — nothing else', () => {
    for (const project of ['this_chat', 'none'])
      expect(scheduleCreateArgumentsSchema.safeParse({ ...create, project }).success).toBe(true)
    expect(scheduleCreateArgumentsSchema.safeParse({ ...create, project: id }).success).toBe(false)
    // A change never moves a task to another project.
    expect(
      scheduleUpdateArgumentsSchema.safeParse({
        scheduleId: id,
        project: 'none',
        confirmedByClient: true,
      }).success,
    ).toBe(false)
  })
})

describe('the schedules of a tool call', () => {
  const tooOften = (triggers: unknown) => {
    const parsed = scheduleToolTriggersSchema.safeParse(triggers)
    return !parsed.success && parsed.error.issues.some(isScheduleTooOftenIssue)
  }

  it('checks what is known without the clock', () => {
    expect(
      tooOften([
        { kind: 'daily', time: '09:00' },
        { kind: 'daily', time: '09:30' },
      ]),
    ).toBe(true)
    expect(
      tooOften([
        { kind: 'hourly', minute: 0 },
        { kind: 'once', inMinutes: 600 },
      ]),
    ).toBe(true)
    expect(
      tooOften([
        { kind: 'once', inMinutes: 30 },
        { kind: 'once', inMinutes: 60 },
      ]),
    ).toBe(true)
    expect(
      scheduleToolTriggersSchema.safeParse([
        { kind: 'once', inMinutes: 30 },
        { kind: 'once', inMinutes: 90 },
        { kind: 'daily', time: '09:00' },
      ]).success,
    ).toBe(true)
  })

  it('becomes stored schedules once the server counts the moments', () => {
    const triggers = resolveScheduleToolTriggers(
      [
        { kind: 'once', inMinutes: 15 },
        { kind: 'daily', time: '09:00' },
      ],
      'Europe/Moscow',
      // 10:00:30 UTC is 13:00:30 in Moscow; 15 minutes later, rounded up to the minute.
      new Date('2026-11-15T10:00:30Z'),
    )
    expect(triggers).toEqual([
      { kind: 'once', date: '2026-11-15', time: '13:16' },
      { kind: 'daily', time: '09:00' },
    ])
    expect(scheduleTriggersSchema.safeParse(triggers).success).toBe(true)
    // The wall clock of the task's zone, past midnight there.
    expect(
      resolveScheduleToolTriggers(
        [{ kind: 'once', inMinutes: 60 }],
        'Asia/Vladivostok',
        new Date('2026-11-15T13:30:00Z'),
      ),
    ).toEqual([{ kind: 'once', date: '2026-11-16', time: '00:30' }])
  })
})

describe('schedule_update and schedule_delete', () => {
  it('name exactly one of a task and a reservation of this turn', () => {
    const update = (target: Record<string, string>) =>
      scheduleUpdateArgumentsSchema.safeParse({
        ...target,
        enabled: false,
        confirmedByClient: true,
      }).success
    expect(update({ scheduleId: id })).toBe(true)
    expect(update({ reservedId: id })).toBe(true)
    expect(update({})).toBe(false)
    expect(update({ scheduleId: id, reservedId: other })).toBe(false)
    expect(update({ scheduleId: 'задача' })).toBe(false)

    const remove = (target: Record<string, string>) =>
      scheduleDeleteArgumentsSchema.safeParse({ ...target, confirmedByClient: true }).success
    expect(remove({ scheduleId: id })).toBe(true)
    expect(remove({ reservedId: id })).toBe(true)
    expect(remove({})).toBe(false)
    expect(remove({ scheduleId: id, reservedId: other })).toBe(false)
    expect(scheduleDeleteArgumentsSchema.safeParse({ scheduleId: id }).success).toBe(false)
  })

  it('say what changes, and change the fields of a task', () => {
    expect(
      scheduleUpdateArgumentsSchema.safeParse({ scheduleId: id, confirmedByClient: true }).success,
    ).toBe(false)
    expect(
      scheduleUpdateArgumentsSchema.safeParse({
        scheduleId: id,
        name: 'Новое название',
        instructions: 'Новые слова',
        effort: 'low',
        triggers: [{ kind: 'once', inMinutes: 30 }],
        timezone: 'Asia/Omsk',
        notify: true,
        enabled: true,
        confirmedByClient: true,
      }).success,
    ).toBe(true)
    expect(
      scheduleUpdateArgumentsSchema.safeParse({
        scheduleId: id,
        workspaceId: id,
        confirmedByClient: true,
      }).success,
    ).toBe(false)
  })
})

describe('the schedule tools', () => {
  it('list nothing to ask', () => {
    expect(scheduleListArgumentsSchema.safeParse({}).success).toBe(true)
    expect(scheduleListArgumentsSchema.safeParse({ all: true }).success).toBe(false)
  })

  it('have a schema each, and three of them change tasks', () => {
    expect(Object.keys(scheduleToolArgumentSchemas)).toEqual([...scheduleToolNames])
    expect(scheduleChangingToolNames).toEqual([
      'schedule_create',
      'schedule_update',
      'schedule_delete',
    ])
  })

  it('can be told to the model as JSON Schema', () => {
    for (const name of scheduleToolNames)
      expect(() => z.toJSONSchema(scheduleToolArgumentSchemas[name], { io: 'input' })).not.toThrow()
  })
})
