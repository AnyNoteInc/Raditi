import { describe, expect, it } from 'vitest'

import { activityLine, elapsedText, progressBar, progressText } from './progress-text.ts'

describe('the message of the work of the agent', () => {
  it('moves the bar one step a tick, along and back', () => {
    expect([0, 1, 5, 6, 10, 11].map(progressBar)).toEqual([
      '▰▱▱▱▱▱',
      '▱▰▱▱▱▱',
      '▱▱▱▱▱▰',
      '▱▱▱▱▰▱',
      '▰▱▱▱▱▱',
      '▱▰▱▱▱▱',
    ])
  })

  it('says how long the agent works and what it does now, in the words of the client', () => {
    expect(elapsedText(5_400)).toBe('5 с')
    expect(elapsedText(65_000)).toBe('1 мин 05 с')
    expect(activityLine({ type: 'tool_call', tool: 'raditi_web_open', ok: true })).toBe(
      'Открывает страницу',
    )
    expect(
      activityLine({ type: 'command', command: 'grep -rn  "price"   .', exitCode: null }),
    ).toBe('Выполняет команду: grep -rn "price" .')
    expect(activityLine({ type: 'file_change', path: 'style.css', change: 'update' })).toBe(
      'Правит файл style.css',
    )
    expect(progressText({ tick: 0, status: 'queued', event: null, elapsedMs: 2_000 })).toBe(
      '▰▱▱▱▱▱  Агент работает · 2 с\nВ очереди: агент скоро возьмётся за работу',
    )
    expect(progressText({ tick: 2, status: 'running', event: null, elapsedMs: 0 })).toBe(
      '▱▱▰▱▱▱  Агент работает · 0 с\nРазбирается в задаче',
    )
  })
})
