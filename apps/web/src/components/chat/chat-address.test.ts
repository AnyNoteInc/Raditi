import { describe, expect, it } from 'vitest'

import { chatHref, newChatHref, projectOfSearch } from './chat-address'

const task = '0199a3f2-5d1c-7b3e-9c41-2f6a8d0e4b18'

describe('the addresses of chats', () => {
  it('names a chat and a new chat', () => {
    expect(chatHref(task)).toBe(`/chats/${task}`)
    expect(newChatHref()).toBe('/chats/new')
  })

  it('chooses the project of a new chat by the address (docs/plan/84-projects.md, ПР30)', () => {
    expect(newChatHref(task)).toBe(`/chats/new?project=${task}`)
    expect(newChatHref(null)).toBe('/chats/new')
  })

  it('reads the project of `?project=` only when it is an id (19.11.2026)', () => {
    expect(projectOfSearch(task)).toBe(task)
    expect(projectOfSearch(task.toUpperCase())).toBe(task.toUpperCase())
    expect(projectOfSearch(undefined)).toBeNull()
    expect(projectOfSearch([task, task])).toBeNull()
    expect(projectOfSearch('tea')).toBeNull()
    expect(projectOfSearch(`${task}x`)).toBeNull()
  })
})
