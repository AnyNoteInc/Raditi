import { describe, expect, it } from 'vitest'

import { dayPartOf, greetingLines, greetingName, greetingOf } from './chat-greeting'

describe('greeting of a new chat', () => {
  it('names the part of the day by the hour', () => {
    expect([4, 5, 11, 12, 17, 18, 22, 23, 0].map(dayPartOf)).toEqual([
      'night',
      'morning',
      'morning',
      'day',
      'day',
      'evening',
      'evening',
      'night',
      'night',
    ])
  })

  it('calls the client by the first name, and greets without one', () => {
    expect(greetingOf('morning', greetingName('Виктор Луферов'), 0)).toEqual({
      title: 'Доброе утро, Виктор!',
      line: 'Готовы, когда вы готовы.',
    })
    expect(greetingOf('evening', greetingName('  '), 1).title).toBe('Добрый вечер!')
    expect(greetingName('client@example.ru')).toBeNull()
    expect(greetingOf('any', null, 0).title).toBe('Здравствуйте!')
  })

  it('takes any pick as one of the lines', () => {
    for (const pick of [0, 4, 5, 99, -3, 2.7])
      expect(greetingLines).toContain(greetingOf('day', null, pick).line)
  })
})
