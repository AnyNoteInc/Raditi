import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import {
  composerText,
  dialogMenuText,
  dialogText,
  listText,
  releaseText,
  taskWayText,
  toolText,
} from './chat-texts'

describe('the words of the release window', () => {
  it('agrees the number of changes of a bulk plan with its noun', () => {
    expect(releaseText.reviewBulk(21)).toBe(
      'Это массовое изменение: 21 изменение базы данных. Посмотрите их все перед выпуском.',
    )
    expect(releaseText.reviewBulk(22)).toContain('22 изменения базы данных')
    expect(releaseText.reviewBulk(25)).toContain('25 изменений базы данных')
    expect(releaseText.reviewBulk(111)).toContain('111 изменений базы данных')
  })
})

describe('the word of a chat (docs/plan/61-chats-first.md, К25, К26)', () => {
  const source = readFileSync(new URL('./chat-texts.ts', import.meta.url), 'utf8')

  it('says «чат» everywhere, the labels first', () => {
    expect(source).not.toMatch(/диалог/i)
    expect(toolText.panel).toBe('Инструменты чата')
    expect(toolText.back).toBe('К чату')
    expect(composerText.finished).toBe('Чат завершён')
    expect(listText.untitled).toBe('Чат без названия')
    expect(dialogText.notFound).toBe('Такого чата нет')
    expect(dialogMenuText.name).toBe('Название чата')
  })

  // Everything the cabinet draws, from a title to a line in the body of a component.
  it('leaves no «диалог» in the code of the cabinet', () => {
    const root = new URL('../../', import.meta.url)
    const code = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter(
      (path) =>
        /\.tsx?$/.test(path) && !/\.(test|spec)\.tsx?$/.test(path) && !path.includes('testing'),
    )
    expect(code.length).toBeGreaterThan(100)
    expect(
      code.filter((path) => /диалог/i.test(readFileSync(new URL(path, root), 'utf8'))),
    ).toEqual([])
  })

  // A domain test reads no file (domain-tests-no-infrastructure), and these catalogues keep most
  // of their words in the bodies of functions, which no walk over their values reaches.
  it.each([
    '../../../../../packages/domain/src/tasks/client-feed-labels.ts',
    '../../../../../packages/domain/src/tasks/client-feed-failures.ts',
    '../../../../../packages/domain/src/release/chat-commands.ts',
  ])('leaves no «диалог» in %s', (path) => {
    expect(readFileSync(new URL(path, import.meta.url), 'utf8')).not.toMatch(/диалог/i)
  })

  it('says nothing of modes, nor how the agent works on a site', () => {
    expect(source).not.toMatch(/режим[а-яё]* «/i)
    expect(source).not.toMatch(/агент работает в админке|появляются на сайте сразу/i)
    for (const gone of ['chatOff', 'workOff', 'modes', 'otherMode', 'notConnected']) {
      expect(composerText).not.toHaveProperty(gone)
    }
    for (const gone of [
      'label',
      'browser',
      'repository',
      'browserNote',
      'repositoryNote',
      'browserOnly',
    ]) {
      expect(taskWayText).not.toHaveProperty(gone)
    }
  })
})
