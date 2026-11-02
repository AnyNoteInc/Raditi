import { describe, expect, it } from 'vitest'

import { feedFailureKeptText, feedFailureOpenText } from './client-feed-labels.ts'
import type { FeedItem } from './client-feed.ts'
import { feedFileName, feedMarkdown } from './feed-markdown.ts'

const AUTHOR = '0199a3f2-0000-7000-8000-0000000000a1'
const REQUEST = '0199a3f2-0000-7000-8000-0000000000b1'
const at = '2026-10-31T09:05:00.000Z'
const person = { authorId: AUTHOR, requestId: REQUEST }

const row = (patch: Record<string, unknown>): FeedItem => ({ id: '1', at, ...patch }) as FeedItem

const first = row({ type: 'feed.request', kind: 'first', text: 'Сделайте блок отзывов', ...person })

const result = (patch: Record<string, unknown> = {}) =>
  row({
    type: 'feed.result',
    turn: 1,
    message: '## Готово\n\nБлок на главной.',
    site: 'unchanged',
    next: 'awaiting_user',
    filesChanged: null,
    changeType: null,
    needsApproval: false,
    risk: null,
    objects: undefined,
    ...patch,
  })

const out = (rows: readonly FeedItem[], withSite = true, title: string | null = 'Отзывы') =>
  feedMarkdown({ title, rows, withSite })

describe('the chat as a Markdown file', () => {
  it('opens with the name of the chat and keeps the rows in their order, with Moscow time', () => {
    const text = out([first, result()])
    expect(text.startsWith('# Отзывы\n\n---\n\n**Вы** · 31 октября 2026')).toBe(true)
    expect(text).toContain('12:05')
    expect(text.indexOf('Сделайте блок отзывов')).toBeLessThan(text.indexOf('## Готово'))
    expect(text.endsWith('\n')).toBe(true)
  })

  it('names a chat that has no name yet, on one line', () => {
    expect(out([], true, null)).toBe('# Чат\n')
    expect(out([], true, 'Два\nслова')).toBe('# Два слова\n')
  })

  it('leaves out what the screen leaves out', () => {
    const text = out([
      row({ type: 'feed.step', turn: 1, attempt: 1, step: 'work' }),
      row({ type: 'skipped' }),
    ])
    expect(text).toBe('# Отзывы\n')
  })

  it('writes the presses of the client by the words of the feed', () => {
    expect(
      out([row({ type: 'feed.request', kind: 'command', command: 'undo', ...person })]),
    ).toContain('_Вы попросили отменить выпуск_')
    expect(
      out([row({ type: 'feed.request', kind: 'command', command: null, ...person })]),
    ).toContain('_Вы продолжили задачу._')
  })

  it('says how many files a message carried', () => {
    const files = ['0199a3f2-0000-7000-8000-000000000e01', '0199a3f2-0000-7000-8000-000000000e02']
    expect(out([row({ ...first, attachments: files })])).toContain('Прикреплено файлов: 2')
    expect(out([first])).not.toContain('Прикреплено')
  })

  it('has no word of files where git has no change (К19), and counts them where it has', () => {
    expect(out([result({ filesChanged: 0, next: 'awaiting_approval' })])).not.toContain('файлов')
    expect(out([result({ filesChanged: 3, next: 'awaiting_approval' })])).toContain(
      'Изменено файлов: 3',
    )
  })

  it('speaks of no site in a chat without a project, and of the site in a chat with one', () => {
    const failure = row({
      type: 'feed.failure',
      turn: 1,
      code: 'site_held',
      site: 'none',
      credits: 'returned',
      next: 'awaiting_user',
    })
    expect(out([failure], false)).not.toMatch(/сайт/iu)
    expect(out([failure], false)).toContain('Подождите минуту, прежде чем писать дальше.')
    expect(out([failure], true)).toContain('При работе с сайтом произошёл сбой')
  })

  it('asks for the help of the client as the chat does, with a site or without one', () => {
    const login = row({
      type: 'feed.question',
      kind: 'browser',
      turn: 1,
      reason: 'login',
      message: 'Войдите, пожалуйста',
    })
    const plain = out([login], false)
    expect(plain).toContain('Нужно войти на сайт')
    expect(plain).toContain('вошли на сайт в браузере задачи')
    expect(plain).toContain('Войдите, пожалуйста')
    expect(out([login], true)).toContain('вошли в админку сайта')
  })

  describe('has words for every row of the feed', () => {
    const version = 'v1.4.0'
    const undoNames = {
      undoId: REQUEST,
      releaseId: REQUEST,
      undoneVersion: 'v1.4.0',
      version: 'v1.5.0',
    }
    const undoRow = (patch: Record<string, unknown>) =>
      row({ type: 'feed.undo', ...undoNames, ...patch })
    const cases: readonly [string, FeedItem, readonly string[]][] = [
      [
        'a retry',
        row({ type: 'feed.request', kind: 'retry', ...person }),
        ['_Вы попросили попробовать ещё раз_'],
      ],
      [
        'a press of «Продолжить»',
        row({ type: 'feed.request', kind: 'continue', ...person }),
        ['_Вы попросили продолжить работу_'],
      ],
      [
        'the agent taken back',
        row({ type: 'feed.request', kind: 'resume', ...person }),
        ['_Вы вернули управление агенту_'],
      ],
      [
        'a command the agent carried out',
        row({ type: 'feed.request', kind: 'agent_command', command: 'init', ...person }),
        ['_Вы попросили описать проект для агента_'],
      ],
      [
        'a request of a later kind, with its words',
        row({ type: 'feed.request', kind: 'other', text: 'Слова клиента', ...person }),
        ['**Вы**', 'Слова клиента'],
      ],
      [
        'a request of a later kind, without words',
        row({ type: 'feed.request', kind: 'other', text: null, ...person }),
        ['_Вы продолжили задачу._'],
      ],
      [
        'one question of the agent',
        row({
          type: 'feed.question',
          kind: 'agent',
          turn: 1,
          intro: 'Нужно уточнить.',
          questions: [{ text: 'Какой телефон?', options: [] }],
        }),
        ['Вопрос агента', 'Нужно уточнить.', 'Какой телефон?'],
      ],
      [
        'several questions of the agent',
        row({
          type: 'feed.question',
          kind: 'agent',
          turn: 1,
          intro: 'Нужно уточнить.',
          questions: [
            { text: 'Какой телефон?', options: [] },
            { text: 'Какой адрес?', options: [] },
          ],
        }),
        ['1. Какой телефон?\n2. Какой адрес?'],
      ],
      [
        'a question about credits',
        row({
          type: 'feed.question',
          kind: 'ceiling',
          turn: 1,
          reason: 'step',
          spent: 15,
          held: 20,
          left: 5,
        }),
        ['Нужен ваш ответ', 'Задача оказалась больше обычной', 'Продолжить?'],
      ],
      [
        'a result that waits for a release',
        result({ next: 'awaiting_approval', site: 'unchanged', filesChanged: 2 }),
        ['Что изменится', 'На сайте пока ничего не изменилось.', 'Изменено файлов: 2'],
      ],
      ['an answer that leaves the chat open', result(), ['Ответ агента', '## Готово']],
      [
        'a result that ended the task',
        result({ next: 'done', site: 'changed', filesChanged: 2 }),
        ['· Готово', 'Правка уже на сайте.', 'Изменено файлов: 2'],
      ],
      [
        'a cancellation',
        row({
          type: 'feed.cancelled',
          turn: 1,
          by: 'customer',
          site: 'unchanged',
          credits: 'returned',
        }),
        ['Отменено', 'Вы остановили задачу.', 'За этот запрос кредиты не списаны.'],
      ],
      [
        'a cancellation by the queue',
        row({
          type: 'feed.cancelled',
          turn: null,
          by: 'queue_timeout',
          site: 'unchanged',
          credits: 'returned',
        }),
        ['Не смогли взяться за задачу за сутки', 'Отправьте задачу снова, когда будет удобно.'],
      ],
      [
        'a failure that kept the changes',
        row({
          type: 'feed.failure',
          turn: 1,
          code: 'technical',
          site: 'unchanged',
          credits: 'returned',
          next: 'awaiting_approval',
        }),
        ['Не получилось', 'За этот запрос кредиты не списаны.', feedFailureKeptText],
      ],
      [
        'a failure that leaves the chat open',
        row({
          type: 'feed.failure',
          turn: 1,
          code: 'technical',
          site: 'unchanged',
          credits: 'returned',
          next: 'awaiting_user',
        }),
        [feedFailureOpenText],
      ],
      [
        'changes ready to release',
        row({
          type: 'feed.candidate',
          turn: 1,
          revision: 1,
          version,
          bump: 'minor',
          files: { added: 1, modified: 1, deleted: 1 },
          media: 2,
          records: 4,
        }),
        [
          'Изменения готовы',
          'Предлагаем выпустить как версию 1.4.0 (новые возможности).',
          '- Изменено файлов: 3',
          '- Добавится медиафайлов: 2',
          '- Изменится записей на сайте: 4',
        ],
      ],
      [
        'the decision to release',
        row({ type: 'feed.decision', kind: 'release', version, ...person }),
        ['_Вы решили выпустить версию 1.4.0._'],
      ],
      [
        'an installed release',
        row({
          type: 'feed.release',
          releaseId: REQUEST,
          version,
          outcome: 'installed',
          reason: null,
          credits: null,
        }),
        ['Версия установлена', 'Версия 1.4.0 установлена на сайт.'],
      ],
      [
        'a release that came back',
        row({
          type: 'feed.release',
          releaseId: REQUEST,
          version,
          outcome: 'rolled_back',
          reason: 'site_check',
          credits: null,
          kept: { records: 1, tables: 1 },
        }),
        [
          'После установки сайт не прошёл проверку.',
          'Новые таблицы и поля базы данных остались на сайте',
          'Страница или запись, которую добавил выпуск, осталась на сайте',
        ],
      ],
      [
        'the undo the client confirmed',
        undoRow({ stage: 'confirmed', ...person }),
        ['**Вы**', '_Вы решили отменить выпуск 1.4.0._'],
      ],
      [
        'an installed undo',
        undoRow({
          stage: 'installed',
          returnsTo: 'v1.3.0',
          reason: null,
          records: { returned: 2, kept: 1 },
        }),
        [
          'Выпуск отменён',
          'Сайт вернулся к версии 1.3.0; теперь на нём версия 1.5.0.',
          'Не вернули записей: 1',
        ],
      ],
      [
        'an undo that was refused',
        undoRow({
          stage: 'refused',
          returnsTo: 'v1.3.0',
          reason: 'undo_outdated',
          records: { returned: 0, kept: 0 },
        }),
        ['Отмена не начата', 'После этого выпуска на сайт установили другую версию.'],
      ],
      [
        'the answer to «Обновить»',
        row({ type: 'feed.update', outcome: 'emptied', conflicts: 0 }),
        [
          'Изменения уже на сайте',
          'Все изменения этого чата уже есть на сайте, выпускать их не нужно.',
        ],
      ],
      [
        'the row of `/undo`',
        row({ type: 'feed.rewind', turn: 2, files: false, site: 'elsewhere' }),
        ['Последний запрос отменён. То, что агент сделал на других сайтах, осталось.'],
      ],
      [
        'the row of `/redo`',
        row({ type: 'feed.redo', turn: 2, files: true, open: false }),
        ['Отменённый запрос и его файлы возвращены.'],
      ],
    ]

    it.each(cases)('%s', (_name, shown, words) => {
      const text = out([shown])
      for (const word of words) expect(text).toContain(word)
    })

    it('a result that ended the task counts no files when the chat stays open', () => {
      expect(out([result({ filesChanged: 2 })])).not.toContain('Изменено файлов')
    })

    it('an undo that ended no other way than installed leaves out what it kept', () => {
      const refused = undoRow({
        stage: 'failed',
        returnsTo: 'v1.3.0',
        reason: null,
        records: { returned: 0, kept: 3 },
      })
      expect(out([refused])).not.toContain('Не вернули записей')
    })
  })

  it('names the objects a browser left on the site, with their addresses', () => {
    const objects = [
      {
        kind: 'post',
        title: 'Новость',
        status: 'published',
        url: 'https://example.test/news',
      },
    ]
    expect(out([result({ site: 'changed', next: 'done', objects })])).toContain(
      '- Запись «Новость» — опубликовано: https://example.test/news',
    )
  })

  it('tells the rows it cannot read as the screen does', () => {
    expect(out([row({ type: 'newer' })])).toContain('Здесь появилось новое сообщение')
    expect(out([row({ type: 'unreadable' })])).toContain('Не удалось показать это сообщение')
  })

  it('stands in for a picture: the file holds words', () => {
    const shot = row({
      type: 'feed.screenshot',
      screenshotId: '0199a3f2-0000-7000-8000-000000000f01',
      number: 2,
      width: 800,
      height: 600,
    })
    expect(out([shot])).toContain('Снимок экрана № 2')
  })
})

describe('the name of the file', () => {
  it('is the name of the chat', () => {
    expect(feedFileName('Блок отзывов')).toBe('Блок отзывов.md')
  })

  it('takes out what file systems refuse, and never starts with a dot', () => {
    expect(feedFileName('цены: 1/2 "кофе"\n')).toBe('цены 1 2 кофе.md')
    expect(feedFileName('../../секрет')).toBe('секрет.md')
  })

  it('is «Чат» when nothing is left', () => {
    expect(feedFileName(null)).toBe('Чат.md')
    expect(feedFileName(' / ')).toBe('Чат.md')
  })

  it('stays short and whole: a pair of surrogates is not cut in two', () => {
    const name = feedFileName('😀'.repeat(200))
    expect(Array.from(name)).toHaveLength(83)
    expect(name.endsWith('😀.md')).toBe(true)
  })
})
