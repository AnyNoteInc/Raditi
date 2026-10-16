// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react'
import { renderToString } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SiteShell } from './site-shell'

const id = '0199a3f2-5d1c-7b3e-9c41-2f6a8d0e4b17'
const mocks = vi.hoisted(() => ({ pathname: '' }))

vi.mock('next/navigation', () => ({ usePathname: () => mocks.pathname }))
vi.mock('@/app/(protected)/app/actions', () => ({ signOut: vi.fn() }))
vi.mock('@/lib/hard-navigate', () => ({ hardNavigate: vi.fn() }))

const user = { name: 'Анна', lastName: 'Петрова', email: 'anna@example.ru' }
const site = { id, name: 'Кофейня «Крошка»', url: 'https://kroshka.example', status: 'active' }

function showShell(section = 'chat', status = 'active') {
  mocks.pathname = `/projects/${id}/${section}`
  render(
    <SiteShell user={user} site={{ ...site, status }}>
      <h1>Содержимое раздела</h1>
    </SiteShell>,
  )
}

/** The rail and the phone bar are both in the markup; styles show one of them. */
const navigation = (index: number) =>
  screen.getAllByRole('navigation', { name: 'Разделы сайта' })[index]!
const rail = () => navigation(0)
const bar = () => navigation(1)

afterEach(() => vi.restoreAllMocks())

describe('site shell', () => {
  it('lists the six sections in the rail, each leading to its own address', () => {
    showShell()
    const links = within(rail()).getAllByRole('link')
    expect(links.map((link) => link.textContent)).toEqual([
      'Чат',
      'Обзор',
      'Изменения',
      'Запуски',
      'База и бэкап',
      'Настройки',
    ])
    expect(links.map((link) => link.getAttribute('href'))).toEqual(
      // «Чат» opens on a new dialog, the rest on themselves.
      ['chat/new', 'overview', 'changes', 'runs', 'database', 'settings'].map(
        (s) => `/projects/${id}/${s}`,
      ),
    )
  })

  it('marks the open section in both navigations and nothing else', () => {
    showShell('changes')
    for (const nav of [rail(), bar()]) {
      const current = within(nav)
        .getAllByRole('link')
        .filter((link) => link.getAttribute('aria-current'))
      expect(current.map((link) => link.textContent)).toEqual(['Изменения'])
    }
  })

  it('leads back to the projects from the breadcrumbs and names the site', () => {
    showShell()
    const crumbs = screen.getByRole('navigation', { name: 'Хлебные крошки' })
    expect(within(crumbs).getByRole('link', { name: 'Проекты' }).getAttribute('href')).toBe(
      '/projects',
    )
    expect(within(crumbs).getByText(site.name).getAttribute('aria-current')).toBe('page')
  })

  it('opens the site itself in a new tab without handing it the opener', () => {
    showShell()
    const open = screen.getByRole('link', { name: `Открыть сайт ${site.name} в новой вкладке` })
    expect(open.getAttribute('href')).toBe(site.url)
    expect(open.getAttribute('target')).toBe('_blank')
    expect(open.getAttribute('rel')).toContain('noopener')
  })

  it('keeps four sections and «Ещё» on the phone bar and the rest behind «Ещё»', () => {
    showShell('settings')
    expect(
      within(bar())
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Чат', 'Обзор', 'Изменения', 'Запуски'])
    fireEvent.click(within(bar()).getByRole('button', { name: 'Ещё' }))
    const more = screen.getByRole('navigation', { name: 'Ещё разделы' })
    expect(
      within(more)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['База и бэкап', 'Настройки', 'К проектам'])
    expect(within(more).getByRole('link', { name: 'Настройки' }).getAttribute('aria-current')).toBe(
      'page',
    )
  })

  it('takes the first character of the name whole for the mark of the site', () => {
    mocks.pathname = `/projects/${id}/chat`
    render(
      <SiteShell user={user} site={{ ...site, name: '🍰 Крошка' }}>
        <p>Содержимое</p>
      </SiteShell>,
    )
    expect(screen.getByRole('img', { name: 'Сайт 🍰 Крошка' }).textContent).toBe('🍰')
  })

  describe.each([
    ['paused', 'Пока работа приостановлена, остальные разделы сайта недоступны.'],
    ['disconnected', 'Пока связи с сайтом нет, остальные разделы сайта недоступны.'],
    ['archived', 'Пока сайт в архиве, остальные разделы сайта недоступны.'],
  ])('of a %s site', (status, note) => {
    const closedLabels = (scope: HTMLElement) =>
      Array.from(scope.querySelectorAll('[aria-disabled="true"]')).map((item) => item.textContent)
    // The text a screen reader gets: the state follows the label, since the span has no role.
    const announced = (labels: readonly string[]) =>
      labels.map((label) => `${label}, раздел недоступен`)

    it('keeps «Обзор» the only link of the rail and of the phone bar', () => {
      showShell('overview', status)
      for (const [nav, closed] of [
        [rail(), ['Чат', 'Изменения', 'Запуски', 'База и бэкап', 'Настройки']],
        [bar(), ['Чат', 'Изменения', 'Запуски']],
      ] as const) {
        const links = within(nav).getAllByRole('link')
        expect(links.map((link) => link.textContent)).toEqual(['Обзор'])
        expect(links[0]!.getAttribute('href')).toBe(`/projects/${id}/overview`)
        expect(links[0]!.getAttribute('aria-current')).toBe('page')
        expect(closedLabels(nav)).toEqual(announced(closed))
      }
    })

    it('shows a closed section as an item that cannot be followed and says why', () => {
      showShell('overview', status)
      for (const item of rail().querySelectorAll('[aria-disabled="true"]')) {
        expect(item.tagName).toBe('SPAN')
        expect(item.hasAttribute('href')).toBe(false)
        expect(item.hasAttribute('tabindex')).toBe(false)
        expect(item.hasAttribute('aria-current')).toBe(false)
        // The lock beside the icon of the section: the colour alone says nothing.
        expect(item.querySelectorAll('svg')).toHaveLength(2)
        const described = document.getElementById(item.getAttribute('aria-describedby')!)
        expect(described?.textContent).toBe(note)
      }
    })

    it('keeps «Ещё» open for the way back to the projects, its sections closed', () => {
      showShell('overview', status)
      const more = within(bar()).getByRole('button', { name: 'Ещё' })
      fireEvent.click(more)
      const sheet = screen.getByRole('navigation', { name: 'Ещё разделы' })
      const links = within(sheet).getAllByRole('link')
      expect(links.map((link) => link.textContent)).toEqual(['К проектам'])
      expect(links[0]!.getAttribute('href')).toBe('/projects')
      expect(closedLabels(sheet)).toEqual(announced(['База и бэкап', 'Настройки']))
      for (const item of sheet.querySelectorAll('[aria-disabled="true"]')) {
        expect(item.querySelectorAll('svg')).toHaveLength(2)
        expect(document.getElementById(item.getAttribute('aria-describedby')!)?.textContent).toBe(
          note,
        )
      }
    })

    it('renders the same on the server: one link among the sections of the rail', () => {
      mocks.pathname = `/projects/${id}/overview`
      const page = document.createElement('div')
      page.innerHTML = renderToString(
        <SiteShell user={user} site={{ ...site, status }}>
          <h1>Обзор</h1>
        </SiteShell>,
      )
      const railMarkup = page.querySelector('nav[aria-label="Разделы сайта"]')!
      const links = Array.from(railMarkup.querySelectorAll('a'))
      expect(links.map((link) => link.textContent)).toEqual(['Обзор'])
      expect(links[0]!.getAttribute('aria-current')).toBe('page')
      const closed = Array.from(railMarkup.querySelectorAll('[aria-disabled="true"]'))
      expect(closed).toHaveLength(5)
      expect(closed[0]!.textContent).toBe('Чат, раздел недоступен')
      expect(page.querySelector('#site-closed-sections')?.textContent).toBe(note)
    })
  })

  it.each(['onboarding', 'active', 'something-new'])('closes nothing of a %s site', (status) => {
    showShell('overview', status)
    expect(within(rail()).getAllByRole('link')).toHaveLength(6)
    expect(document.body.textContent).not.toContain('недоступ')
    expect(document.querySelector('[aria-disabled="true"]')).toBeNull()
    expect(document.getElementById('site-closed-sections')).toBeNull()
  })

  it('puts the skip link first and points it at the content', () => {
    showShell()
    const skip = screen.getAllByRole('link')[0]!
    expect(skip.textContent).toBe('Перейти к содержимому')
    expect(skip.getAttribute('href')).toBe('#site-content')
    expect(screen.getByRole('main').id).toBe('site-content')
  })
})
