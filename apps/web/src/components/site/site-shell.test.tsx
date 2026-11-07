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
// The credits read the server: here the ring is a mark of where it stands.
vi.mock('@/components/billing/credit-ring', () => ({
  CreditRing: ({ placement }: { placement: string }) => (
    <span data-testid={`credit-ring-${placement}`} />
  ),
}))

const user = { name: 'Анна', lastName: 'Петрова', email: 'anna@example.ru' }
const site = {
  id,
  name: 'Кофейня «Крошка»',
  url: 'https://kroshka.example',
  status: 'active',
  chat: { requirements: { repository: true, browser: false } },
}
const sections = ['Обзор', 'Изменения', 'Запуски', 'База', 'Переменные', 'Настройки']

function showShell(
  section = 'overview',
  status = 'active',
  setup?: 'pending' | 'failed' | 'done' | null,
) {
  mocks.pathname = `/projects/${id}/${section}`
  render(
    <SiteShell user={user} site={{ ...site, status, setup }}>
      <h1>Содержимое раздела</h1>
    </SiteShell>,
  )
}

/** The panel of the site beside the rail (docs/plan/64-cabinet-navigation.md, Н2). */
const panel = () => screen.getByRole('complementary', { name: 'Разделы сайта' })
const panelNav = () => within(panel()).getByRole('navigation', { name: 'Разделы сайта' })
/** The drawer of the sections of a phone, opened from the bar (Н7). */
function openPhoneMenu() {
  fireEvent.click(screen.getByRole('button', { name: /^Разделы сайта: / }))
  return within(screen.getByRole('dialog', { name: 'Разделы сайта' })).getByRole('navigation', {
    name: 'Разделы сайта',
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  document.cookie = 'raditi-panel=; Max-Age=0; Path=/'
})

describe('site shell', () => {
  it('lists the six sections in the panel, each leading to its own address', () => {
    showShell()
    const links = within(panelNav()).getAllByRole('link')
    expect(links.map((link) => link.textContent)).toEqual(sections)
    expect(links.map((link) => link.getAttribute('href'))).toEqual(
      ['overview', 'changes', 'runs', 'database', 'vault', 'settings'].map(
        (s) => `/projects/${id}/${s}`,
      ),
    )
  })

  it('marks the open section in the panel and in the menu of a phone, and nothing else', () => {
    showShell('changes')
    expect(screen.getByRole('button', { name: 'Разделы сайта: Изменения' })).toBeTruthy()
    // The panel first: the open drawer hides the rest of the page from a screen reader.
    for (const nav of [panelNav, openPhoneMenu]) {
      const current = within(nav())
        .getAllByRole('link')
        .filter((link) => link.getAttribute('aria-current'))
      expect(current.map((link) => link.textContent)).toEqual(['Изменения'])
    }
  })

  it('leads back to the projects from the breadcrumbs, names the site and the section', () => {
    showShell('database')
    const crumbs = screen.getByRole('navigation', { name: 'Хлебные крошки' })
    expect(within(crumbs).getByRole('link', { name: 'Проекты' }).getAttribute('href')).toBe(
      '/projects',
    )
    expect(within(crumbs).getByRole('link', { name: site.name }).getAttribute('href')).toBe(
      `/projects/${id}/overview`,
    )
    expect(within(crumbs).getByText('База').getAttribute('aria-current')).toBe('page')
  })

  it('holds the card of the site, the way to all projects, a new chat and the site itself', () => {
    showShell()
    const aside = panel()
    expect(within(aside).getByRole('link', { name: 'Все проекты' })).toHaveAttribute(
      'href',
      '/projects',
    )
    expect(within(aside).getByText('kroshka.example')).toBeTruthy()
    expect(within(aside).getByText('Подключён')).toBeTruthy()
    expect(within(aside).getByRole('link', { name: 'Чат в этом проекте' })).toHaveAttribute(
      'href',
      `/chats/new?project=${id}`,
    )
    const open = within(aside).getByRole('link', {
      name: `Открыть сайт ${site.name} в новой вкладке`,
    })
    expect(open.getAttribute('href')).toBe(site.url)
    expect(open.getAttribute('target')).toBe('_blank')
    expect(open.getAttribute('rel')).toContain('noopener')
  })

  it('offers no new chat of a project that takes none now', () => {
    mocks.pathname = `/projects/${id}/overview`
    render(
      <SiteShell user={user} site={{ ...site, chat: { requirements: null } }}>
        <p>Содержимое</p>
      </SiteShell>,
    )
    expect(screen.queryByRole('link', { name: 'Чат в этом проекте' })).toBeNull()
  })

  it('hides the panel with its button and brings it back from the bar (Н3)', () => {
    showShell()
    fireEvent.click(within(panel()).getByRole('button', { name: 'Скрыть панель' }))
    expect(document.cookie).toContain('raditi-panel=closed')
    const show = screen.getByRole('button', { name: 'Показать панель' })
    expect(show).toHaveAttribute('aria-keyshortcuts', ']')
    fireEvent.click(show)
    expect(document.cookie).toContain('raditi-panel=open')
    expect(within(panel()).getByRole('button', { name: 'Скрыть панель' })).toBeTruthy()
  })

  it('toggles the panel with «]» outside a field, and leaves a typed «]» to the field', () => {
    showShell()
    fireEvent.keyDown(window, { key: ']', code: 'BracketRight' })
    expect(document.cookie).toContain('raditi-panel=closed')
    // The same key of a Russian layout types «ъ».
    fireEvent.keyDown(window, { key: 'ъ', code: 'BracketRight' })
    expect(document.cookie).toContain('raditi-panel=open')

    const field = document.createElement('input')
    document.body.append(field)
    fireEvent.keyDown(field, { key: ']', code: 'BracketRight' })
    fireEvent.keyDown(window, { key: ']', code: 'BracketRight', metaKey: true })
    expect(document.cookie).toContain('raditi-panel=open')
    field.remove()
  })

  it('draws the page on the server as the cookie read there says', () => {
    mocks.pathname = `/projects/${id}/overview`
    const markup = (panelState: 'open' | 'closed') =>
      renderToString(
        <SiteShell user={user} site={site} panelState={panelState}>
          <h1>Обзор</h1>
        </SiteShell>,
      )
    expect(markup('closed')).toContain('aria-label="Показать панель"')
    expect(markup('closed')).not.toContain('aria-label="Скрыть панель"')
    expect(markup('open')).toContain('aria-label="Скрыть панель"')
  })

  it('takes the first character of the name whole for the mark of the site', () => {
    mocks.pathname = `/projects/${id}/overview`
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

    it('keeps «Обзор» the only link of the panel and of the menu of a phone', () => {
      showShell('overview', status)
      for (const open of [panelNav, openPhoneMenu]) {
        const nav = open()
        const links = within(nav).getAllByRole('link')
        expect(links.map((link) => link.textContent)).toEqual(['Обзор'])
        expect(links[0]!.getAttribute('href')).toBe(`/projects/${id}/overview`)
        expect(links[0]!.getAttribute('aria-current')).toBe('page')
        expect(closedLabels(nav)).toEqual(announced(sections.slice(1)))
      }
    })

    it('shows a closed section as an item that cannot be followed and says why', () => {
      showShell('overview', status)
      for (const item of panelNav().querySelectorAll('[aria-disabled="true"]')) {
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

    it('renders the same on the server: one link among the sections of the panel', () => {
      mocks.pathname = `/projects/${id}/overview`
      const page = document.createElement('div')
      page.innerHTML = renderToString(
        <SiteShell user={user} site={{ ...site, status }}>
          <h1>Обзор</h1>
        </SiteShell>,
      )
      const markup = page.querySelector('nav[aria-label="Разделы сайта"]')!
      const links = Array.from(markup.querySelectorAll('a'))
      expect(links.map((link) => link.textContent)).toEqual(['Обзор'])
      expect(links[0]!.getAttribute('aria-current')).toBe('page')
      const closed = Array.from(markup.querySelectorAll('[aria-disabled="true"]'))
      expect(closed).toHaveLength(5)
      expect(closed[0]!.textContent).toBe('Изменения, раздел недоступен')
      expect(page.querySelector('#site-closed-sections')?.textContent).toBe(note)
    })
  })

  it.each(['onboarding', 'active', 'something-new'])('closes nothing of a %s site', (status) => {
    showShell('overview', status)
    expect(within(panelNav()).getAllByRole('link')).toHaveLength(6)
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

  describe.each(['pending', 'failed'] as const)('of a site whose setup is %s', (setup) => {
    it('shows no panel and no sections: the rail of the cabinet stays', () => {
      showShell('overview', 'onboarding', setup)
      expect(screen.queryByRole('navigation', { name: 'Разделы сайта' })).not.toBeInTheDocument()
      expect(screen.queryByRole('complementary', { name: 'Разделы сайта' })).toBeNull()
      expect(screen.queryByRole('button', { name: /^Разделы сайта/ })).toBeNull()
      expect(screen.queryByRole('img', { name: `Сайт ${site.name}` })).not.toBeInTheDocument()
      for (const label of ['Изменения', 'Запуски', 'Настройки']) {
        expect(screen.queryByText(label)).not.toBeInTheDocument()
      }
      expect(screen.getByRole('navigation', { name: 'Основная навигация' })).toBeTruthy()
    })

    it('keeps the way back to the projects, the site and the content', () => {
      showShell('overview', 'onboarding', setup)
      const crumbs = screen.getByRole('navigation', { name: 'Хлебные крошки' })
      expect(within(crumbs).getByRole('link', { name: 'Проекты' })).toHaveAttribute(
        'href',
        '/projects',
      )
      expect(within(crumbs).getByText(site.name)).toHaveAttribute('aria-current', 'page')
      expect(
        screen.getByRole('link', { name: `Открыть сайт ${site.name} в новой вкладке` }),
      ).toBeInTheDocument()
      expect(screen.getByRole('main')).toHaveTextContent('Содержимое раздела')
      expect(screen.getAllByRole('link')[0]).toHaveTextContent('Перейти к содержимому')
    })
  })

  it.each(['done', null] as const)('shows the sections of a site whose setup is %s', (setup) => {
    showShell('overview', 'onboarding', setup)
    expect(within(panelNav()).getAllByRole('link')).toHaveLength(6)
  })
})
