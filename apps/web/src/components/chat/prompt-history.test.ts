// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'

import type { FeedRow } from './chat-types'
import {
  PROMPT_HISTORY_LIMIT,
  readPromptHistory,
  rememberPrompt,
  requestHistoryOf,
} from './prompt-history'

describe('the history of a chat', () => {
  it('is the client’s words, the newest first, a repeat once, no presses', () => {
    const rows = [
      { type: 'feed.request', kind: 'first', id: '1', text: 'Добавьте новость' },
      { type: 'feed.result', id: '2' },
      { type: 'feed.request', kind: 'command', id: '3', command: 'release' },
      { type: 'feed.request', kind: 'answer', id: '4', text: 'Поменяйте заголовок' },
      { type: 'feed.request', kind: 'revision', id: '5', text: 'Добавьте новость' },
    ] as unknown as FeedRow[]
    expect(requestHistoryOf(rows)).toEqual(['Добавьте новость', 'Поменяйте заголовок'])
  })
})

describe('the history of this browser', () => {
  beforeEach(() => window.localStorage.clear())

  it('keeps the last requests per user, the newest first, a repeat moved up', () => {
    rememberPrompt('u1', 'Раз')
    rememberPrompt('u1', 'Два')
    rememberPrompt('u1', 'Раз')
    rememberPrompt('u2', 'Чужое')
    expect(readPromptHistory('u1')).toEqual(['Раз', 'Два'])
    expect(readPromptHistory('u2')).toEqual(['Чужое'])
  })

  it('keeps no more than its limit and reads a broken record as none', () => {
    for (let index = 0; index < PROMPT_HISTORY_LIMIT + 5; index++) rememberPrompt('u1', `№${index}`)
    expect(readPromptHistory('u1')).toHaveLength(PROMPT_HISTORY_LIMIT)
    window.localStorage.setItem('raditi-prompt-history:u1', '{')
    expect(readPromptHistory('u1')).toEqual([])
  })
})
