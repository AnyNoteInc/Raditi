// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { UserMenu } from './user-menu'

vi.mock('@/app/(protected)/app/actions', () => ({ signOut: vi.fn() }))
vi.mock('@/lib/hard-navigate', () => ({ hardNavigate: vi.fn() }))
vi.mock('@/components/billing/plans-dialog', () => ({
  PLANS_PAGE: '/settings/plans',
  PlansDialog: ({ open }: { open: boolean }) =>
    open ? <div role="dialog" aria-label="Тарифы" /> : null,
}))

const ITEMS = ['Профиль', 'Настройки', 'Использование', 'Посмотреть тарифы', 'Выход']
const AVATAR =
  '/api/profile/avatar/0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b/0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5c.webp'

describe('shared account menu', () => {
  it.each(['toolbar', 'sidebar'] as const)(
    'offers profile, settings, usage, tariffs and sign-out from the %s avatar',
    (placement) => {
      render(
        <UserMenu
          placement={placement}
          user={{ name: 'Анна', lastName: 'Иванова', email: 'anna@example.ru' }}
        />,
      )
      const trigger = screen.getByRole('button', {
        name: placement === 'sidebar' ? 'Меню пользователя в боковой панели' : 'Меню пользователя',
      })

      expect(trigger).toHaveTextContent(/^АИ$/)
      expect(trigger.querySelector('svg')).toBeNull()
      expect(trigger).toHaveAttribute('aria-expanded', 'false')
      fireEvent.click(trigger)

      expect(trigger).toHaveAttribute('aria-expanded', 'true')
      const menu = screen.getByRole('menu')
      expect(within(menu).getByText('Анна Иванова')).toBeVisible()
      expect(within(menu).getByText('anna@example.ru')).toBeVisible()
      const items = within(menu).getAllByRole('menuitem')
      expect(items.map((item) => item.textContent)).toEqual(ITEMS)
      expect(items.map((item) => item.getAttribute('href'))).toEqual([
        '/profile',
        '/settings',
        '/settings/usage',
        null,
        null,
      ])
      // Three groups: the account, the tariffs, the sign-out.
      expect(menu.querySelectorAll('hr')).toHaveLength(3)

      fireEvent.click(items[3]!)
      expect(screen.getByRole('dialog', { name: 'Тарифы' })).toBeInTheDocument()
    },
  )

  it('shows the name and the address in an expanded sidebar and opens the same menu', () => {
    render(
      <UserMenu
        placement="panel"
        user={{ name: 'Анна', lastName: 'Иванова', email: 'anna@example.ru' }}
      />,
    )
    // The accessible name carries the visible text of the block (WCAG 2.5.3).
    const trigger = screen.getByRole('button', {
      name: 'Меню пользователя: Анна Иванова, anna@example.ru',
    })

    expect(within(trigger).getByText('АИ')).toBeVisible()
    expect(within(trigger).getByText('Анна Иванова')).toBeVisible()
    expect(within(trigger).getByText('anna@example.ru')).toBeVisible()
    expect(trigger.querySelector('svg')).not.toBeNull()
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(trigger)

    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    const items = within(screen.getByRole('menu')).getAllByRole('menuitem')
    expect(items.map((item) => item.textContent)).toEqual(ITEMS)
  })

  it('names an account without a name in the sidebar block', () => {
    render(<UserMenu placement="panel" user={{ name: ' ', email: 'anna@example.ru' }} />)

    const trigger = screen.getByRole('button', {
      name: 'Меню пользователя: Мой аккаунт, anna@example.ru',
    })
    expect(within(trigger).getByText('Мой аккаунт')).toBeVisible()
  })

  it('shows the uploaded photo instead of the initials on the avatar and in the menu', () => {
    render(
      <UserMenu
        user={{ name: 'Анна', lastName: 'Иванова', email: 'anna@example.ru', image: AVATAR }}
      />,
    )
    const trigger = screen.getByRole('button', { name: 'Меню пользователя' })

    expect(trigger.querySelector('img')).toHaveAttribute('src', AVATAR)
    expect(trigger).not.toHaveTextContent('АИ')
    fireEvent.click(trigger)
    expect(screen.getByRole('menu').querySelector('img')).toHaveAttribute('src', AVATAR)
  })

  it('leads to the chats and the page of tariffs on the landing', () => {
    render(<UserMenu landing user={{ name: 'Анна', email: 'anna@example.ru' }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Меню пользователя' }))

    expect(
      within(screen.getByRole('menu'))
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Чаты', ...ITEMS])
    expect(screen.getByRole('menuitem', { name: 'Посмотреть тарифы' })).toHaveAttribute(
      'href',
      '/settings/plans',
    )
  })
})
