// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ScheduleMark, ScheduleSign, scheduleLabelText, scheduleMarkShown } from './schedule-mark'
import { SCHEDULE_ID } from './testing'

describe('the label of a chat of a run (docs/plan/82-scheduled-tasks.md, Зп43)', () => {
  it('says how the run began and leads to its task', () => {
    render(<ScheduleMark schedule={{ id: SCHEDULE_ID, name: 'Отчёт', trigger: 'schedule' }} />)
    const link = screen.getByRole('link', { name: 'По расписанию · Отчёт' })
    expect(link.getAttribute('href')).toBe(`/scheduled/${SCHEDULE_ID}`)
  })

  it('names a run by hand', () => {
    expect(scheduleLabelText({ id: SCHEDULE_ID, name: 'Отчёт', trigger: 'manual' })).toBe(
      'Запуск вручную · Отчёт',
    )
  })

  it('does not say the name twice under a chat named as its task', () => {
    const schedule = { id: SCHEDULE_ID, name: 'Отчёт', trigger: 'schedule' } as const
    render(<ScheduleMark schedule={schedule} chatTitle="Отчёт" />)
    // The words shown start the name of the link, which still names the task.
    const link = screen.getByRole('link', { name: 'По расписанию · Отчёт' })
    expect(link.textContent).toBe('По расписанию')
    expect(link.getAttribute('href')).toBe(`/scheduled/${SCHEDULE_ID}`)
    expect(scheduleMarkShown({ id: null, name: 'Отчёт', trigger: 'manual' }, ' Отчёт ')).toBe(
      'Запуск вручную',
    )
  })

  it('names the task under a chat that was renamed', () => {
    const schedule = { id: SCHEDULE_ID, name: 'Отчёт', trigger: 'manual' } as const
    render(<ScheduleMark schedule={schedule} chatTitle="Отчёт за понедельник" />)
    const link = screen.getByRole('link', { name: 'Запуск вручную · Отчёт' })
    expect(link.textContent).toBe('Запуск вручную · Отчёт')
    expect(link.hasAttribute('aria-label')).toBe(false)
  })

  it('keeps the name of a deleted task without a link (Зп23)', () => {
    render(<ScheduleMark schedule={{ id: null, name: 'Отчёт', trigger: 'schedule' }} />)
    expect(screen.getByText('По расписанию · Отчёт')).toBeTruthy()
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('tells a screen reader what the stopwatch of a row means', () => {
    const { rerender } = render(
      <ScheduleSign schedule={{ id: SCHEDULE_ID, name: 'Отчёт', trigger: 'schedule' }} />,
    )
    expect(screen.getByText('Запуск запланированной задачи по расписанию')).toBeTruthy()
    rerender(<ScheduleSign schedule={{ id: null, name: 'Отчёт', trigger: 'manual' }} />)
    expect(screen.getByText('Запуск запланированной задачи вручную')).toBeTruthy()
  })
})
