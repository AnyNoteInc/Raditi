// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CABINET_PANEL_COOKIE } from '@/lib/cabinet-panel'

import type * as SettingsNav from './settings-nav'
import { SettingsShell } from './settings-shell'

const mocks = vi.hoisted(() => ({ pathname: '/settings' }))

vi.mock('next/navigation', () => ({ usePathname: () => mocks.pathname }))
vi.mock('@/app/(protected)/app/actions', () => ({ signOut: vi.fn() }))
vi.mock('@/lib/hard-navigate', () => ({ hardNavigate: vi.fn() }))
// The credits of the rail read the server: here they are left out.
vi.mock('@/components/billing/credit-ring', () => ({ CreditRing: () => null }))
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

function shell() {
  return (
    <SettingsShell user={user}>
      <h1>Содержимое раздела</h1>
    </SettingsShell>
  )
}

function showShell(pathname = '/settings') {
  mocks.pathname = pathname
  render(shell())
}

const sections = () => screen.getByRole('navigation', { name: 'Разделы настроек' })

beforeEach(() => {
  mocks.pathname = '/settings'
})

afterEach(() => {
  document.cookie = `${CABINET_PANEL_COOKIE}=; Path=/; Max-Age=0`
  vi.restoreAllMocks()
})

describe('settings shell navigation', () => {
  it('lists the sections that are switched on; the rail of the cabinet leads to the chats', () => {
    showShell()

    const links = within(sections()).getAllByRole('link')
    expect(links.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['Общее', '/settings'],
      ['Тарифы', '/settings/plans'],
    ])
    expect(screen.queryByRole('link', { name: 'Оплата' })).not.toBeInTheDocument()
    const rail = screen.getByRole('navigation', { name: 'Основная навигация' })
    expect(within(rail).getByRole('link', { name: 'Чаты' })).toHaveAttribute('href', '/chats')
    expect(screen.getByRole('link', { name: 'Радити — главная страница' })).toHaveAttribute(
      'href',
      '/chats',
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
    'names a switched-off section in the breadcrumbs of %s and lights nothing in the panel',
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

describe('settings shell panel', () => {
  it('hides the panel with «Скрыть панель» and brings it back from the bar, writing the cookie', () => {
    showShell()

    const panel = screen.getByRole('complementary', { name: 'Настройки' })
    fireEvent.click(within(panel).getByRole('button', { name: 'Скрыть панель' }))
    expect(document.cookie).toContain(`${CABINET_PANEL_COOKIE}=closed`)
    // The panel stays in the page, hidden by its styles: only the button that hides it goes.
    expect(within(panel).queryByRole('button', { name: 'Скрыть панель' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Показать панель' }))
    expect(document.cookie).toContain(`${CABINET_PANEL_COOKIE}=open`)
    expect(sections()).toBeTruthy()
  })

  it('draws the panel hidden on the server when the cookie read there says so', () => {
    mocks.pathname = '/settings/plans'
    const markup = renderToString(
      <SettingsShell user={user} panelState="closed">
        <h1>Тарифы</h1>
      </SettingsShell>,
    )
    expect(markup).toContain('aria-label="Показать панель"')
    expect(markup).not.toContain('aria-label="Скрыть панель"')
  })

  it('opens the sections from the bar on a phone', () => {
    showShell('/settings/plans')

    fireEvent.click(screen.getByRole('button', { name: 'Разделы настроек: Тарифы' }))
    const drawer = screen.getByRole('dialog', { name: 'Разделы настроек' })
    const current = within(drawer).getByRole('link', { current: 'page' })
    expect(current).toHaveTextContent('Тарифы')
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

  it('offers the rail, the panel and the bar as native controls in page order', () => {
    showShell()

    const controls = [...document.querySelectorAll<HTMLElement>('a[href], button')]
    expect(
      controls.map((control) => control.getAttribute('aria-label') ?? control.textContent),
    ).toEqual([
      'Перейти к содержимому',
      'Радити — главная страница',
      'Чаты',
      'Страницы',
      'Проекты',
      'Меню пользователя в боковой панели',
      'Скрыть панель',
      'Общее',
      'Тарифы',
      'Разделы настроек: Общее',
      'Настройки',
    ])
    for (const control of controls) expect(control).not.toHaveAttribute('tabindex', '-1')
  })
})
