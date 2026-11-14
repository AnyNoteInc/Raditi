import { describe, expect, it } from 'vitest'

import { chatSuggestions, chatSuggestionsFor } from './chat-suggestions.ts'

describe('the suggestions of a new chat', () => {
  it('follow what the chat will be able to do', () => {
    expect(chatSuggestionsFor({ repository: true, browser: true })).toBe(chatSuggestions.code)
    expect(chatSuggestionsFor({ repository: false, browser: true })).toBe(chatSuggestions.browser)
    expect(chatSuggestionsFor({ repository: false, browser: false })).toBe(chatSuggestions.plain)
    expect(chatSuggestionsFor(null)).toBe(chatSuggestions.plain)
  })

  it('are four short requests each, in Russian, without English words', () => {
    for (const list of [chatSuggestions.code, chatSuggestions.browser, chatSuggestions.plain]) {
      expect(list).toHaveLength(4)
      for (const text of list) {
        expect(text.length).toBeLessThan(90)
        expect(text).not.toMatch(/[A-Za-z]/)
      }
    }
  })
})
