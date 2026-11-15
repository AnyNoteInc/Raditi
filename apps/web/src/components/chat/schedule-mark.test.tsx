// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ScheduleMark, ScheduleSign, scheduleLabelText } from './schedule-mark'
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
