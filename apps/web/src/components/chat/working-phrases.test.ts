import { describe, expect, it } from 'vitest'

import { WORKING_PHRASE_SECONDS, workingPhraseOf, workingPhrases } from './working-phrases'

describe('the line under the work of the agent (14.11.2026)', () => {
  it('has thirty phrases in Russian, each once', () => {
    expect(workingPhrases).toHaveLength(30)
    expect(new Set(workingPhrases).size).toBe(30)
    for (const phrase of workingPhrases) expect(phrase).toMatch(/^[А-ЯЁ][а-яё ]+$/)
  })

  it('steps on every few seconds and starts each turn on its own phrase', () => {
    expect(workingPhraseOf(1, 0)).toBe(workingPhraseOf(1, WORKING_PHRASE_SECONDS - 1))
    expect(workingPhraseOf(1, 0)).not.toBe(workingPhraseOf(1, WORKING_PHRASE_SECONDS))
    expect(workingPhraseOf(1, 0)).not.toBe(workingPhraseOf(2, 0))
    expect(workingPhraseOf(3, 12)).toMatch(/…$/)
  })
})
