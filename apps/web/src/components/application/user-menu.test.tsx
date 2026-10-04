// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { UserMenu } from './user-menu'

vi.mock('@/app/(protected)/app/actions', () => ({ signOut: vi.fn() }))
vi.mock('@/lib/hard-navigate', () => ({ hardNavigate: vi.fn() }))

describe('shared account menu', () => {
  it.each(['toolbar', 'sidebar'] as const)(
    'offers projects before profile from the %s avatar without extra trigger content',
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
      expect(items.map((item) => item.textContent)).toEqual([
        'Проекты',
        'Профиль',
        'Настройки',
        'Выход',
      ])
      expect(items[0]).toHaveAttribute('href', '/projects')
      expect(items[1]).toHaveAttribute('href', '/profile')
      expect(items[2]).toHaveAttribute('href', '/settings')
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
    expect(items.map((item) => item.textContent)).toEqual([
      'Проекты',
      'Профиль',
      'Настройки',
      'Выход',
    ])
    expect(items.map((item) => item.getAttribute('href'))).toEqual([
      '/projects',
      '/profile',
      '/settings',
      null,
    ])
  })

  it('names an account without a name in the sidebar block', () => {
    render(<UserMenu placement="panel" user={{ name: ' ', email: 'anna@example.ru' }} />)

    const trigger = screen.getByRole('button', {
      name: 'Меню пользователя: Мой аккаунт, anna@example.ru',
    })
    expect(within(trigger).getByText('Мой аккаунт')).toBeVisible()
  })
})
