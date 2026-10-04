// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SETTINGS_SIDEBAR_COOKIE, type SettingsSidebarState } from '@/lib/settings-sidebar'

import type * as SettingsNav from './settings-nav'
import { SettingsShell } from './settings-shell'

const mocks = vi.hoisted(() => ({ pathname: '/settings' }))

vi.mock('next/navigation', () => ({ usePathname: () => mocks.pathname }))
vi.mock('@/app/(protected)/app/actions', () => ({ signOut: vi.fn() }))
vi.mock('@/lib/hard-navigate', () => ({ hardNavigate: vi.fn() }))
// The shell is pinned on a list of its own: which sections are switched on changes with the
// product, and settings-nav.test.ts follows that.
vi.mock('./settings-nav', async (importOriginal) => ({
  ...(await importOriginal<typeof SettingsNav>()),
  settingsNav: [
    { href: '/settings', label: 'Общее', icon: 'settings', enabled: true },
    { href: '/settings/plans', label: 'Тарифы', icon: 'plans', enabled: true },
    { href: '/settings/billing', label: 'Оплата', icon: 'payment', enabled: false },
  ],
}))

const user = { name: 'Анна', lastName: 'Иванова', email: 'anna@example.ru' }

function shell(sidebar: SettingsSidebarState = 'expanded') {
  return (
    <SettingsShell user={user} sidebar={sidebar}>
      <h1>Содержимое раздела</h1>
    </SettingsShell>
  )
}

function showShell(pathname = '/settings') {
  mocks.pathname = pathname
  render(shell())
}

/** What an earlier visit left behind: on the client the cookie is the state. */
function rememberSidebar(state: SettingsSidebarState) {
  document.cookie = `${SETTINGS_SIDEBAR_COOKIE}=${state}; Path=/`
}

const sections = () => screen.getByRole('navigation', { name: 'Разделы настроек' })

beforeEach(() => {
  mocks.pathname = '/settings'
})

afterEach(() => {
  document.cookie = `${SETTINGS_SIDEBAR_COOKIE}=; Path=/; Max-Age=0`
  vi.restoreAllMocks()
})

describe('settings shell navigation', () => {
  it('lists the way back to the projects and the sections that are switched on', () => {
    showShell()

    const links = within(sections()).getAllByRole('link')
    expect(links.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['К проектам', '/projects'],
      ['Общее', '/settings'],
      ['Тарифы', '/settings/plans'],
    ])
    expect(screen.queryByRole('link', { name: 'Оплата' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Радити — главная страница' })).toHaveAttribute(
      'href',
      '/',
    )
  })

  it.each([
    ['/settings', 'Общее'],
    ['/settings/plans', 'Тарифы'],
    ['/settings/plans/compare', 'Тарифы'],
  ])('marks the section of %s as the current page', (pathname, label) => {
    showShell(pathname)

    const current = within(sections())
      .getAllByRole('link')
      .filter((link) => link.hasAttribute('aria-current'))
    expect(current).toHaveLength(1)
    expect(current[0]).toHaveAccessibleName(label)
    expect(current[0]).toHaveAttribute('aria-current', 'page')
  })

  it('names the section in the breadcrumbs after a link to the settings', () => {
    showShell('/settings/plans')

    const crumbs = screen.getByRole('navigation', { name: 'Хлебные крошки' })
    expect(within(crumbs).getByRole('link', { name: 'Настройки' })).toHaveAttribute(
      'href',
      '/settings',
    )
    expect(within(crumbs).getByText('Тарифы')).toHaveAttribute('aria-current', 'page')
  })

  it.each(['/settings/billing', '/settings/billing/return'])(
    'names a switched-off section in the breadcrumbs of %s and lights nothing in the sidebar',
    (pathname) => {
      showShell(pathname)

      for (const link of within(sections()).getAllByRole('link')) {
        expect(link).not.toHaveAttribute('aria-current')
      }
      expect(screen.queryByRole('link', { name: 'Оплата' })).not.toBeInTheDocument()
      const crumbs = screen.getByRole('navigation', { name: 'Хлебные крошки' })
      expect(within(crumbs).getByRole('link', { name: 'Настройки' })).toHaveAttribute(
        'href',
        '/settings',
      )
      expect(within(crumbs).getByText('Оплата')).toHaveAttribute('aria-current', 'page')
      expect(within(crumbs).getByText('Настройки')).not.toHaveAttribute('aria-current')
    },
  )
})

describe('settings shell sidebar', () => {
  it('starts expanded with the account block and collapses to a rail, writing the cookie', () => {
    showShell()
    const toggle = screen.getByRole('button', { name: 'Свернуть боковую панель' })

    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(document.getElementById(toggle.getAttribute('aria-controls') ?? '')).toBe(
      screen.getByRole('complementary', { name: 'Боковая панель' }),
    )
    expect(
      screen.getByRole('button', { name: 'Меню пользователя: Анна Иванова, anna@example.ru' }),
    ).toBeVisible()

    fireEvent.click(toggle)

    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(toggle).toHaveAccessibleName('Развернуть боковую панель')
    expect(screen.getByRole('button', { name: 'Меню пользователя в боковой панели' })).toBeVisible()
    expect(document.cookie).toContain(`${SETTINGS_SIDEBAR_COOKIE}=collapsed`)

    fireEvent.click(toggle)

    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(toggle).toHaveAccessibleName('Свернуть боковую панель')
    expect(
      screen.getByRole('button', { name: 'Меню пользователя: Анна Иванова, anna@example.ru' }),
    ).toBeVisible()
    expect(document.cookie).toContain(`${SETTINGS_SIDEBAR_COOKIE}=expanded`)
  })

  it('keeps the names of the icon-only links and the avatar menu in the rail', () => {
    rememberSidebar('collapsed')
    showShell()

    expect(screen.getByRole('button', { name: 'Развернуть боковую панель' })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    expect(screen.getByRole('link', { name: 'Радити — главная страница' })).toBeVisible()
    expect(screen.getByRole('link', { name: 'К проектам' })).toHaveAttribute('href', '/projects')
    expect(screen.getByRole('link', { name: 'Общее' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: 'Тарифы' })).toHaveAttribute('href', '/settings/plans')

    const account = screen.getByRole('button', { name: 'Меню пользователя в боковой панели' })
    expect(account).toHaveTextContent(/^АИ$/)
    fireEvent.click(account)
    expect(
      within(screen.getByRole('menu'))
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Проекты', 'Профиль', 'Настройки', 'Выход'])
  })

  it('restores the latest choice, not the one the layout was rendered with', () => {
    rememberSidebar('collapsed')
    mocks.pathname = '/settings'
    render(shell('expanded'))

    expect(screen.getByRole('button', { name: 'Развернуть боковую панель' })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
  })

  it.each(['expanded', 'collapsed'] as const)(
    'renders the %s state the server read from the cookie',
    (state) => {
      // A cookie the browser holds must not leak into the server markup that hydration expects.
      rememberSidebar(state === 'expanded' ? 'collapsed' : 'expanded')
      const page = document.createElement('div')
      page.innerHTML = renderToString(shell(state))

      const toggle = page.querySelector('button[aria-controls]')
      expect(toggle).toHaveAttribute('aria-expanded', String(state === 'expanded'))
      expect(toggle).toHaveAttribute(
        'aria-label',
        state === 'expanded' ? 'Свернуть боковую панель' : 'Развернуть боковую панель',
      )
      expect(page.querySelector('aside button')).toHaveAttribute(
        'aria-label',
        state === 'expanded'
          ? 'Меню пользователя: Анна Иванова, anna@example.ru'
          : 'Меню пользователя в боковой панели',
      )
    },
  )

  it('is a rail with the avatar menu on a narrow screen even when expanded', () => {
    vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
      matches: /max-width:\s*899/.test(query),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }))
    showShell()

    expect(screen.getByRole('button', { name: 'Меню пользователя в боковой панели' })).toBeVisible()
    expect(screen.getByRole('link', { name: 'Общее' })).toBeVisible()
    expect(screen.getByRole('link', { name: 'Тарифы' })).toBeVisible()
  })
})

describe('settings shell keyboard access', () => {
  it('starts with a skip link to the main area that holds the page', () => {
    showShell()

    const skip = screen.getByRole('link', { name: 'Перейти к содержимому' })
    const main = screen.getByRole('main')
    expect(skip).toHaveAttribute('href', `#${main.id}`)
    expect(main).toHaveAttribute('tabindex', '-1')
    expect(within(main).getByRole('heading', { name: 'Содержимое раздела' })).toBeVisible()
    expect(screen.getAllByRole('link')[0]).toBe(skip)
  })

  it('offers the toggle, the links and the account menu as native controls in page order', () => {
    showShell()

    const controls = [...document.querySelectorAll<HTMLElement>('a[href], button')]
    expect(
      controls.map((control) => control.getAttribute('aria-label') ?? control.textContent),
    ).toEqual([
      'Перейти к содержимому',
      'Радити — главная страница',
      'К проектам',
      'Общее',
      'Тарифы',
      'Меню пользователя: Анна Иванова, anna@example.ru',
      'Свернуть боковую панель',
      'Настройки',
    ])
    for (const control of controls) expect(control).not.toHaveAttribute('tabindex', '-1')
  })
})
