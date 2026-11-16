import { describe, expect, it } from 'vitest'

import { projectHref, projectsText, projectUpdatedText } from './project-texts'

describe('the words of «Проекты» (docs/plan/84-projects.md, §4.8)', () => {
  const now = new Date('2026-11-15T12:00:00Z')
  const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000)

  it('says when a project changed, as the card of the board does', () => {
    expect(projectUpdatedText(ago(0), now)).toBe('обновлён только что')
    expect(projectUpdatedText(ago(12), now)).toBe('обновлён 12 мин назад')
    expect(projectUpdatedText(ago(60), now)).toBe('обновлён 1 ч назад')
    expect(projectUpdatedText(ago(24 * 60), now)).toBe('обновлён вчера')
    expect(projectUpdatedText(ago(3 * 24 * 60), now)).toBe('обновлён 3 дня назад')
    expect(projectUpdatedText(ago(5 * 24 * 60), now)).toBe('обновлён 5 дней назад')
    expect(projectUpdatedText(new Date('2026-11-02T09:00:00Z'), now)).toBe('обновлён 2\u00a0ноября')
  })

  it('counts the chats of a project in words', () => {
    expect(projectsText.chats(1)).toBe('1 чат')
    expect(projectsText.chats(4)).toBe('4 чата')
    expect(projectsText.chats(12)).toBe('12 чатов')
  })

  it('names the page of a project', () => {
    expect(projectHref('abc')).toBe('/projects/abc')
  })
})
