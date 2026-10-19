// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react'
import { renderToString } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApplicationShell } from './application-shell'

vi.mock('@/app/(protected)/app/actions', () => ({ signOut: vi.fn() }))
vi.mock('@/lib/hard-navigate', () => ({ hardNavigate: vi.fn() }))

const user = { name: 'Анна', lastName: 'Иванова', email: 'anna@example.ru' }

function shell() {
  return (
    <ApplicationShell user={user}>
      <h1>Содержимое раздела</h1>
    </ApplicationShell>
  )
}

afterEach(() => vi.restoreAllMocks())

describe('application shell', () => {
  it('marks «Проекты» as the current page of the rail', () => {
    render(shell())

    const links = within(
      screen.getByRole('navigation', { name: 'Основная навигация' }),
    ).getAllByRole('link')
    expect(links).toHaveLength(1)
    expect(links[0]).toHaveAccessibleName('Проекты')
    expect(links[0]).toHaveAttribute('href', '/projects')
    expect(links[0]).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: 'Радити — главная страница' })).toHaveAttribute(
      'href',
      '/',
    )
  })

  it('names the page in the breadcrumbs without a link to itself', () => {
    render(shell())

    const bar = screen.getByRole('banner', { name: 'Панель приложения' })
    const crumbs = within(bar).getByRole('navigation', { name: 'Хлебные крошки' })
    expect(within(crumbs).getByText('Проекты')).toHaveAttribute('aria-current', 'page')
    expect(within(crumbs).queryByRole('link')).not.toBeInTheDocument()
  })

  it('leads back to the list from a page below it', () => {
    render(
      <ApplicationShell
        user={user}
        crumbs={[{ label: 'Проекты', href: '/projects' }, { label: 'Новый проект' }]}
      >
        <h1>Новый проект</h1>
      </ApplicationShell>,
    )

    const crumbs = screen.getByRole('navigation', { name: 'Хлебные крошки' })
    expect(within(crumbs).getByRole('link', { name: 'Проекты' })).toHaveAttribute(
      'href',
      '/projects',
    )
    expect(within(crumbs).getByText('Новый проект')).toHaveAttribute('aria-current', 'page')
  })

  it('puts the skip link first and points it at the content', () => {
    render(shell())

    const skip = screen.getAllByRole('link')[0]!
    expect(skip).toHaveTextContent('Перейти к содержимому')
    expect(skip).toHaveAttribute('href', '#application-content')
    const main = screen.getByRole('main')
    expect(main).toHaveAttribute('id', 'application-content')
    expect(within(main).getByRole('heading', { name: 'Содержимое раздела' })).toBeInTheDocument()
  })

  it('keeps the account menu in the sidebar', () => {
    render(shell())

    const sidebar = screen.getByRole('complementary', { name: 'Боковая панель' })
    expect(within(sidebar).getAllByRole('button')).toHaveLength(1)
  })

  it('renders the same structure on the server', () => {
    const page = document.createElement('div')
    page.innerHTML = renderToString(shell())

    expect(page.querySelector('a')).toHaveAttribute('href', '#application-content')
    expect(page.querySelector('main')).toHaveAttribute('id', 'application-content')
    expect(page.querySelector('nav[aria-label="Основная навигация"] a')).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(page.querySelector('header [aria-current="page"]')).toHaveTextContent('Проекты')
  })
})
