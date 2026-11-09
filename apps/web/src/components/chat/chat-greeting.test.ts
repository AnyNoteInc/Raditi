import { describe, expect, it } from 'vitest'

import {
  dayPartOf,
  greetingChoices,
  greetingLines,
  greetingName,
  greetingOf,
} from './chat-greeting'

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
    expect(greetingOf('morning', greetingName('Виктор Луферов'), 0)).toBe('Доброе утро, Виктор!')
    expect(greetingOf('evening', greetingName('  '), 0)).toBe('Добрый вечер!')
    expect(greetingName('client@example.ru')).toBeNull()
    expect(greetingOf('any', null, 0)).toBe('Здравствуйте!')
  })

  it('opens with either the greeting or one phrase, never both', () => {
    const seen = new Set<string>()
    for (let pick = 0; pick < greetingChoices; pick++) seen.add(greetingOf('day', 'Виктор', pick))
    expect([...seen]).toEqual(['Добрый день, Виктор!', ...greetingLines])
    for (const pick of [99, -3, 2.7]) expect([...seen]).toContain(greetingOf('day', 'Виктор', pick))
  })
})
