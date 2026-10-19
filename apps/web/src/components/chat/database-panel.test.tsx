// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { plain } from '@/components/billing/testing'

import type { CandidateView } from './chat-types'
import { DatabasePanel } from './database-panel'
import { CANDIDATE_ID, databaseView, TASK_ID } from './testing'

const candidate = (patch: Partial<CandidateView> = {}): CandidateView => ({
  id: CANDIDATE_ID,
  taskId: TASK_ID,
  revision: 1,
  status: 'current',
  turnNo: 1,
  createdAt: new Date('2026-10-18T09:00:00Z'),
  baseVersion: 'v1.3.2',
  files: [],
  media: [],
  database: [],
  databaseView: null,
  databaseReview: false,
  checks: [],
  proposal: { base: 'v1.3.2', version: 'v1.4.0', bump: 'minor', choices: [] },
  runtime: null,
  ...patch,
})

describe('the database panel', () => {
  it('shows every change with its values: the table, the setting, the new page, the text', () => {
    render(<DatabasePanel candidate={candidate({ databaseView, databaseReview: true })} />)
    const cards = screen
      .getAllByRole('listitem')
      .filter((item) => item.parentElement?.tagName === 'OL')
    expect(cards).toHaveLength(4)
    const [table, setting, page, text] = cards.map((card) => plain(card.textContent))
    expect(table).toContain('Новая таблица в базе данных сайта «bookings»')
    expect(table).toContain('name — строка до 120 знаков, по умолчанию: ')
    expect(table).toContain('starts_at — дата и время, может быть пустым')
    expect(table).toContain('Быстрый поиск по полям: starts_at')
    expect(setting).toBe(
      'Описание сайта: было «Цветы у дома», станет «Цветы у дома — доставка за час»',
    )
    expect(page).toContain('Новая страница «Цены» по адресу /prices/')
    expect(page).toContain('Сохранится черновиком: опубликовать её можно в админке сайта.')
    expect(page).toContain('Текст: Букет от 500 ₽')
    expect(page).toContain('Ссылки в тексте: /contacts/')
    expect(text).toContain('Страница «Контакты и реквизиты»: изменятся заголовок, описание и текст')
    expect(text).toContain('Заголовок: было «Контакты», станет «Контакты и реквизиты»')
    // A link put around words that stay is said with its address.
    expect(text).toContain('Описание: изменилось только оформление')
    expect(text).toContain('Новые ссылки: https://map.example.ru/shop')
    // Added and removed words are marked by an element and a word, not by colour alone.
    expect(plain(within(cards[3]!).getByText('на почту').closest('ins')?.textContent)).toBe(
      'Добавлено: на почту',
    )
    expect(plain(within(cards[3]!).getByText('через форму').closest('del')?.textContent)).toBe(
      'Удалено: через форму',
    )
    expect(text).toContain('Новые ссылки: mailto:shop@example.ru')
    expect(text).toContain('Показано не всё изменение. Полностью его видно в предпросмотре.')
    // A plan with a new page and a table says what a failed release leaves.
    expect(plain(document.body.textContent)).toContain(
      'Новые таблицы и поля останутся в базе данных',
    )
  })

  it('says a card refused and a description that does not fit, and why they cannot be released', () => {
    render(
      <DatabasePanel
        candidate={candidate({
          databaseView: {
            ...databaseView,
            operations: [
              {
                kind: 'option_update',
                index: 0,
                objectRef: 'option:blogname',
                refused: 'client_variable',
              },
            ],
          },
        })}
      />,
    )
    expect(plain(document.body.textContent)).toContain(
      'В этом изменении есть значение переменной окружения сайта.',
    )
  })

  it('names a plan without its values and a plan without changes', () => {
    const { unmount } = render(
      <DatabasePanel
        candidate={candidate({
          database: [
            {
              objectType: 'page',
              objectId: '42',
              fields: ['title'],
              text: 'Страница 42: изменится заголовок',
            },
          ],
        })}
      />,
    )
    expect(plain(screen.getByRole('note').textContent)).toContain(
      'Значения этих изменений сейчас не показать',
    )
    expect(screen.getByText('Страница 42: изменится заголовок')).toBeTruthy()
    unmount()
    render(<DatabasePanel candidate={candidate()} />)
    expect(screen.getByText('База данных сайта не изменится.')).toBeTruthy()
  })

  it('shows nothing of a description too large to show', () => {
    render(
      <DatabasePanel
        candidate={candidate({
          databaseView: { ...databaseView, operations: [], oversize: true },
        })}
      />,
    )
    expect(plain(screen.getByRole('note').textContent)).toContain('слишком много')
  })
})
