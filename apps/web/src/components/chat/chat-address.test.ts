import { describe, expect, it } from 'vitest'

import { chatFolderHref, chatHref, movedChatAddress, newChatHref } from './chat-address'

const project = '0199a3f2-5d1c-8b3e-9c41-2f6a8d0e4b17'
const task = '0199a3f2-5d1c-7b3e-9c41-2f6a8d0e4b18'

describe('the addresses of chats', () => {
  it('names a chat, a new chat and the folder of a project', () => {
    expect(chatHref(task)).toBe(`/chats/${task}`)
    expect(newChatHref()).toBe('/chats/new')
    expect(newChatHref(null)).toBe('/chats/new')
    expect(newChatHref(project)).toBe(`/chats/new?project=${project}`)
    expect(chatFolderHref(project)).toBe(`/chats?folder=${project}`)
  })

  it('moves the old addresses of the chat of a project', () => {
    expect(movedChatAddress(project, [])).toBe('/chats')
    expect(movedChatAddress(project, ['new'])).toBe(`/chats/new?project=${project}`)
    expect(movedChatAddress(project, [task])).toBe(`/chats/${task}`)
    expect(movedChatAddress(project, [task.toUpperCase()])).toBe(`/chats/${task.toUpperCase()}`)
  })

  it.each([[['nothing']], [[task, 'more']], [['new', 'more']], [['']]])(
    'leads nowhere from %j',
    (rest) => {
      expect(movedChatAddress(project, rest)).toBeNull()
    },
  )
})
